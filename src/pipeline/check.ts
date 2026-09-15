#!/usr/bin/env bun
/**
 * The self check for the parts that spend no tokens.
 *
 * Run it with `bun src/pipeline/check.ts`. It exercises the merge table, the renderer and the
 * plan, none of which call the model.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { CriticResult } from "../transformer/run-critic.js";
import type { TransformResult } from "../transformer/run-transformer.js";
import { planEdits } from "./apply.js";
import { applyEdits, editFor, type SourceComment } from "./edits.js";
import { mergeDecisions } from "./merge.js";
import { shaOf, type ScanRecord } from "./report.js";

let checks = 0;

function check(name: string, run: () => void): void {
  try {
    run();
    checks++;
  }
  catch (error) {
    console.error(`FAIL ${name}`);
    console.error(`${(error as Error).message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

function comment(src: string, text: string, over: Partial<SourceComment> = {}): SourceComment {
  const startByte = src.indexOf(text);
  assert.notEqual(startByte, -1, `fixture does not contain ${text}`);

  const lineStart = src.lastIndexOf("\n", startByte - 1) + 1;

  return {
    id: "fixture",
    file: "fixture.ts",
    startByte,
    endByte: startByte + text.length,
    kind: text.startsWith("//") || text.startsWith("#") ? "line" : "block",
    marker: text.startsWith("//") ? "//" : text.startsWith("#") ? "#" : "",
    trailing: src.slice(lineStart, startByte).trim() !== "",
    ...over,
  };
}

function edited(src: string, text: string, outcome: "DELETE" | "REWRITE", replacement: string | null = null, over: Partial<SourceComment> = {}): string {
  const result = editFor(src, comment(src, text, over), outcome, replacement);
  assert.ok(result.ok, `refused: ${result.ok ? "" : result.reason}`);
  return applyEdits(src, [result.edit]);
}

check("an own-line comment takes its line with it", () => {
  const src = "const a = 1;\n  // gone\n  const b = 2;\n";
  assert.equal(edited(src, "// gone", "DELETE"), "const a = 1;\n  const b = 2;\n");
});

check("a run of line comments is one span", () => {
  const src = "x();\n// one\n// two\ny();\n";
  const span: SourceComment = {
    id: "fixture", file: "f.ts", startByte: src.indexOf("// one"),
    endByte: src.indexOf("// two") + "// two".length,
    kind: "line", marker: "//", trailing: false,
  };
  const result = editFor(src, span, "DELETE", null);
  assert.ok(result.ok);
  assert.equal(applyEdits(src, [result.edit]), "x();\ny();\n");
});

check("a trailing comment leaves the code and no trailing space", () => {
  const src = "const a = 1; // gone\nconst b = 2;\n";
  assert.equal(edited(src, "// gone", "DELETE"), "const a = 1;\nconst b = 2;\n");
});

check("code after a block comment survives the deletion", () => {
  const src = "  /* gone */ run();\n";
  assert.equal(edited(src, "/* gone */", "DELETE"), "  run();\n");
});

check("a rewrite keeps the indentation and the marker of the file", () => {
  const src = "fn();\n    // the old long comment\n    more();\n";
  assert.equal(edited(src, "// the old long comment", "REWRITE", "short"), "fn();\n    // short\n    more();\n");
});

check("a replacement that carries its own marker does not double it", () => {
  const src = "fn();\n  // old\n";
  assert.equal(edited(src, "// old", "REWRITE", "// new"), "fn();\n  // new\n");
});

check("a multi-line replacement repeats the marker and the indentation", () => {
  const src = "fn();\n  // old\n";
  assert.equal(edited(src, "// old", "REWRITE", "first\nsecond"), "fn();\n  // first\n  // second\n");
});

check("a trailing rewrite stays on one line", () => {
  const src = "call(); // old\n";
  assert.equal(edited(src, "// old", "REWRITE", "first\nsecond"), "call(); // first second\n");
});

