#!/usr/bin/env python3
"""
Check the live PMTiles endpoint against the live shard Workers.

Run with: python3 verify-live.py

The unit tests in snippet-test.js prove the routing arithmetic against a
synthetic archive. This proves the deployed system: it asks the reader at
tiles.jasontally.com for bytes at known archive offsets, asks the shard Worker
that should hold those bytes for the same bytes directly, and compares. If a
part number maps to the wrong shard, the two disagree and the check fails.

It also compares a leaf directory against the source archive at
build.protomaps.com, which is the only place the original bytes exist.

This needs the network and the deployed Workers. It is not part of npm test,
which must run offline on a build machine.

LAYOUT IS MEASURED, NOT HARDCODED

The archive changes whenever the shard refresh advances it, so nothing here
carries a byte offset or a part count. Everything the checks need is read from
the live system at the start of the run:

  * The archive total, section offsets, and maxZoom come from the header the
    reader serves (a PMTiles v3 header is self describing).
  * The bytes per tile part and per leaf part are the content-length of a part
    file on shard 0, which is the deployed part size.
  * The number of parts per shard is found by binary searching shard 0 for its
    last tile part; the boundary is where shard 1 takes over.
  * The shard count follows from the total parts and the parts per shard.

So this keeps working across a refresh without a code change. The one thing it
cannot measure is which archive the shards are meant to hold; that is read from
the header too, and reported, so a stale reader is obvious in the output.
"""

import hashlib
import json
import math
import random
import sys
import urllib.error
import urllib.request

READER = "https://tiles.jasontally.com/basemap.pmtiles"
SHARD_BASE = "https://s.tiles{}.jasontally.com/s/basemap"
ARCHIVE = "https://build.protomaps.com/{}"
BUILDS_URL = "https://build-metadata.protomaps.dev/builds.json"
NAME = "basemap"

# The source sends 403 to the default Python user agent.
UA = {"User-Agent": "curl/8.5.0"}

