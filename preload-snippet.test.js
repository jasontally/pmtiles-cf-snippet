import assert from "node:assert/strict";

const module = await import("./preload-snippet.js");
const bucket = module.bucket;
const bucketFile = module.bucketFile;
const parseTable = module.parseTable;

assert.equal(bucket(48.85, 2.35), "40_0", "bucket uses floor");
assert.equal(bucket(NaN, 0), null, "invalid lat rejected");
assert.equal(bucket(0, 200), null, "invalid lon rejected");
assert.equal(bucketFile(48.85, 2.35), "/preload/40_0.json", "bucket file path");
assert.equal(bucketFile(NaN, 0), null, "no file for invalid coords");

const parsed = parseTable("5059;20_-90:6,7,8;40_0:6,12");
assert.equal(parsed.partsPerShard, 5059, "the first chunk is the parts per shard");
assert.deepEqual(parsed.buckets.get("20_-90"), [6, 7, 8], "parts split on commas");
assert.deepEqual(parsed.buckets.get("40_0"), [6, 12], "a later entry parses");
assert.equal(parsed.buckets.size, 2, "no extra entries");

const empty = parseTable("__PRELOAD_TABLE__");
assert.equal(empty.partsPerShard, 0, "the marker yields no parts per shard");
assert.equal(empty.buckets.size, 0, "the marker yields no buckets");

console.log("preload snippet smoke tests passed");
