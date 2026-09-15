/**
 * Turns a verdict into one text edit.
 *
 * Nothing here reads a file or a decision file. It takes the source, the span the scanner
 * reported, and the wanted outcome, and it returns the replacement for that span. A case it
 * cannot render safely is refused rather than guessed, so a file is never half understood.
 */

export interface SourceComment {
  id: string;
  file: string;
  startByte: number;
  endByte: number;
  kind: "line" | "block";
  /** The line marker, or the empty string for a block comment. */
  marker: string;
  trailing: boolean;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export type EditResult =
  | { ok: true; edit: TextEdit }
  | { ok: false; reason: string };

/** The widths a rewrite wraps to. See `widthOf`. */
const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 60;
const MAX_WIDTH = 120;

/** Below this the prefixes leave too little room to wrap into, so the text is left alone. */
const MIN_BUDGET = 20;

/** A line opening with one of these carries its own break and is never joined to the line above. */
const LIST_ITEM = /^([-+*\u2022]|\d+[.)])\s/;

/**
 * A doc tag, which also carries its own break: `@param`, `@return`, and the rest of the tags a doc
 * viewer parses per line, in the `@` spelling and the backslash one Doxygen uses.
 */
const DOC_TAG = /^[@\\]\w/;

/** The openers a one-line comment is grown into a starred block under. See `isStarred`. */
const STARRED_OPENERS = new Set(["/**", "/*!"]);

/** The block delimiters the renderer knows, longest opener first. */
const BLOCK_DELIMITERS: Array<[string, string]> = [
  ["=begin", "=end"],
  ["--[[", "]]"],
  ["<!--", "-->"],
  ['"""', '"""'],
  ["'''", "'''"],
  ["/**", "*/"],
  ["/*!", "*/"],
  ["#[", "]#"],
  ["/*", "*/"],
  ["{-", "-}"],
  ["(*", "*)"],
  ["/+", "+/"],
  ["#|", "|#"],
  ["<#", "#>"],
  ["%{", "%}"],
];

export function editFor(
  src: string,
  comment: SourceComment,
  outcome: "DELETE" | "REWRITE",
  replacement: string | null,
): EditResult {
  if (comment.endByte > src.length || comment.startByte >= comment.endByte) {
    return { ok: false, reason: "the reported span does not fit the file" };
  }

  return outcome === "DELETE"
    ? deletion(src, comment)
    : rewrite(src, comment, replacement ?? "");
}

function deletion(src: string, comment: SourceComment): EditResult {
  const lineStart = startOfLine(src, comment.startByte);
  const rest = src.slice(comment.endByte, endOfLine(src, comment.endByte));

  if (comment.trailing) {
    // Eat the gap between the code and the comment, and any space the comment left behind.
    let start = comment.startByte;
    while (start > lineStart && isBlank(src[start - 1])) start--;

    return {
      ok: true,
      edit: {
        start,
        end: rest.trim() === "" ? comment.endByte + rest.length : comment.endByte,
        text: "",
      },
    };
  }

  const indent = src.slice(lineStart, comment.startByte);

  if (!isAllBlank(indent)) {
    return { ok: false, reason: "code precedes a comment the scan called own-line" };
  }

  if (rest.trim() !== "") {
    // Code follows on the last line, so the line stays and only the comment goes.
    const gap = rest.length - rest.replace(/^[ \t]*/, "").length;

    return { ok: true, edit: { start: lineStart, end: comment.endByte + gap, text: indent } };
  }

  // The comment owns every line it covers, so the lines go with it.
  const lineEnd = endOfLine(src, comment.endByte);

  return {
    ok: true,
    edit: { start: lineStart, end: lineEnd < src.length ? lineEnd + 1 : lineEnd, text: "" },
  };
}

