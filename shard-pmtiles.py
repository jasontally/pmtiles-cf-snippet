#!/usr/bin/env python3
"""Split a PMTiles archive into Cloudflare Static Asset files.

Workers Static Assets do not answer HTTP Range requests. A reader must fetch a
whole asset and cut out the bytes it needs. Therefore the part size decides how
much work a reader does, and the parts are cut by archive section, not evenly.

Sections, using the layout of the Protomaps basemap 20241021:

    head.bin          bytes [0, 16384)                 1 file,   16 KiB
    tile/NNNNNN.bin   bytes [16384, 126450545781)  63226 files,  2,000,000 B each
    meta.bin          bytes [126450545781, +1160)      1 file,    1,160 B
    leaf/NNNNNN.bin   bytes [126450546941, EOF)      2031 files,  160,000 B each

The tile section holds 99.99 % of all reader requests, so it decides both the
file count and the reader cost. See pmtiles-shard-spec.md section 5.

Ceiling: the part sizes are build time constants. A reader cannot change them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
from pathlib import Path

HEADER_SIZE = 127
# The specification requires the root directory to end inside the first 16 KiB,
# and the Protomaps client reads exactly this many bytes for the header.
HEAD_BYTES = 16_384
# Cloudflare limit is 25 MiB per Static Asset file.
MAX_ASSET_BYTES = 25 * 1024 * 1024
# Largest single request measured from the real archive: a leaf directory.
LARGEST_CLIENT_REQUEST = 150_036

DEFAULT_TILE_SHARD = 2_000_000
DEFAULT_LEAF_SHARD = 160_000

COMPRESSION = {0: "unknown", 1: "none", 2: "gzip", 3: "brotli", 4: "zstd"}
TILE_TYPE = {
    0: "other", 1: "mvt", 2: "png", 3: "jpeg",
    4: "webp", 5: "avif", 6: "maplibre",
}

SECTIONS = ("head", "tile", "meta", "leaf")


def read_header(path: Path) -> dict:
    """Read the 127 byte PMTiles v3 header."""
    with path.open("rb") as fh:
        raw = fh.read(HEADER_SIZE)

    if len(raw) < HEADER_SIZE:
        raise ValueError("file is shorter than the 127 byte PMTiles header")
    if raw[0:7] != b"PMTiles":
        raise ValueError(f"bad magic {raw[0:7]!r}, expected b'PMTiles'")
    if raw[7] != 3:
        raise ValueError(f"bad version {raw[7]}, only version 3 is supported")

    def u64(off: int) -> int:
        return struct.unpack_from("<Q", raw, off)[0]

    header = {
        "rootDirOffset": u64(8),
        "rootDirLength": u64(16),
        "metadataOffset": u64(24),
        "metadataLength": u64(32),
        "leafDirOffset": u64(40),
        "leafDirLength": u64(48),
        "tileDataOffset": u64(56),
        "tileDataLength": u64(64),
        "numAddressedTiles": u64(72),
        "numTileEntries": u64(80),
        "numTileContents": u64(88),
        "clustered": raw[96],
        "internalCompression": COMPRESSION.get(raw[97], raw[97]),
        "tileCompression": COMPRESSION.get(raw[98], raw[98]),
        "tileType": TILE_TYPE.get(raw[99], raw[99]),
        "minZoom": raw[100],
        "maxZoom": raw[101],
    }
    root_end = header["rootDirOffset"] + header["rootDirLength"]
    if root_end > HEAD_BYTES:
        raise ValueError(
            f"root directory ends at byte {root_end}, but the specification "
            f"requires it inside the first {HEAD_BYTES} bytes"
        )
    return header


def plan_sections(header: dict, total: int) -> list[dict]:
    """Return the archive sections in ascending offset order.

    Raises if the sections do not cover the file exactly. A gap means the
    archive was written by a tool with a layout this tool does not model, and
    a reader would then be unable to serve those bytes.
    """
    raw = {
        "head": (0, min(HEAD_BYTES, total)),
        "tile": (header["tileDataOffset"], header["tileDataLength"]),
        "meta": (header["metadataOffset"], header["metadataLength"]),
        "leaf": (header["leafDirOffset"], header["leafDirLength"]),
    }
    sections = []
    for kind in SECTIONS:
        start, length = raw[kind]
        if length <= 0:
            continue
        # head starts at 0 by definition, so only the other sections can
        # collide with it.
        if kind != "head" and start < raw["head"][1]:
            raise ValueError(
                f"section {kind} starts at {start}, inside the header area "
                f"that ends at {raw['head'][1]}"
            )
        sections.append({"kind": kind, "start": start, "length": length,
                         "end": start + length})

    cursor = 0
    for section in sections:
        if section["start"] != cursor:
            raise ValueError(
                f"section {section['kind']} starts at {section['start']}, "
                f"but the previous section ends at {cursor}. "
                f"Bytes {cursor} to {section['start']} are not in any section."
            )
        cursor = section["end"]
    if cursor != total:
        raise ValueError(
            f"sections end at {cursor} but the file is {total} bytes. "
            f"Bytes {cursor} to {total} are not in any section."
        )
    return sections


def count_parts(length: int, shard: int) -> int:
    return max(1, (length + shard - 1) // shard)


def plan_request(start: int, end: int, layout: list[dict]) -> list[tuple[str, int, int]]:
    """Map the client range start..end onto asset reads.

    Returns a list of (kind, index, offset_in_part, length) tuples in order.
    index is 0 for the single head.bin and meta.bin files, else the part number.
    """
    if end < start:
        return []
    plan: list[tuple[str, int, int, int]] = []
    for section in layout:
        if end < section["start"] or start >= section["end"]:
            continue
        lo = max(start, section["start"]) - section["start"]
        hi = min(end, section["end"] - 1) - section["start"]
        if section["kind"] in ("head", "meta"):
            plan.append((section["kind"], 0, lo, hi - lo + 1))
            continue
        shard = section["shard"]
        first, last = lo // shard, hi // shard
        for index in range(first, last + 1):
            part_start = index * shard
            a = max(lo, part_start) - part_start
            b = min(hi, part_start + shard - 1) - part_start
            plan.append((section["kind"], index, a, b - a + 1))
    return plan


def part_path(out_dir: Path, kind: str, index: int) -> Path:
    if kind == "head":
        return out_dir / "head.bin"
    if kind == "meta":
        return out_dir / "meta.bin"
    return out_dir / kind / f"{index:06d}.bin"


def build_layout(header: dict, total: int, tile_shard: int, leaf_shard: int) -> list[dict]:
    sections = plan_sections(header, total)
    for section in sections:
        if section["kind"] == "tile":
            section["shard"] = tile_shard
        elif section["kind"] == "leaf":
            section["shard"] = leaf_shard
    return sections


def split_archive(src: Path, out_dir: Path, layout: list[dict], force: bool) -> dict:
    """Write every part file. Returns per-section file counts and bytes."""
    stats: dict[str, dict] = {}
    total = layout[-1]["end"]

    with src.open("rb") as fh:
        for section in layout:
            kind = section["kind"]
            shard = section.get("shard")
            count = 1 if shard is None else count_parts(section["length"], shard)
            section["count"] = count
            if shard is not None:
                section["shardSize"] = shard

            written = 0
            reused = 0
            for index in range(count):
                part_start = section["start"] + index * (shard or section["length"])
                want = min(shard, section["end"] - part_start) if shard else section["length"]
                target = part_path(out_dir, kind, index)

                # Skip the write when the file on disk is already the right
                # length. Re-splitting 118 GiB to produce identical bytes wastes
                # 118 GiB of disk writes. Cloudflare compares content hashes
                # again at upload time, so this only saves local IO.
                if not force and target.exists() and target.stat().st_size == want:
                    reused += 1
                    written += want
                    fh.seek(want, os.SEEK_CUR)
                    continue

                target.parent.mkdir(parents=True, exist_ok=True)
                remaining = want
                tmp = target.with_suffix(".tmp")
                with tmp.open("wb") as out:
                    while remaining:
                        chunk = fh.read(min(remaining, 1 << 20))
                        if not chunk:
                            break
                        out.write(chunk)
                        remaining -= len(chunk)
                    written += want - remaining
                tmp.replace(target)
            if written != section["length"]:
                raise IOError(
                    f"section {kind}: wrote {written} bytes, expected {section['length']}"
                )
            stats[kind] = {"count": count, "bytes": written, "reused": reused}

    if layout[-1]["end"] != total:
        raise IOError("layout does not reach the end of the file")
    return stats


def write_headers(out_dir: Path) -> Path:
    """Write the _headers file that keeps the parts in the edge cache.

    Without this file Cloudflare serves assets with "Cache-Control: public,
    max-age=0, must-revalidate", so the reader hits the asset store on every
    tile request.
    """
    path = out_dir / "_headers"
    path.write_text(
        "/s/*\n"
        "\tCache-Control: public, max-age=31536000, immutable\n"
        "\tAccess-Control-Allow-Origin: *\n"
        "\tAccess-Control-Expose-Headers: Content-Length\n"
    )
    return path


def verify_archive(src: Path, out_dir: Path, layout: list[dict]) -> list[str]:
    """Check that the parts on disk reproduce the archive byte for byte.

    Reads every part and compares it with the same bytes of the source. This is
    the check to run in CI after a split. It costs one full read of both trees.
    """
    problems: list[str] = []
    with src.open("rb") as fh:
        for section in layout:
            shard = section.get("shard")
            count = section["count"]
            for index in range(count):
                part_start = section["start"] + index * (shard or section["length"])
                want = (min(shard, section["end"] - part_start) if shard
                        else section["length"])
                path = part_path(out_dir, section["kind"], index)
                if not path.exists():
                    problems.append(f"missing {path.relative_to(out_dir)}")
                    fh.seek(want, os.SEEK_CUR)
                    continue
                with path.open("rb") as part:
                    offset = 0
                    while True:
                        chunk = part.read(1 << 20)
                        if not chunk:
                            break
                        if fh.read(len(chunk)) != chunk:
                            problems.append(
                                f"content mismatch in {path.relative_to(out_dir)} "
                                f"at offset {offset}"
                            )
                            break
                        offset += len(chunk)
                    if offset != want:
                        problems.append(
                            f"{path.relative_to(out_dir)}: {offset} bytes, "
                            f"expected {want}"
                        )
                    fh.seek(want - offset, os.SEEK_CUR)
    return problems


def verify_cmd(args) -> int:
    """Compare the parts in PUBLIC_DIR against the archive, byte for byte."""
    src = Path(args.archive)
    if not src.is_file():
        ap.error(f"{src} is not a file")
    name = args.name or src.stem
    total = src.stat().st_size
    header = read_header(src)
    layout = build_layout(header, total, args.tile_shard, args.leaf_shard)

    out_dir = Path(args.out) / "s" / name
    if not out_dir.is_dir():
        print(f"error: {out_dir} does not exist. Run a split first.", file=sys.stderr)
        return 1

    for section in layout:
        shard = section.get("shard")
        section["count"] = (1 if shard is None
                            else count_parts(section["length"], shard))

    problems = verify_archive(src, out_dir, layout)
    if problems:
        for message in problems[:20]:
            print(f"FAIL  {message}", file=sys.stderr)
        if len(problems) > 20:
            print(f"FAIL  ... and {len(problems) - 20} more", file=sys.stderr)
        return 1

    total_files = sum(s["count"] for s in layout)
    print(f"verified {total_files:,} part files against {total:,} archive bytes")
    print("PASS  every part matches the archive")
    return 0


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _demo_header() -> bytes:
    """A valid PMTiles v3 header for a small archive, for the self test."""
    h = bytearray(HEADER_SIZE)
    h[0:7] = b"PMTiles"
    h[7] = 3
    struct.pack_into("<Q", h, 8, 127)      # rootDirOffset
    struct.pack_into("<Q", h, 16, 100)     # rootDirLength
    struct.pack_into("<Q", h, 24, 5000)    # metadataOffset
    struct.pack_into("<Q", h, 32, 100)     # metadataLength
    struct.pack_into("<Q", h, 40, 5100)    # leafDirOffset
    struct.pack_into("<Q", h, 48, 100)     # leafDirLength
    struct.pack_into("<Q", h, 56, 227)     # tileDataOffset
    struct.pack_into("<Q", h, 64, 4000)    # tileDataLength
    h[96], h[97], h[98], h[99] = 1, 2, 2, 1
    h[100], h[101] = 0, 15
    return bytes(h)


def selftest() -> int:
    """Check section planning, part mapping and byte reconstruction."""
    import tempfile

    failures: list[str] = []

    def check(cond: bool, message: str) -> None:
        if not cond:
            failures.append(message)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "demo.pmtiles"
        # Layout: head 16384, tile 16384..16384+4,999,999, meta 1000, leaf 400,000
        tile_len = 4_999_999
        meta_off = HEAD_BYTES + tile_len
        meta_len = 1_000
        leaf_off = meta_off + meta_len
        leaf_len = 400_000
        total = leaf_off + leaf_len

        header = read_header(src.parent / "none") if False else _demo_header()
        raw = bytearray(header)
        struct.pack_into("<Q", raw, 24, meta_off)
        struct.pack_into("<Q", raw, 32, meta_len)
        struct.pack_into("<Q", raw, 40, leaf_off)
        struct.pack_into("<Q", raw, 48, leaf_len)
        struct.pack_into("<Q", raw, 56, HEAD_BYTES)
        struct.pack_into("<Q", raw, 64, tile_len)
        src.write_bytes(bytes(raw) + bytes(total - HEADER_SIZE))

        header = read_header(src)
        layout = build_layout(header, total, DEFAULT_TILE_SHARD, DEFAULT_LEAF_SHARD)
        out_dir = tmp / "public" / "s" / "demo"
        out_dir.mkdir(parents=True)
        split_archive(src, out_dir, layout, force=True)
        write_headers(tmp / "public")

        kinds = [s["kind"] for s in layout]
        check(kinds == ["head", "tile", "meta", "leaf"], f"section order {kinds}")
        counts = {s["kind"]: s["count"] for s in layout}
        check(counts["head"] == 1, f"head count {counts['head']}")
        check(counts["meta"] == 1, f"meta count {counts['meta']}")
        check(counts["tile"] == 3, f"tile count {counts['tile']}")
        check(counts["leaf"] == 3, f"leaf count {counts['leaf']}")

        # The client's first request must be one part.
        first = plan_request(0, HEAD_BYTES - 1, layout)
        check(first == [("head", 0, 0, HEAD_BYTES)], f"header plan {first}")

        # Reconstruct every kind of client request from the parts on disk.
        served = 0
        with src.open("rb") as fh:
            for section in layout:
                for index in range(min(section["count"], 40)):
                    part_start = section["start"] + index * (section.get("shard")
                                                             or section["length"])
                    size = min(section.get("shard") or section["length"],
                               section["end"] - part_start)
                    for start, end in ((part_start, part_start + size - 1),
                                       (part_start, min(part_start + 202, part_start + size) - 1),
                                       (part_start, min(part_start + LARGEST_CLIENT_REQUEST,
                                                        part_start + size) - 1)):
                        plan = plan_request(start, end, layout)
                        out = bytearray()
                        for kind, idx, off, length in plan:
                            data = part_path(out_dir, kind, idx).read_bytes()[off:off + length]
                            if len(data) != length:
                                failures.append(f"{kind}/{idx} short by {length - len(data)}")
                            out += data
                        fh.seek(start)
                        expected = fh.read(end - start + 1)
                        check(bytes(out) == expected,
                              f"content mismatch at {start}..{end} plan={plan}")
                        served += 1
                        check(len(plan) <= 2,
                              f"range {start}..{end} needs {len(plan)} subrequests, limit is 2")

        # A gap in the layout must be refused, not silently dropped.
        bad = dict(header)
        bad["tileDataLength"] = tile_len - 5
        try:
            plan_sections(bad, total)
            failures.append("a layout gap was not detected")
        except ValueError:
            pass

        # Every offset inside a part must map to exactly one part.
        for section in layout:
            shard = section.get("shard")
            if not shard:
                continue
            for index in (0, section["count"] - 1):
                # Clamp to the bytes this part really holds. The last part is
                # usually shorter than shard.
                part_start = section["start"] + index * shard
                span = min(shard, section["end"] - part_start)
                for delta in (0, span // 3, span - 1):
                    if not 0 <= delta < span:
                        continue
                    off = part_start + delta
                    plan = plan_request(off, off, layout)
                    check(len(plan) == 1, f"offset {off} mapped to {len(plan)} parts")

    for message in failures:
        print(f"FAIL  {message}", file=sys.stderr)
    if failures:
        print(f"\n{len(failures)} check(s) failed", file=sys.stderr)
        return 1
    print("PASS  section planning, part mapping and byte reconstruction")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("archive", nargs="?", help="input .pmtiles file")
    ap.add_argument("--out", default="public", help="asset directory (default: public)")
    ap.add_argument("--name", help="archive name (default: input file stem)")
    ap.add_argument("--tile-shard", type=int, default=DEFAULT_TILE_SHARD,
                    help=f"tile part size (default: {DEFAULT_TILE_SHARD})")
    ap.add_argument("--leaf-shard", type=int, default=DEFAULT_LEAF_SHARD,
                    help=f"leaf part size (default: {DEFAULT_LEAF_SHARD})")
    ap.add_argument("--force", action="store_true",
                    help="rewrite part files even when the size already matches")
    ap.add_argument("--verify", action="store_true",
                    help="compare the parts already in --out against the archive")
    ap.add_argument("--selftest", action="store_true",
                    help="run the section and mapping checks and exit")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if args.verify:
        if not args.archive:
            ap.error("--verify needs an archive path")
        return verify_cmd(args)
    if not args.archive:
        ap.error("give an archive path, or use --selftest or --verify")

    for label, value in (("--tile-shard", args.tile_shard), ("--leaf-shard", args.leaf_shard)):
        if not 0 < value <= MAX_ASSET_BYTES:
            ap.error(f"{label} must be between 1 and {MAX_ASSET_BYTES}")

    src = Path(args.archive)
    if not src.is_file():
        ap.error(f"{src} is not a file")
    name = args.name or src.stem
    total = src.stat().st_size

    header = read_header(src)
    layout = build_layout(header, total, args.tile_shard, args.leaf_shard)

    if args.leaf_shard <= LARGEST_CLIENT_REQUEST:
        print(
            f"warning: --leaf-shard {args.leaf_shard} is not above "
            f"{LARGEST_CLIENT_REQUEST}. A leaf directory request may then read "
            "more than 2 parts and exceed the Pro subrequest limit.",
            file=sys.stderr,
        )

    out_root = Path(args.out)
    out_dir = out_root / "s" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = split_archive(src, out_dir, layout, force=args.force)
    headers_path = write_headers(out_root)

    files = sum(s["count"] for s in layout)
    reused = sum(s["reused"] for s in stats.values())
    digest = file_digest(src)[:16]

    manifest = {
        "format": 2,
        "total": total,
        "digest": digest,
        "sections": [
            {k: v for k, v in s.items() if k != "end"} for s in layout
        ],
        "files": files,
        "header": header,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"archive     {total:,} bytes")
    for s in layout:
        shard = s.get("shardSize")
        print(
            f"  {s['kind']:<5} {s['length']:>15,} bytes  -> {s['count']:>6,} files"
            + (f"  of {shard:,}" if shard else "  (single file)")
        )
    print(f"total files {files:,}  (Worker limit 100,000, spare {100_000 - files:,})")
    print(f"reused      {reused:,} part files already present with the right size")
    print(f"headers     {headers_path}")
    print(f"manifest    {manifest_path}")
    print()
    print("Copy into snippet.js ARCHIVES:")
    print(f"  {name}: {{ total: {total}, headEnd: {layout[0]['end']}, "
          f"tileOffset: {layout[1]['start']}, metaOffset: {layout[2]['start']}, "
          f"leafOffset: {layout[3]['start']}, tileShard: {args.tile_shard}, "
          f"leafShard: {args.leaf_shard} }},")
    return 0


if __name__ == "__main__":
    sys.exit(main())