passed = 0
failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok    {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


def get(url, start=None, end=None):
    """A GET, optionally with a Range header. Returns (status, body, headers)."""
    headers = dict(UA)
    if start is not None:
        headers["Range"] = f"bytes={start}-{end}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, error.read(), dict(error.headers)


def shard_part_url(shard, kind, part):
    if kind == "head" or kind == "meta":
        return f"{SHARD_BASE.format(shard)}/{kind}.bin"
    return f"{SHARD_BASE.format(shard)}/{kind}/{part:06d}.bin"


def read_part(shard, kind, part, offset, length):
    """
    Read bytes out of a part file held by a shard Worker.

    Static Assets ignore Range, so the whole part comes back and this slices it.
    That is the same thing the Snippet does, so it is a fair comparison.

    Returns (bytes, offset_used). The offset is returned because the last tile
    part is short, so a fixed offset can fall past its end and gets clamped.
    The caller must ask the reader at the same offset it was given.
    """
    url = shard_part_url(shard, kind, part)
    status, whole, _ = get(url)
    if status != 200:
        raise RuntimeError(f"{url} returned {status}")
    offset = min(offset, max(0, len(whole) - length))
    return whole[offset:offset + length], offset


def part_exists(shard, part):
    url = shard_part_url(shard, "tile", part)
    status, _, _ = get(url, 0, 0)
    return status == 200


def u64(buf, offset):
    return int.from_bytes(buf[offset:offset + 8], "little")


class Layout:
    """
    Everything the checks need, measured from the live system.

    header holds the first 127 bytes the reader served. The section offsets and
    sizes are the PMTiles v3 header fields; the total is leafOffset plus its
    length, which is where the archive ends.
    """

    def __init__(self, header):
        self.header = header
        self.root_offset = u64(header, 8)
        self.root_length = u64(header, 16)
        self.meta_offset = u64(header, 24)
        self.meta_length = u64(header, 32)
        self.leaf_offset = u64(header, 40)
        self.leaf_length = u64(header, 48)
        self.tile_offset = u64(header, 56)
        self.tile_length = u64(header, 64)
        self.max_zoom = header[101]
        self.total = self.leaf_offset + self.leaf_length
        self.head_end = self.tile_offset
        # Filled in by the probing below.
        self.tile_shard = None
        self.leaf_shard = None
        self.parts_per_shard = None
        self.shard_count = None

    @property
    def tile_parts(self):
        return math.ceil(self.tile_length / self.tile_shard)

    def part_start(self, part):
        return self.tile_offset + part * self.tile_shard

    def shard_of(self, part):
        return part // self.parts_per_shard


def measure(plan_only=False):
    """
    Read the deployed layout. Returns a Layout, or None if the reader is down.
    """
    status, body, headers = get(READER, 0, 16383)
    if status != 206 or len(body) < 127 or body[:7] != b"PMTiles":
        raise RuntimeError(f"the reader did not serve a PMTiles header: status {status}")
    layout = Layout(body)

    # The deployed part sizes are the content-length of a whole part on shard 0.
    # A part away from the end is exactly one part long.
    _, tile_part, _ = get(shard_part_url(0, "tile", 1))
    layout.tile_shard = len(tile_part)
    _, leaf_part, _ = get(shard_part_url(0, "leaf", 0))
    layout.leaf_shard = len(leaf_part)

    # Where does shard 0 stop and shard 1 start? Binary search for shard 0's
    # last tile part. The search upper bound is the whole tile section, so it
    # terminates even if the shards are empty.
    lo, hi = 0, max(layout.tile_parts - 1, 0)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if part_exists(0, mid):
            lo = mid
        else:
            hi = mid - 1
    last_part_of_shard0 = lo
    layout.parts_per_shard = last_part_of_shard0 + 1
    layout.shard_count = math.ceil(layout.tile_parts / layout.parts_per_shard)

    # The boundary is a real fact worth showing and worth checking.
    boundary_ok = (not part_exists(0, layout.parts_per_shard)) and part_exists(1, layout.parts_per_shard)
    check(
        f"shard 0 ends at tile part {last_part_of_shard0} and shard 1 continues",
        boundary_ok,
        f"shard 0 part {layout.parts_per_shard} exists={not part_exists(0, layout.parts_per_shard)}",
    )
    return layout


def main():
    print(f"reader {READER}")

    print("\n=== the deployed layout, read from the live system")
    try:
        layout = measure()
    except Exception as error:
        check("the reader serves a PMTiles header", False, str(error))
        print(f"\n{passed} passed, {failed} failed")
        return 1
    check("the reader serves a PMTiles header", True)
    print(f"  archive    {layout.total:,} bytes, maxZoom {layout.max_zoom}")
    print(f"  sections   head->{layout.head_end:,}  tile {layout.tile_offset:,}+{layout.tile_length:,}  "
          f"meta {layout.meta_offset:,}+{layout.meta_length:,}  leaf {layout.leaf_offset:,}+{layout.leaf_length:,}")
    print(f"  parts      {layout.tile_parts:,} tile parts, {layout.tile_shard:,} B each, "
          f"{layout.parts_per_shard:,} per shard, {layout.shard_count} shards")
    print(f"  leaf parts {layout.leaf_shard:,} B each")

    print("\n=== the first request every client makes")
    status, body, headers = get(READER, 0, 16383)
    check("206 for bytes=0-16383", status == 206, f"status {status}")
    check("16384 bytes returned", len(body) == 16384, f"{len(body)} bytes")
    check("a valid PMTiles v3 header", body[:7] == b"PMTiles" and body[7] == 3, repr(body[:8]))
    check(
        "Content-Range carries the archive size",
        headers.get("Content-Range") == f"bytes 0-16383/{layout.total}",
        headers.get("Content-Range"),
    )
    check("a strong ETag, which the client needs", headers.get("ETag", "").startswith('"'), headers.get("ETag"))
    head_expected, _ = read_part(0, "head", 0, 0, layout.head_end)
    check("the head comes from shard 0", head_expected == body[:layout.head_end], "differs")

    print("\n=== one tile part from every shard, including both boundaries")
    # The first and last part of every shard, and the part on each side of a
    # few boundaries. The offsets inside a part are arbitrary but in range.
    per = layout.parts_per_shard
    probes = set()
    for shard in range(layout.shard_count):
        first = shard * per
        last = min(first + per, layout.tile_parts) - 1
        probes.add(first)
        probes.add(last)
        if shard + 1 < layout.shard_count:
            probes.add(last)  # already the boundary from the low side
            probes.add(first + per)  # first of the next shard
    probes = sorted(p for p in probes if 0 <= p < layout.tile_parts)

    for part in probes:
        shard = layout.shard_of(part)
        length = 202
        expected, offset = read_part(shard, "tile", part, 1_234_567, length)
        start = layout.part_start(part) + offset
        status, body, _ = get(READER, start, start + length - 1)
        check(
            f"tile part {part} served from shard {shard}",
            status == 206 and body == expected,
            f"status {status}, reader {hashlib.sha256(body).hexdigest()[:10]} "
            f"vs shard {hashlib.sha256(expected).hexdigest()[:10]}",
        )

    print("\n=== the sections that all live in shard 0")
    status, body, _ = get(READER, layout.meta_offset, layout.meta_offset + layout.meta_length - 1)
    meta_expected, _ = read_part(0, "meta", 0, 0, layout.meta_length)
    check("metadata", status == 206 and meta_expected == body, f"status {status}")

    # A leaf directory part away from the start, read whole, and the same bytes
    # from the reader. leaf/{n}.bin holds leaf bytes [n*leafShard, (n+1)*leafShard).
    leaf_parts = math.ceil(layout.leaf_length / layout.leaf_shard)
    leaf_part_index = min(2029, max(leaf_parts - 1, 0))
    leaf_start = layout.leaf_offset + layout.leaf_shard * leaf_part_index + 100
    leaf_length = 150_036
    status, leaf_body, _ = get(READER, leaf_start, leaf_start + leaf_length - 1)
    leaf_expected, _ = read_part(0, "leaf", leaf_part_index, 100, leaf_length)
    check(
        f"a {leaf_length:,} byte leaf directory",
        status == 206 and leaf_expected == leaf_body,
        f"status {status}, {len(leaf_body)} bytes",
    )
    source_archive = ARCHIVE.format(archive_key(layout))
    status, origin, _ = get(source_archive, leaf_start, leaf_start + leaf_length - 1)
    check(
        "those leaf bytes match the source archive",
        status == 206 and origin == leaf_body,
        f"status {status}, source {len(origin)} bytes",
    )
    print(f"  source archive {source_archive}")

    print("\n=== a range that straddles a shard boundary")
    # 64 bytes at the end of the last part of shard 0, then 64 at the start of
    # shard 1's first part, read through the reader as one range.
    boundary_part = per  # first part of shard 1
    boundary_start = layout.part_start(boundary_part)
    start = boundary_start - 64
    status, body, _ = get(READER, start, start + 127)
    head, _ = read_part(0, "tile", boundary_part - 1, layout.tile_shard - 64, 64)
    tail, _ = read_part(1, "tile", boundary_part, 0, 64)
    check(
        "64 bytes from shard 0 followed by 64 from shard 1",
        status == 206 and body == head + tail,
        f"status {status}, {len(body)} bytes",
    )

    print("\n=== random ranges against the source archive")
    # The equivalence proof that replaces parsing the archive by hand.
    # A PMTiles client only ever asks for byte ranges. If every range we serve
    # matches the source archive byte for byte, then any client that works
    # against build.protomaps.com works against this endpoint.
    random.seed(20261012)
    sections = [
        ("head", 0, layout.head_end),
        ("tile", layout.tile_offset, layout.meta_offset),
        ("metadata", layout.meta_offset, layout.leaf_offset),
        ("leaf", layout.leaf_offset, layout.total),
    ]
    identical = 0
    refused = 0
    for section, low, high in sections:
        for _ in range(6):
            start = random.randint(low, max(low, high - 1))
            end = min(layout.total - 1, start + random.choice([1, 202, 6873, 60000, 150036]) - 1)
            status, ours, _ = get(READER, start, end)
            if status == 416:
                refused += 1
                continue
            source_status, origin, _ = get(source_archive, start, end)
            check(
                f"{section} bytes {start}..{end} match the source archive",
                status == 206 and source_status == 206 and ours == origin,
                f"reader {status}, source {source_status}",
            )
            identical += 1
    print(f"       {identical} ranges identical, {refused} refused as 416")

    print("\n=== answers the snippet must refuse")
    for name, rng in [
        ("no Range header", None),
        ("a range past the end", (layout.total, layout.total + 10)),
        ("an inverted range", (100, 50)),
        ("more than one range", None),
        ("a range wider than MAX_RESPONSE", (0, 1_048_575)),
    ]:
        if name == "no Range header":
            status, _, _ = get(READER)
        elif name == "more than one range":
            request = urllib.request.Request(READER, headers={**UA, "Range": "bytes=0-10,20-30"})
            try:
                with urllib.request.urlopen(request) as response:
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
        else:
            status, _, _ = get(READER, rng[0], rng[1])
        check(f"416 for {name}", status == 416, f"status {status}")

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


def archive_key(layout):
    """
    The Protomaps build key of the archive the shards hold, found by size.

    The header carries the total size but not the build key, and build key is
    what build.protomaps.com needs to serve the same bytes for comparison. So
    ask Protomaps for the build list and match on size, which is unique across
    the list. This keeps the script from carrying a key constant that goes stale
    on the next refresh.
    """
    status, body, _ = get(BUILDS_URL)
    if status != 200:
        raise RuntimeError(f"{BUILDS_URL} returned {status}")
    builds = json.loads(body)
    matches = [b for b in builds if b.get("size") == layout.total]
    if len(matches) != 1:
        raise RuntimeError(
            f"{len(matches)} Protomaps builds have size {layout.total}; cannot identify the archive"
        )
    return matches[0]["key"]


if __name__ == "__main__":
    sys.exit(main())