check("a one-line block comment keeps its delimiters", () => {
  const src = "  /* old and long */\n";
  assert.equal(edited(src, "/* old and long */", "REWRITE", "short"), "  /* short */\n");
});

check("a starred block keeps its stars", () => {
  const src = "/**\n * one\n * two\n */\nfn();\n";
  const span = comment(src, "/**\n * one\n * two\n */");
  const result = editFor(src, span, "REWRITE", "alpha\nbeta");
  assert.ok(result.ok);
  assert.equal(applyEdits(src, [result.edit]), "/**\n * alpha\n * beta\n */\nfn();\n");
});

check("a single-line replacement is wrapped across markers", () => {
  const src = "fn();\n  // old\n";
  const replacement = Array.from({ length: 30 }, () => "word").join(" ");
  const lines = edited(src, "// old", "REWRITE", replacement).split("\n").slice(1, -1);

  assert.ok(lines.length > 1, "the replacement stayed on one line");

  for (const line of lines) {
    assert.ok(line.startsWith("  // "), `lost its marker or indentation: ${line}`);
    assert.ok(line.length <= 100, `wider than the default: ${line.length}`);
  }

  assert.equal(lines.map((line) => line.slice(5)).join(" "), replacement, "text was lost");
});

check("a long replacement wraps inside a starred block and keeps the stars", () => {
  const src = "/**\n * one\n * two\n */\nfn();\n";
  const replacement = Array.from({ length: 40 }, () => "word").join(" ");
  const lines = edited(src, "/**\n * one\n * two\n */", "REWRITE", replacement).split("\n");

  assert.equal(lines[0], "/**");
  assert.equal(lines[lines.length - 3], " */");

  const body = lines.slice(1, -3);

  assert.ok(body.length > 1, "the replacement stayed on one line");

  for (const line of body) assert.ok(line.startsWith(" * "), `lost its star: ${line}`);

  assert.equal(body.map((line) => line.slice(3)).join(" "), replacement, "text was lost");
});

check("a rewrite wraps to the width the original comment used", () => {
  const original = `// ${Array.from({ length: 14 }, () => "word").join(" ")}`;
  assert.equal(original.length, 72);

  const src = `${original}\nfn();\n`;
  const replacement = Array.from({ length: 40 }, () => "word").join(" ");
  const lines = edited(src, original, "REWRITE", replacement).split("\n").slice(0, -2);

  assert.ok(lines.length > 1, "the replacement stayed on one line");

  for (const line of lines) assert.ok(line.length <= 72, `wider than the original: ${line.length}`);

  // Filling to within a word of 72 is what tells the inferred width from the default apart.
  assert.ok(lines.some((line) => line.length > 66), "wrapped far narrower than the original");
});

check("a trailing rewrite is never wrapped", () => {
  const src = "call(); // old\n";
  const replacement = Array.from({ length: 40 }, () => "word").join(" ");
  assert.equal(edited(src, "// old", "REWRITE", replacement), `call(); // ${replacement}\n`);
});

check("a break the model wrapped itself is reflowed, not left stranded", () => {
  // A KDoc whose widest line is 83 columns, so the budget is 83 less the indent and the star.
  const wide = `/**\n     * ${"x".repeat(76)}\n     */`;
  const src = `class C {\n    ${wide}\n    fun f() {}\n}\n`;

  // The model wrapped to its own width and broke this mid-sentence, after "no".
  const replacement =
    "The manager can move a balloon that would not fit where it was asked to be. The balloon adds no\n" +
    "border, so the content bounds are the balloon bounds.";

  const body = edited(src, wide, "REWRITE", replacement)
    .split("\n")
    .filter((line) => line.startsWith("     * "))
    .map((line) => line.slice("     * ".length));

  assert.equal(body.join(" "), replacement.split("\n").join(" "), "text was lost");

  for (const line of body) assert.ok(line.length <= 76, `wider than the original: ${line}`);

  // The stranded fragment is the bug: every line but the last is filled before the next begins.
  for (const line of body.slice(0, -1)) {
    assert.ok(line.length > 60, `stranded a fragment on its own line: ${line}`);
  }
});

