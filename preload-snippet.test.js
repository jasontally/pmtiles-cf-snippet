import assert from "node:assert/strict";

const module = await import("./preload-snippet.js");
const bucket = module.bucket;
const bucketFile = module.bucketFile;
const parseTable = module.parseTable;

assert.equal(bucket(48.85, 2.35), "16_11", "Paris lands on its zoom-five tile");
assert.equal(bucket(28.2, -80.68), "8_13", "Miami lands on its zoom-five tile");
assert.equal(bucket(-33.86, 151.21), "29_19", "Sydney lands south of the equator");
assert.equal(bucket(90, 0), "16_0", "the pole clamps to the top row");
assert.equal(bucket(-90, 0), "16_31", "the south pole clamps to the bottom row");
assert.equal(bucket(NaN, 0), null, "invalid lat rejected");
assert.equal(bucket(0, 200), null, "invalid lon rejected");
assert.equal(bucketFile(48.85, 2.35), "/preload/16_11.json", "bucket file path");
assert.equal(bucketFile(NaN, 0), null, "no file for invalid coords");

const parsed = parseTable("5059;8_13:12;16_11:6,12");
assert.equal(parsed.partsPerShard, 5059, "the first chunk is the parts per shard");
assert.deepEqual(parsed.buckets.get("8_13"), [12], "parts split on commas");
assert.deepEqual(parsed.buckets.get("16_11"), [6, 12], "a later entry parses");
assert.equal(parsed.buckets.size, 2, "no extra entries");

const empty = parseTable("__PRELOAD_TABLE__");
assert.equal(empty.partsPerShard, 0, "the marker yields no parts per shard");
assert.equal(empty.buckets.size, 0, "the marker yields no buckets");

console.log("preload snippet smoke tests passed");
