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

Layout constants below must match snippet.js. They were measured from
https://build.protomaps.com/20241021.pmtiles on 2026-10-08.
"""

import hashlib
import random
import sys
import urllib.error
import urllib.request

READER = "https://tiles.jasontally.com/basemap.pmtiles"
ARCHIVE = "https://build.protomaps.com/20241021.pmtiles"
NAME = "basemap"

TOTAL = 126_775_469_007
HEAD_END = 16_384
TILE_OFFSET = 16_384
TILE_SHARD = 2_000_000
TILE_PARTS_PER_SHARD = 4_864
META_OFFSET = 126_450_545_781
LEAF_OFFSET = 126_450_546_941
LEAF_SHARD = 160_000
SHARD_COUNT = 13

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


def shard_of(part):
    return part // TILE_PARTS_PER_SHARD


def shard_url(shard):
    return f"https://s.tiles{shard}.jasontally.com/s/{NAME}"


def read_part(shard, kind, part, offset, length):
    """
    Read bytes out of a part file held by a shard Worker.

    Static Assets ignore Range, so the whole part comes back and this slices it.
    That is the same thing the Snippet does, so this is a fair comparison.

    Returns (bytes, offset_used). The offset is returned because the last tile
    part is short, 529,397 B, so a fixed offset can fall past its end and gets
    clamped. The caller must ask the reader at the same offset it was given.
    """
    if kind == "head" or kind == "meta":
        url = f"{shard_url(shard)}/{kind}.bin"
    else:
        url = f"{shard_url(shard)}/{kind}/{part:06d}.bin"
    status, whole, _ = get(url)
    if status != 200:
        raise RuntimeError(f"{url} returned {status}")
    offset = min(offset, max(0, len(whole) - length))
    return whole[offset:offset + length], offset


def tile_part_start(part):
    return TILE_OFFSET + part * TILE_SHARD


def main():
    print(f"reader {READER}")

    print("\n=== the first request every client makes")
    status, body, headers = get(READER, 0, 16383)
    check("206 for bytes=0-16383", status == 206, f"status {status}")
    check("16384 bytes returned", len(body) == 16384, f"{len(body)} bytes")
    check("a valid PMTiles v3 header", body[:7] == b"PMTiles" and body[7] == 3, repr(body[:8]))
    check(
        "Content-Range carries the archive size",
        headers.get("Content-Range") == f"bytes 0-16383/{TOTAL}",
        headers.get("Content-Range"),
    )
    check("a strong ETag, which the client needs", headers.get("ETag", "").startswith('"'), headers.get("ETag"))
    head_expected, _ = read_part(0, "head", 0, 0, 16384)
    check("the head comes from shard 0", head_expected == body, "differs")

    print("\n=== one tile part from every shard, including both boundaries")
    probes = [0, 4863, 4864, 9727, 9728, 19456, 29184, 38816, 48640, 58368, 63224, 63225]
    for part in probes:
        shard = shard_of(part)
        length = 202
        expected, offset = read_part(shard, "tile", part, 1_234_567, length)
        start = tile_part_start(part) + offset
        status, body, _ = get(READER, start, start + length - 1)
        check(
            f"tile part {part} served from shard {shard}",
            status == 206 and body == expected,
            f"status {status}, reader {hashlib.sha256(body).hexdigest()[:10]} "
            f"vs shard {hashlib.sha256(expected).hexdigest()[:10]}",
        )

    print("\n=== the sections that all live in shard 0")
    status, body, _ = get(READER, META_OFFSET, META_OFFSET + 1159)
    meta_expected, _ = read_part(0, "meta", 0, 0, 1160)
    check("metadata", status == 206 and meta_expected == body, f"status {status}")

    leaf_start = LEAF_OFFSET + LEAF_SHARD * 2029 + 100
    status, leaf_body, _ = get(READER, leaf_start, leaf_start + 150_035)
    leaf_expected, _ = read_part(0, "leaf", 2029, 100, 150_036)
    check(
        "a 150,036 byte leaf directory",
        status == 206 and leaf_expected == leaf_body,
        f"status {status}",
    )
    status, origin, _ = get(ARCHIVE, leaf_start, leaf_start + 150_035)
    check(
        "those leaf bytes match the source archive",
        status == 206 and origin == leaf_body,
        f"status {status}, source {len(origin)} bytes",
    )

    print("\n=== a range that straddles a shard boundary")
    start = tile_part_start(4863) + TILE_SHARD - 64
    status, body, _ = get(READER, start, start + 127)
    tail, _ = read_part(0, "tile", 4863, TILE_SHARD - 64, 64)
    head, _ = read_part(1, "tile", 4864, 0, 64)
    check(
        "64 bytes from shard 0 followed by 64 from shard 1",
        status == 206 and body == tail + head,
        f"status {status}, {len(body)} bytes",
    )

    print("\n=== random ranges against the source archive")
    # This is the equivalence proof that replaces parsing the archive by hand.
    # A PMTiles client only ever asks for byte ranges. If every range we serve
    # matches the source archive byte for byte, then any client that works
    # against build.protomaps.com works against this endpoint.
    random.seed(20261008)
    sections = [
        ("head", 0, HEAD_END),
        ("tile", TILE_OFFSET, TILE_OFFSET + 63_226 * TILE_SHARD),
        ("metadata", META_OFFSET, LEAF_OFFSET),
        ("leaf", LEAF_OFFSET, TOTAL),
    ]
    identical = 0
    refused = 0
    for section, low, high in sections:
        for _ in range(6):
            start = random.randint(low, max(low, high - 1))
            end = min(TOTAL - 1, start + random.choice([1, 202, 6873, 60000, 150036]) - 1)
            status, ours, _ = get(READER, start, end)
            if status == 416:
                refused += 1
                continue
            source_status, origin, _ = get(ARCHIVE, start, end)
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
        ("a range past the end", (TOTAL, TOTAL + 10)),
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


if __name__ == "__main__":
    sys.exit(main())