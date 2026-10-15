import assert from "node:assert/strict";

const module = await import("./preload-snippet.js");
const bucket = module.bucket;
const bucketFile = module.bucketFile;

assert.equal(bucket(48.85, 2.35), "40:0", "bucket uses floor");
assert.equal(bucket(NaN, 0), null, "invalid lat rejected");
assert.equal(bucket(0, 200), null, "invalid lon rejected");
assert.equal(bucketFile(48.85, 2.35), "/preload/40%3A0.json", "bucket file path");
assert.equal(bucketFile(NaN, 0), null, "no file for invalid coords");

console.log("preload snippet smoke tests passed");
