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

/**
 * Detect object spread sites in source code via brace-balance scan.
 * Returns array of 1-based line numbers where `...` appears inside object literals `{...}`.
 * Ignores: string/template contents, comments, array spreads `[...]`, call/param spreads `f(...)`
 */
function objectSpreadSites(source) {
  // Strip comments and string contents to avoid false positives
  let scrubbed = "";
  let i = 0;
  while (i < source.length) {
    // Line comment
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      scrubbed += "\n";
      i++;
      continue;
    }
    // Block comment
    if (source[i] === "/" && source[i + 1] === "*") {
      scrubbed += " ";
      i += 2;
      while (i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") scrubbed += "\n";
        else scrubbed += " ";
        i++;
      }
      i += 2;
      scrubbed += " ";
      continue;
    }
    // Template literal (backtick)
    if (source[i] === "`") {
      scrubbed += " ";
      i++;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\" && i + 1 < source.length) {
          i += 2;
          scrubbed += "  ";
        } else {
          if (source[i] === "\n") scrubbed += "\n";
          else scrubbed += " ";
          i++;
        }
      }
      i++;
      scrubbed += " ";
      continue;
    }
    // String (single quote)
    if (source[i] === "'") {
      scrubbed += " ";
      i++;
      while (i < source.length && source[i] !== "'") {
        if (source[i] === "\\" && i + 1 < source.length) {
          i += 2;
          scrubbed += "  ";
        } else {
          scrubbed += " ";
          i++;
        }
      }
      i++;
      scrubbed += " ";
      continue;
    }
    // String (double quote)
    if (source[i] === '"') {
      scrubbed += " ";
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) {
          i += 2;
          scrubbed += "  ";
        } else {
          scrubbed += " ";
          i++;
        }
      }
      i++;
      scrubbed += " ";
      continue;
    }
    scrubbed += source[i];
    i++;
  }

  // Scan for object spreads via brace balance
  const hits = [];
  const lines = scrubbed.split("\n");
  const brackets = []; // stack of { [ (

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];

      // Track bracket depth
      if (ch === "{" || ch === "[" || ch === "(") {
        brackets.push(ch);
      } else if (ch === "}") {
        brackets.pop();
      } else if (ch === "]") {
        brackets.pop();
      } else if (ch === ")") {
        brackets.pop();
      }
      // Check for ... followed by identifier/bracket
      else if (ch === "." && j + 2 < line.length && line[j + 1] === "." && line[j + 2] === ".") {
        // Look ahead (skip whitespace) to see what follows
        let k = j + 3;
        while (k < line.length && /\s/.test(line[k])) k++;

        if (k < line.length) {
          const nextCh = line[k];
          const isIdentifierStart = /[a-zA-Z_$]/.test(nextCh);
          const isBracket = /[\(\[\{]/.test(nextCh);

          // Only flag if innermost bracket is { (object literal)
          if ((isIdentifierStart || isBracket) && brackets.length > 0 && brackets[brackets.length - 1] === "{") {
            hits.push(lineNum + 1);
            j += 2; // Skip past the spread operator
          }
        }
      }
    }
  }

  return hits;
}

// Unit tests for objectSpreadSites helper (intentionally before main tests for RED/GREEN TDD)
test("objectSpreadSites: detects { ...a }", () => {
  const source = "{ ...a }";
  const hits = objectSpreadSites(source);
  assert.deepEqual(hits, [1], "should flag object spread");
});

test("objectSpreadSites: detects { a, ...b }", () => {
  const source = "{ a, ...b }";
  const hits = objectSpreadSites(source);
  assert.deepEqual(hits, [1], "should flag mid-literal object spread");
});

test("objectSpreadSites: detects multi-line {...}", () => {
  const source = "{\n  ...src,\n}";
  const hits = objectSpreadSites(source);
  assert.deepEqual(hits, [2], "should flag spread on line 2");
});

test("objectSpreadSites: ignores [ ...a ]", () => {
  const source = "[ ...a ]";
  const hits = objectSpreadSites(source);
  assert.deepEqual(hits, [], "should not flag array spread");
});

test("objectSpreadSites: ignores f(...args)", () => {
  const source = "f(...args)";
  const hits = objectSpreadSites(source);
  assert.deepEqual(hits, [], "should not flag call spread");
});

test("objectSpreadSites: ignores function g(...rest) {}", () => {
  const source = "function g(...rest) {}";
  const hits = objectSpreadSites(source);
  assert.deepEqual(hits, [], "should not flag param rest");
});

test("objectSpreadSites: ignores \"{ ...a }\" in string", () => {
  const source = '"{ ...a }"';
  const hits = objectSpreadSites(source);
  assert.deepEqual(hits, [], "should not flag spread inside string");
});

test("objectSpreadSites: ignores // { ...a } comment", () => {
  const source = "// { ...a }";
  const hits = objectSpreadSites(source);
  assert.deepEqual(hits, [], "should not flag spread inside comment");
})

test("lib/*.mjs contains no object spread syntax", () => {
  const hits = [];
  for (const { file, text } of sources) {
    const spreadLines = objectSpreadSites(text);
    for (const lineNum of spreadLines) {
      const lines = text.split("\n");
      hits.push(`${file}:${lineNum}: ${lines[lineNum - 1].trim()}`);
    }
  }
  assert.deepEqual(hits, [], `object spread found (use Object.assign instead):\n${hits.join("\n")}`);
});

// Keep this test unchanged but verify it still works
test("verify no array/call spreads are falsely flagged", () => {
  // These should NOT be flagged by objectSpreadSites (they're array/call spreads, not object spreads)
  assert.deepEqual(objectSpreadSites("[...a]"), [], "array spread not flagged");
  assert.deepEqual(objectSpreadSites("f(...x)"), [], "call spread not flagged");
  assert.deepEqual(objectSpreadSites("const [...rest] = arr"), [], "destructure rest not flagged");
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
  const hits = violations(/(?:from\s+|import\s+)["'](?:node:|fs|path|os|child_process|url|util|events|crypto|http|https|net|stream|assert)(?:["'\/])/);
  assert.deepEqual(hits, [], `Node built-in import found:\n${hits.join("\n")}`);
});
