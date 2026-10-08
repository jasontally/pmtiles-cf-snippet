/**
 * Tests for the minifier in build.mjs. Run with: node minify-test.js
 *
 * A broken minifier would corrupt the snippet and deploy it. These checks make
 * sure the minified code still parses and behaves the same.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { minify } from "./build.mjs";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

// Removing the space around "=" is correct: JavaScript does not need it, and
// keeping it would waste bytes. The tests below check the output parses and runs,
// not that it matches a particular spacing choice.
check("strips line comments", () => {
  const out = minify("const a = 1; // this is a note\nconst b = 2;");
  assert.ok(!out.includes("this is a note"), out);
  assert.ok(!out.includes("//"), out);
  assert.ok(out.includes("const a=1;"), out);
  assert.ok(out.includes("const b=2;"), out);
});

check("strips block comments", () => {
  const out = minify("/* header\n * more\n */\nconst a = 1;");
  assert.ok(!out.includes("header"), out);
  assert.ok(!out.includes("more"), out);
  assert.ok(!out.includes("/*"), out);
  assert.ok(out.includes("const a=1;"), out);
});

check("keeps // inside a string literal", () => {
  const out = minify('const url = "https://example.com/x";');
  assert.ok(out.includes('"https://example.com/x"'), out);
});

check("keeps /* inside a string literal", () => {
  const out = minify('const s = "/* not a comment */";');
  assert.ok(out.includes('"/* not a comment */"'), out);
});

check("keeps escaped quotes intact", () => {
  const out = minify('const s = "he said \\"hi\\" // ok";');
  assert.ok(out.includes('\\"hi\\"'), out);
  assert.ok(out.includes("// ok"), out);
});

check("keeps a backslash at the end of a string", () => {
  const out = minify('const s = "trailing\\\\";');
  assert.ok(out.includes('"trailing\\\\"'), out);
});

check("keeps template literals", () => {
  const out = minify("const s = `a ${b} c`;");
  assert.ok(out.includes("`a ${b} c`"), out);
});

check("collapses runs of whitespace", () => {
  assert.equal(minify("const   a    =    1;"), "const a=1;");
});

check("removes a space around punctuation", () => {
  assert.equal(minify("const a = 1 + 2 * 3;"), "const a=1+2*3;");
  assert.equal(minify("foo(a , b)"), "foo(a,b)");
});

check("keeps a space between two words", () => {
  assert.equal(minify("const   alpha   beta"), "const alpha beta");
  assert.equal(minify("return   value"), "return value");
  assert.equal(minify("new   Map"), "new Map");
});

check("keeps a keyword separate from its value", () => {
  assert.equal(minify("let   x = 1"), "let x=1");
  assert.equal(minify("typeof   foo"), "typeof foo");
});

checkAsync("keeps a space where two operators would merge", async () => {
  // Without the space these would become one token and change behaviour.
  const cases = [
    ["const a = 1; a++; a-- ; a + + b", "a++"],
    ["const x = typeof  y;", "typeof y"],
    ["const z = a in  b;", "a in b"],
    ["const w = a instanceof  B;", "a instanceof B"],
    ["const v = new  Date();", "new Date"],
  ];
  for (const [source, needle] of cases) {
    const out = minify(source);
    assert.ok(out.includes(needle), `${JSON.stringify(source)} -> ${JSON.stringify(out)} lost ${needle}`);
    // The output must parse.
    await import(`data:text/javascript;base64,${Buffer.from(
      `const b=1,c=2,B=class{};const A={};let y=0,z=0,w=0,v=0;${out}`
    ).toString("base64")}`);
  }
});

// Removing the space between two "+" would turn "a + +b" into "a++b", which is a
// syntax error. Same for "- -". These cases found a real bug in the minifier.
for (const [source, label] of [
  ["let a=1,b=2;const c=a + + b;", "a + + b"],
  ["let a=1,b=2;const c=a+ +b;", "a+ +b"],
  ["const x=1;const y=x - -x;", "x - -x"],
  ["const x=1;const y=x- -x;", "x- -x"],
  ["const x=1;const y=x - - x;", "x - - x"],
]) {
  check(`does not join operators that would merge: ${label}`, () => {
    const out = minify(source);
    assert.ok(!/(\+\+[^=]|-{2}[^=])/.test(out.replace(/\+\+;/g, "++;")),
      `merged in ${JSON.stringify(out)}`);
    assert.doesNotThrow(() => new Function(out), `syntax error in ${JSON.stringify(out)}`);
  });
}

