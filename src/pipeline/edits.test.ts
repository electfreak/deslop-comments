/**
 * The star decoration a rewritten block comment is rendered with. See `isStarred`.
 *
 * The case that motivated these is the last one a reader would look for: a one-line doc comment
 * whose rewrite is too long to stay on one line. It is the only input that carries no evidence of
 * the style its own file wants, so it is the only one the opener decides for.
 */

import { describe, expect, test } from "bun:test";
import { applyEdits, editFor, type SourceComment } from "./edits.ts";

/** A replacement long enough that no width leaves it on one line. */
const LONG =
  "Notification title shown when the link's click finds no AI chat available, as in the test IDE."
  + " The tooltip renders the link either way.";

/** A replacement short enough to fit the default width. */
const SHORT = "The title of the notification.";

function rewrite(src: string, original: string, replacement: string): string {
  const startByte = src.indexOf(original);

  if (startByte === -1) throw new Error(`the fixture does not contain ${original}`);

  const comment: SourceComment = {
    id: "c1",
    file: "Fixture.kt",
    startByte,
    endByte: startByte + original.length,
    kind: "block",
    marker: "",
    trailing: false,
  };

  const result = editFor(src, comment, "REWRITE", replacement);

  if (!result.ok) throw new Error(result.reason);

  return applyEdits(src, [result.edit]);
}

/** The lines a star decorates, which the closing delimiter of a bare block is not one of. */
function decorated(out: string): string[] {
  return out.split("\n").filter((line) => /^\s*\* /.test(line));
}

/** One own-line comment at two spaces of indent, the shape the real finding had. */
function indented(original: string): string {
  return `class T {\n  ${original}\n  val x = 1\n}\n`;
}

describe("a one-line block comment a rewrite grows", () => {
  test("takes the stars a doc comment conventionally has", () => {
    expect(rewrite(indented("/** The title. */"), "/** The title. */", LONG)).toBe(
      "class T {\n"
      + "  /**\n"
      + "   * Notification title shown when the link's click finds no AI chat available, as in the test IDE.\n"
      + "   * The tooltip renders the link either way.\n"
      + "   */\n"
      + "  val x = 1\n"
      + "}\n",
    );
  });

  test("takes them under the other doc opener too", () => {
    const out = rewrite(indented("/*! The title. */"), "/*! The title. */", LONG);

    expect(out).toContain("  /*!\n   * Notification title");
    expect(out).toContain("\n   */\n");
  });

  test("stays bare under an opener no language stars", () => {
    const plain = rewrite(indented("/* The title. */"), "/* The title. */", LONG);

    expect(plain).toContain("  /*\n  Notification title");
    expect(decorated(plain)).toEqual([]);

    const html = rewrite("<div>\n  <!-- The title. -->\n</div>\n", "<!-- The title. -->", LONG);

    expect(decorated(html)).toEqual([]);
  });

  test("is left on one line when the rewrite still fits", () => {
    expect(rewrite(indented("/** The title. */"), "/** The title. */", SHORT)).toBe(
      `class T {\n  /** ${SHORT} */\n  val x = 1\n}\n`,
    );
  });

  test("is wrapped to the width with the stars counted against it", () => {
    const out = rewrite(indented("/** The title. */"), "/** The title. */", LONG);

    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });
});

describe("a block comment that already spans lines", () => {
  test("keeps the stars it had", () => {
    const original = "/**\n   * The title of\n   * the notification.\n   */";
    const out = rewrite(indented(original), original, LONG);

    expect(out).toContain("  /**\n   * Notification title");
    expect(out).toContain("\n   */\n");
  });

  test("is read as starred by its own closing delimiter, bare body or not", () => {
    // Not what the name isStarred suggests: the `*/` on its own line is a continuation line that
    // starts with a star, so every multi-line comment in the `/* */` family answers yes whatever
    // its body looks like. Harmless for a doc comment, which wanted stars anyway. It does mean a
    // deliberately bare one is restarred rather than left alone.
    const original = "/**\n  The title of\n  the notification.\n  */";
    const out = rewrite(indented(original), original, LONG);

    expect(out).toContain("   * Notification title");
  });
});

describe("a doc tag in a replacement", () => {
  /** What the transformer returned for the comment that found this, verbatim. */
  const TAGGED =
    "How a hand crosses from the row to the link.\n"
    + "@param dx horizontal offset of the walk.\n"
    + "@param detourDy how far the hand first dips into the next row before climbing.\n"
    + "@param restOnTheSeam how long the hand rests on each pixel of the seam; resting moves 1 px"
    + " at a time, not resting moves 2 px at a time, though the driver's robot still visits every"
    + " intervening pixel.";

  test("starts its own line, however long the tag above it ran", () => {
    const out = rewrite(indented("/** The walk. */"), "/** The walk. */", TAGGED);
    const tagged = out.split("\n").filter((line) => line.includes("@param"));

    expect(tagged).toHaveLength(3);

    for (const line of tagged) expect(line.trim()).toStartWith("* @param ");
  });

  test("keeps the summary above the tags", () => {
    const out = rewrite(indented("/** The walk. */"), "/** The walk. */", TAGGED);

    expect(out).toContain("  /**\n   * How a hand crosses from the row to the link.\n   * @param dx");
  });

  test("reflows with its own continuation when it does not fit", () => {
    const out = rewrite(indented("/** The walk. */"), "/** The walk. */", TAGGED);
    const lines = out.split("\n");
    const last = lines.findIndex((line) => line.includes("@param restOnTheSeam"));

    // The long one wraps, and what it wraps onto is its own text rather than the next tag.
    expect(lines[last + 1]).not.toContain("@param");
    expect(lines[last + 1]!.trim()).toStartWith("* ");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
  });

  test("is recognised in the backslash spelling too", () => {
    const doxygen =
      "How a hand crosses from the row to the link.\n"
      + "\\param dx horizontal offset of the walk, measured from the left edge of the row the hand"
      + " starts the crossing from rather than from the edge of the tree.\n"
      + "\\param detourDy how far the hand first dips into the next row before it climbs back out.";
    const out = rewrite(indented("/** The walk. */"), "/** The walk. */", doxygen);

    const tagged = out.split("\n").filter((line) => line.includes("\\param"));

    expect(tagged).toHaveLength(2);

    for (const line of tagged) expect(line.trim()).toStartWith("* \\param ");
  });

  test("does not break a paragraph that merely mentions a tag mid-sentence", () => {
    const prose =
      "How a hand crosses from the row to the link, which the @param tags below describe in the\n"
      + "detail the walk needs, since the offsets are not obvious from the parameter names alone.";
    const out = rewrite(indented("/** The walk. */"), "/** The walk. */", prose);

    expect(out).toContain("which the @param tags below");
  });
});