function rewrite(src: string, comment: SourceComment, replacement: string): EditResult {
  const body = bodyLines(replacement, comment);

  if (body.length === 0) {
    return { ok: false, reason: "the replacement is empty once markers are stripped" };
  }

  const lineStart = startOfLine(src, comment.startByte);
  const indent = src.slice(lineStart, comment.startByte);
  const original = src.slice(comment.startByte, comment.endByte);

  // A comment that shares its line with code cannot take a line break, so it stays flat.
  const flat = comment.trailing || !isAllBlank(indent);
  const width = widthOf(original, indent);

  if (comment.kind === "line") {
    if (flat) {
      const text = `${comment.marker} ${flatten(body)}`;
      return { ok: true, edit: { start: comment.startByte, end: comment.endByte, text } };
    }

    const wrapped = reflow(body, width - indent.length - comment.marker.length - 1);
    const text = wrapped
      .map((line) => (line === "" ? `${indent}${comment.marker}` : `${indent}${comment.marker} ${line}`))
      .join("\n");

    return { ok: true, edit: { start: lineStart, end: comment.endByte, text } };
  }

  const pair = BLOCK_DELIMITERS.find(([open]) => original.startsWith(open));

  if (pair === undefined) {
    return { ok: false, reason: "unknown block comment delimiters" };
  }

  const [open, close] = pair;

  if (!original.endsWith(close) || original.length < open.length + close.length) {
    return { ok: false, reason: `a block comment opened with ${open} does not close with ${close}` };
  }

  const starred = isStarred(original, open);

  if (flat) {
    const text = renderBlock([flatten(body)], open, close, indent, starred);
    return { ok: true, edit: { start: comment.startByte, end: comment.endByte, text } };
  }

  // A body that still fits keeps the one-line form; anything longer takes the block shape.
  const single = renderBlock([flatten(body)], open, close, indent, starred);

  if (body.length === 1 && indent.length + single.length <= width) {
    return { ok: true, edit: { start: lineStart, end: comment.endByte, text: `${indent}${single}` } };
  }

  const wrapped = reflow(body, width - indent.length - (starred ? 3 : 0));
  const rendered = renderBlock(wrapped, open, close, indent, starred);

  return { ok: true, edit: { start: lineStart, end: comment.endByte, text: `${indent}${rendered}` } };
}

/**
 * The width a rewrite wraps to.
 *
 * The original comment is the only hint available about the file: one that wrapped at 80 keeps
 * being wrapped at 80. A comment too short to have been wrapped at all says nothing, so the
 * default stands in for it, and an unusually wide one is not taken as licence to go wider.
 */
function widthOf(original: string, indent: string): number {
  const longest = original.split("\n").reduce(
    // The indent precedes the span, so only the first line is missing it.
    (max, line, index) => Math.max(max, line.length + (index === 0 ? indent.length : 0)),
    0,
  );

  return longest < MIN_WIDTH ? DEFAULT_WIDTH : Math.min(longest, MAX_WIDTH);
}

/**
 * Wraps a replacement to the budget, reflowing the breaks the model put in it.
 *
 * A replacement arrives already broken into lines, and the model chose those breaks against its
 * own idea of a width rather than this file's. Re-wrapping each of them on its own would leave the
 * tail of every one stranded on a line by itself, so a run of lines that does not fit is joined
 * back into a paragraph and wrapped as a whole.
 *
 * A run that already fits is passed through untouched. That is what keeps a deliberate break, and
 * a second pass over a comment this already rendered, from being undone.
 */
function reflow(lines: string[], budget: number): string[] {
  if (budget < MIN_BUDGET) return lines;

  const wrapped: string[] = [];

  for (const block of blocksOf(lines)) {
    if (block.every((line) => line.length <= budget)) wrapped.push(...block);
    else wrapped.push(...wrap(block.join(" "), budget));
  }

  return wrapped;
}

/**
 * Cuts the body where a break has to survive reflowing.
 *
 * A blank line separates paragraphs, and a list item or a doc tag would otherwise be folded into
 * the line above it. A tag has to start its own line for a doc viewer to read it as a tag at all,
 * so joining two of them loses more than the shape. Everything between two such breaks is one
 * paragraph, so a tag wrapped onto a second line still reflows together with its own continuation.
 */