checkAsync("a + +b still means two additions", async () => {
  const out = minify("let a=1,b=2;const c=a + + b;");
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(
      out.replace("const c=", "export default ")
    ).toString("base64")}`
  );
  assert.equal(module.default, 3, "a + + b must equal 3, not a++b");
});

checkAsync("x - -x still means x plus x", async () => {
  const out = minify("const x=1;const y=x - -x;");
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(
      out.replace("const y=", "export default ")
    ).toString("base64")}`
  );
  assert.equal(module.default, 2, "x - -x must equal 2, not x--x");
});

check("removes indentation", () => {
  const source = "function f() {\n    return 1;\n}";
  assert.ok(!minify(source).includes("\n"), JSON.stringify(minify(source)));
});

check("handles an empty comment only source", () => {
  assert.equal(minify("// nothing here"), "");
});

checkAsync("the real snippet still parses and exports fetch", async () => {
  const source = readFileSync(new URL("./snippet.js", import.meta.url), "utf8");
  const small = minify(source);
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(small).toString("base64")}`
  );
  assert.equal(typeof module.default, "object");
  assert.equal(typeof module.default.fetch, "function");
});

checkAsync("the minified snippet behaves like the source", async () => {
  const source = readFileSync(new URL("./snippet.js", import.meta.url), "utf8");
  // The test harness replaces this table with the test archive.
  const table = /const ARCHIVES = \{[\s\S]*?\n\};/;
  const stub = `const ARCHIVES = {\n  demo: { total: 300000, headEnd: 16384, tileOffset: 16384, metaOffset: 262144, leafOffset: 262144, tileShard: 65536, leafShard: 16384 },\n};`;
  const patched = source.replace(table, stub);

  const load = async (text) => import(
    `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`
  );

  const archives = {
    demo: {
      total: 300000, headEnd: 16384, tileOffset: 16384,
      metaOffset: 262144, leafOffset: 262144,
      tileShard: 65536, leafShard: 16384,
    },
  };

  // Bytes the fake asset store serves. Deliberately ignores Range.
  const bytes = new Uint8Array(300000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
  const parts = {
    "head.bin": bytes.subarray(0, 16384),
    "tile/000000.bin": bytes.subarray(16384, 16384 + 65536),
    "tile/000001.bin": bytes.subarray(16384 + 65536, 16384 + 131072),
    "meta.bin": bytes.subarray(262144, 262144),
  };

  const run = async (module, range) => {
    globalThis.fetch = async (target) => {
      const key = new URL(target).pathname.replace(/^\/s\/demo\//, "");
      const part = parts[key];
      if (!part) return new Response("missing", { status: 404 });
      return new Response(part, { status: 200 });
    };
    const response = await module.default.fetch(
      new Request("https://x.example/demo.pmtiles", {
        headers: range ? { Range: range } : {},
      }),
      { env: {} },
      { env: {} }
    );
    return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
  };

  const fromSource = await load(patched);
  const fromMinified = await load(minify(patched));

  for (const range of ["bytes=0-16383", "bytes=16384-16685", "bytes=-4096"]) {
    const a = await run(fromSource, range);
    const b = await run(fromMinified, range);
    assert.equal(b.status, a.status, `status differs for ${range}`);
    assert.deepEqual(b.body, a.body, `body differs for ${range}`);
  }

  // And a range the source refuses, the minified copy must refuse too.
  assert.equal((await run(fromMinified, null)).status, 416);
  assert.equal((await run(fromMinified, "bytes=100-50")).status, 416);
});

check("minifying twice changes nothing", () => {
  const source = readFileSync(new URL("./snippet.js", import.meta.url), "utf8");
  const once = minify(source);
  assert.equal(minify(once), once);
});

checkAsync("the minified snippet is under 32 KB", async () => {
  const source = readFileSync(new URL("./snippet.js", import.meta.url), "utf8");
  const small = minify(source);
  assert.ok(
    Buffer.byteLength(small) < 32 * 1024,
    `minified size is ${Buffer.byteLength(small)} bytes`
  );
  const raw = Buffer.byteLength(source);
  const out = Buffer.byteLength(small);
  console.log(`      snippet ${raw} bytes -> ${out} bytes (${(100 * out / raw).toFixed(0)}%)`);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);