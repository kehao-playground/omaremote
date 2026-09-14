// Spec §2 / Plan 2 Task 0 finding: lib/ must load in Quickshell's QML JS engine (Qt 6.11 V4) — no object spread, ??, ?., optional catch binding or Node built-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const libDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
const files = readdirSync(libDir).filter((f) => f.endsWith(".mjs")).sort();
const sources = files.map((f) => ({ file: f, text: readFileSync(path.join(libDir, f), "utf8") }));

function violations(regex) {
  const hits = [];
  for (const { file, text } of sources) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
      regex.lastIndex = 0; // guard global/sticky regexes reused across lines
    }
  }
  return hits;
}

test("lib/*.mjs contains no object spread syntax", () => {
  const hits = violations(/\{\s*\.\.\./);
  assert.deepEqual(hits, [], `object spread found (use Object.assign instead):\n${hits.join("\n")}`);
});

test("lib/*.mjs contains no nullish coalescing (??)", () => {
  const hits = violations(/\?\?/);
  assert.deepEqual(hits, [], `nullish coalescing (??) found:\n${hits.join("\n")}`);
});

test("lib/*.mjs contains no optional chaining (?.)", () => {
  const hits = violations(/\?\.(?!\d)/);
  assert.deepEqual(hits, [], `optional chaining (?.) found:\n${hits.join("\n")}`);
});

test("lib/*.mjs contains no optional catch binding", () => {
  const hits = violations(/catch\s*\{/);
  assert.deepEqual(hits, [], `optional catch binding (catch {) found:\n${hits.join("\n")}`);
});

test("lib/*.mjs imports no Node built-ins", () => {
  const hits = violations(/from\s+["'](?:node:|fs|path|os|child_process|url|util|events|crypto|http|https|net|stream|assert)(?:["'\/])/);
  assert.deepEqual(hits, [], `Node built-in import found:\n${hits.join("\n")}`);
});