check("a blank line between paragraphs survives as a bare star", () => {
  const src = "/**\n * one\n * two\n */\nfn();\n";
  const lines = edited(src, "/**\n * one\n * two\n */", "REWRITE", "First.\n\nSecond.").split("\n");

  assert.deepEqual(lines.slice(0, 5), ["/**", " * First.", " *", " * Second.", " */"]);
});

check("a list item is not folded into the line above it", () => {
  const src = "/**\n * one\n * two\n */\nfn();\n";
  const long = Array.from({ length: 30 }, () => "word").join(" ");
  const lines = edited(src, "/**\n * one\n * two\n */", "REWRITE", `${long}\n- first\n- second`)
    .split("\n");

  assert.ok(lines.includes(" * - first"), `lost the first item: ${lines.join("|")}`);
  assert.ok(lines.includes(" * - second"), `lost the second item: ${lines.join("|")}`);
});

check("rendering an already wrapped comment again changes nothing", () => {
  const src = "/**\n * one\n * two\n */\nfn();\n";
  const replacement = Array.from({ length: 40 }, () => "word").join(" ");
  const once = edited(src, "/**\n * one\n * two\n */", "REWRITE", replacement);

  const rendered = once.split("\n").slice(0, -2).join("\n");
  const body = rendered.split("\n").slice(1, -1).map((line) => line.slice(3)).join("\n");

  assert.equal(edited(src, "/**\n * one\n * two\n */", "REWRITE", body), once, "not idempotent");
});

check("a docstring gets no padding inside its quotes", () => {
  const src = 'def f():\n    """The old docstring."""\n    pass\n';
  const span = comment(src, '"""The old docstring."""');
  const result = editFor(src, span, "REWRITE", "Newer.");
  assert.ok(result.ok);
  assert.equal(applyEdits(src, [result.edit]), 'def f():\n    """Newer."""\n    pass\n');
});

check("an unknown block delimiter is refused, not guessed", () => {
  const src = "@@ odd @@\n";
  const span = comment(src, "@@ odd @@");
  const result = editFor(src, span, "REWRITE", "short");
  assert.equal(result.ok, false);
});

check("a deletion of an unknown block still works", () => {
  const src = "@@ odd @@\nfn();\n";
  assert.equal(edited(src, "@@ odd @@", "DELETE"), "fn();\n");
});

check("edits apply back to front", () => {
  const src = "// one\nkeep();\n// two\n";
  const first = editFor(src, comment(src, "// one"), "DELETE", null);
  const second = editFor(src, comment(src, "// two"), "DELETE", null);
  assert.ok(first.ok && second.ok);
  assert.equal(applyEdits(src, [first.edit, second.edit]), "keep();\n");
});

check("overlapping edits are refused", () => {
  assert.throws(() => applyEdits("abcdef", [
    { start: 0, end: 3, text: "" },
    { start: 2, end: 4, text: "" },
  ]), /overlapping/);
});

// ---------------------------------------------------------------------------
// The merge table
// ---------------------------------------------------------------------------

function transform(action: string, replacement: string | null = null, review: string | null = null): TransformResult {
  return {
    decisions: [{
      id: "c1",
      action: action as TransformResult["decisions"][number]["action"],
      propositions: [],
      surviving_propositions: [],
      replacement,
      review_reason: review,
    }],
  };
}

function criticised(action: string, replacement: string | null = null, reason: string | null = null): CriticResult {
  return {
    decisions: [{
      id: "c1",
      action: action as CriticResult["decisions"][number]["action"],
      replacement,
      removed_information: [],
      reason,
    }],
  };
}

check("a transformer deletion needs no critic", () => {
  const [merged] = mergeDecisions(transform("DELETE"), { decisions: [] });
  assert.equal(merged?.outcome, "DELETE");
  assert.equal(merged?.decidedBy, "transformer");
});