function blocksOf(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if ((line === "" || LIST_ITEM.test(line) || DOC_TAG.test(line)) && current.length > 0) {
      blocks.push(current);
      current = [];
    }

    if (line === "") blocks.push([""]);
    else current.push(line);
  }

  if (current.length > 0) blocks.push(current);

  return blocks;
}

/** Greedily, and a word wider than the budget takes a line to itself rather than being cut. */
function wrap(text: string, budget: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/\s+/)) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= budget) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }

  if (current !== "") lines.push(current);

  return lines;
}

/** One line, for a comment that has no room for a second. Paragraph breaks cannot survive it. */
function flatten(body: string[]): string {
  return body.filter((line) => line !== "").join(" ");
}

/**
 * Whether a rewrite decorates the middle lines of a block with a star.
 *
 * A comment that already decorated them keeps doing so. A one-line comment says nothing either
 * way, and a rewrite is what grows it into a block in the first place, so the opener decides:
 * a doc comment takes the stars its languages conventionally give it, and anything else stays
 * bare, since a star means nothing under `<!--` or `"""`.
 */
function isStarred(original: string, open: string): boolean {
  const continuations = original.split("\n").slice(1);

  if (continuations.length === 0) return STARRED_OPENERS.has(open);

  return continuations.some((line) => line.trim().startsWith("*"));
}

function renderBlock(
  body: string[],
  open: string,
  close: string,
  indent: string,
  starred: boolean,
): string {
  const spacer = open === close ? "" : " ";

  if (body.length === 1) {
    return `${open}${spacer}${body[0]}${spacer}${close}`;
  }

  const lines = starred
    ? body.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`))
    : body.map((line) => (line === "" ? "" : `${indent}${line}`));

  const closer = starred ? `${indent} ${close}` : `${indent}${close}`;

  return [open, ...lines, closer].join("\n");
}

/**
 * Reduces a replacement to its text.
 *
 * The prompts do not say whether a replacement carries its own markers, so both shapes arrive.
 * Stripping them here and re-adding them from the source is what keeps the marker style and the
 * indentation of the file rather than of the model.
 */
function bodyLines(replacement: string, comment: SourceComment): string[] {
  let text = replacement.replace(/\r\n/g, "\n").trim();

  if (comment.kind === "block") {
    for (const [open, close] of BLOCK_DELIMITERS) {
      if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
        text = text.slice(open.length, text.length - close.length);
        break;
      }
    }
  }

  const lines: string[] = [];

  for (const raw of text.split("\n")) {
    let line = raw.trim();

    if (comment.kind === "line" && comment.marker !== "" && line.startsWith(comment.marker)) {
      line = line.slice(comment.marker.length).trim();
    }
    else if (comment.kind === "block" && line.startsWith("*") && !line.startsWith("**")) {
      line = line.slice(1).trim();
    }

    // A blank line is the paragraph break; a repeated or trailing one says nothing more.
    if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;

    lines.push(line);
  }

  while (lines[lines.length - 1] === "") lines.pop();

  return lines;
}

/** Applies edits to one source. The edits must not overlap. */
export function applyEdits(src: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start);

  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.start < ordered[i - 1]!.end) {
      throw new Error("overlapping edits");
    }
  }

  let out = src;

  // Back to front, so an earlier edit cannot move a later offset.
  for (const edit of ordered.reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }

  return out;
}

function startOfLine(src: string, offset: number): number {
  return src.lastIndexOf("\n", offset - 1) + 1;
}

function endOfLine(src: string, offset: number): number {
  const index = src.indexOf("\n", offset);
  return index === -1 ? src.length : index;
}

function isBlank(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function isAllBlank(text: string): boolean {
  return text === "" || /^[ \t]*$/.test(text);
}