check("a transformer review carries its reason", () => {
  const [merged] = mergeDecisions(transform("REVIEW", null, "not enough context"), { decisions: [] });
  assert.equal(merged?.outcome, "REVIEW");
  assert.equal(merged?.reason, "not enough context");
});

check("an accepted keep changes nothing", () => {
  const [merged] = mergeDecisions(transform("KEEP"), criticised("ACCEPT"));
  assert.equal(merged?.outcome, "UNCHANGED");
});

check("an accepted rewrite takes the transformer's text", () => {
  const [merged] = mergeDecisions(transform("REWRITE", "from transformer"), criticised("ACCEPT"));
  assert.equal(merged?.outcome, "REWRITE");
  assert.equal(merged?.replacement, "from transformer");
});

check("the critic can delete what the transformer kept", () => {
  const [merged] = mergeDecisions(transform("KEEP"), criticised("DELETE", null, "recoverable"));
  assert.equal(merged?.outcome, "DELETE");
  assert.equal(merged?.decidedBy, "critic");
});

check("the critic's rewrite wins over the transformer's", () => {
  const [merged] = mergeDecisions(transform("REWRITE", "from transformer"), criticised("REWRITE", "from critic"));
  assert.equal(merged?.replacement, "from critic");
  assert.equal(merged?.decidedBy, "critic");
});

check("a transformer-only run needs no critic result", () => {
  const [merged] = mergeDecisions(transform("REWRITE", "only pass"), null);
  assert.equal(merged?.replacement, "only pass");
});

check("a critic verdict on a deleted comment is an error", () => {
  assert.throws(() => mergeDecisions(transform("DELETE"), criticised("ACCEPT")), /marked DELETE/);
});

check("an unknown critic id is an error", () => {
  assert.throws(
    () => mergeDecisions(transform("KEEP"), { decisions: [{ id: "other", action: "ACCEPT", replacement: null, removed_information: [], reason: null }] }),
    /never saw/,
  );
});

check("a rewrite without a replacement is an error", () => {
  assert.throws(() => mergeDecisions(transform("REWRITE", null), criticised("ACCEPT")), /without a replacement/);
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function record(src: string, text: string): ScanRecord {
  const startByte = src.indexOf(text);

  return {
    id: `a.ts:1:1`,
    file: "a.ts",
    language: "typescript",
    startByte,
    endByte: startByte + text.length,
    kind: "line",
    marker: "//",
    trailing: false,
    sha: shaOf(src),
    text,
    before: "",
    after: "",
  };
}

check("a file that changed since the scan is skipped", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deslop-"));
  const src = "// gone\nfn();\n";
  const scanned = record(src, "// gone");
  writeFileSync(path.join(root, "a.ts"), "// gone\nfn();\n// and more\n");

  const plan = planEdits(root, [scanned], [
    { id: scanned.id, outcome: "DELETE", replacement: null, decidedBy: "critic", reason: null },
  ]);

  assert.equal(plan.files.length, 0);
  assert.match(plan.skipped[0]?.reason ?? "", /changed since the scan/);
});

check("an unchanged file is planned", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deslop-"));
  const src = "// gone\nfn();\n";
  const scanned = record(src, "// gone");
  writeFileSync(path.join(root, "a.ts"), src);

  const plan = planEdits(root, [scanned], [
    { id: scanned.id, outcome: "DELETE", replacement: null, decidedBy: "critic", reason: null },
  ]);

  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.files.length, 1);
  assert.equal(applyEdits(src, plan.files[0]!.edits.map((edit) => edit.edit)), "fn();\n");
});

check("an unchanged verdict plans nothing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deslop-"));
  const src = "// stays\nfn();\n";
  const scanned = record(src, "// stays");
  writeFileSync(path.join(root, "a.ts"), src);

  const plan = planEdits(root, [scanned], [
    { id: scanned.id, outcome: "UNCHANGED", replacement: null, decidedBy: "transformer", reason: null },
  ]);

  assert.equal(plan.files.length, 0);
});

console.error(process.exitCode === 1 ? "checks failed" : `${checks} checks passed`);
