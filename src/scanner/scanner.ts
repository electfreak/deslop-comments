/**
 * The comment scanner, as a library.
 *
 * `scan()` walks a source tree and returns one record for every comment it finds. The command
 * line lives in `scan.ts`, which is a thin wrapper over this file, and the pipeline imports
 * `scan()` directly so a run needs no intermediate report file.
 *
 * A record spans the whole comment, so a run of line comments is one span, and it carries a
 * short digest of the file it came from so a later pass can tell whether the file still matches.
 *
 * The scanner parses. It uses tree-sitter through `web-tree-sitter`, and it takes most grammar
 * binaries from `tree-sitter-wasms`. A comment is a node in the parse tree, so a string, a
 * template, a regular expression and a nested block comment need no special rule. Svelte is not
 * in that pack and brings its own binary, and seven types have no grammar at all and fall back
 * to a small lexical pass.
 *
 * The environment variable TREE_SITTER_WASMS overrides the grammar directory of the pack.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Language, Parser, type Tree } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// The lexical fallback: the rules for a language with no grammar
// ---------------------------------------------------------------------------

interface StringRule {
  /** The opening marker. */
  open: string;
  /** The closing marker. */
  close: string;
  /** True when a backslash escapes the next character. */
  escape: boolean;
  /** True when the string can hold a line break. */
  multiline: boolean;
}

interface BlockRule {
  open: string;
  close: string;
}

interface LexSpec {
  /** The block comment markers. */
  block: BlockRule[];
  /** The string forms, in any order. The scanner tries the longest marker first. */
  strings: StringRule[];
  /**
   * Says what must sit in front of a line comment marker.
   * `any` accepts every position. `space` needs a space or a line start, as in YAML.
   * `start` needs the line start, as in a properties file.
   */
  lineBoundary: "any" | "space" | "start";
}

/** Builds a string rule. */
function str(open: string, close: string = open, escape = true, multiline = false): StringRule {
  return { open, close, escape, multiline };
}

const DQ = str('"');
const SQ = str("'");
const SLASHES: BlockRule[] = [{ open: "/*", close: "*/" }];

// ---------------------------------------------------------------------------
// The language table
// ---------------------------------------------------------------------------

interface LangDef {
  /** The key of this entry. It is unique. */
  id: string;
  /** The value of the `language` field in a record. Two entries can share it. */
  name: string;
  /** The grammar in the pack, without the `tree-sitter-` prefix. Null selects the lexer. */
  grammar: string | null;
  /** The line comment markers. They set the kind and they group a run of comments. */
  lineMarkers: string[];
  /** True for a markup language that holds script or style code inside a tag. */
  embeds: boolean;
  /** The lexical rules. They are present only when `grammar` is null. */
  lex: LexSpec | null;
}

/** Builds an entry that a tree-sitter grammar handles. */
function parsed(id: string, name: string, grammar: string, lineMarkers: string[], embeds = false): LangDef {
  return { id, name, grammar, lineMarkers, embeds, lex: null };
}

/** Builds an entry that the lexical fallback handles. */
function lexed(id: string, lineMarkers: string[], lex: Partial<LexSpec>): LangDef {
  return {
    id,
    name: id,
    grammar: null,
    lineMarkers,
    embeds: false,
    lex: { block: [], strings: [], lineBoundary: "any", ...lex },
  };
}

const LANGUAGES: LangDef[] = [
  parsed("javascript", "javascript", "javascript", ["//"]),
  parsed("typescript", "typescript", "typescript", ["//"]),
  parsed("tsx", "typescript", "tsx", ["//"]),
  parsed("java", "java", "java", ["//"]),
  parsed("kotlin", "kotlin", "kotlin", ["//"]),
  parsed("scala", "scala", "scala", ["//"]),
  parsed("c", "c", "c", ["//"]),
  parsed("cpp", "cpp", "cpp", ["//"]),
  parsed("csharp", "csharp", "c_sharp", ["//"]),
  parsed("objc", "objc", "objc", ["//"]),
  parsed("go", "go", "go", ["//"]),
  parsed("rust", "rust", "rust", ["//"]),
  parsed("swift", "swift", "swift", ["//"]),
  parsed("dart", "dart", "dart", ["//"]),
  parsed("php", "php", "php", ["//", "#"]),
  parsed("python", "python", "python", ["#"]),
  // Starlark is a Python subset, so the Python grammar reads it.
  parsed("starlark", "starlark", "python", ["#"]),
  parsed("ruby", "ruby", "ruby", ["#"]),
  parsed("lua", "lua", "lua", ["--"]),
  parsed("toml", "toml", "toml", ["#"]),
  parsed("json", "json", "json", ["//"]),
  parsed("css", "css", "css", ["//"]),
  parsed("html", "html", "html", [], true),
  parsed("vue", "vue", "vue", [], true),
  parsed("svelte", "svelte", "svelte", [], true),

  // The lexical pass takes these seven.
  // The bash grammar and the yaml grammar are in the pack, but they trap inside the runtime at
  // parse time. The bash one traps on a test command, as in `[ "$1" == "x" ]`.
  // A `#` counts only after a space, so `${x#y}` and a URL fragment stay code.
  // A heredoc is not supported. A `#` inside one is reported as a comment.
  lexed("shell", ["#"], { strings: [DQ, str("'", "'", false)], lineBoundary: "space" }),
  // A `#` counts only after a space, so `http://x#y` in a plain scalar stays code.
  lexed("yaml", ["#"], { strings: [DQ, str("'", "'", false)], lineBoundary: "space" }),
  // The other five have no grammar in the pack.
  // A `url(` region is opaque. Without it a `//` inside an unquoted URL looks like a comment.
  lexed("scss", ["//"], { block: SLASHES, strings: [str("url(", ")", false), DQ, SQ] }),
  lexed("sql", ["--"], { block: SLASHES, strings: [str("'", "'", false), str('"', '"', false)] }),
  lexed("groovy", ["//"], {
    block: SLASHES,
    strings: [str('"""', '"""', true, true), str("'''", "'''", true, true), DQ, SQ],
  }),
  // An XML string lives inside a tag only. An apostrophe in the body text is normal prose,
  // so this entry declares no string at all and looks for the comment marker alone.
  lexed("xml", [], { block: [{ open: "<!--", close: "-->" }] }),
  // A properties file takes `#` and `!` at the line start only. A value can hold both.
  lexed("properties", ["#", "!"], { lineBoundary: "start" }),
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));
const NAMES = new Set(LANGUAGES.map((l) => l.name));

/** Maps a file extension, without the dot, to an entry id. */
const BY_EXTENSION: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  scala: "scala", sc: "scala",
  groovy: "groovy", gradle: "groovy",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp",
  m: "objc", mm: "objc",
  go: "go",
  rs: "rust",
  swift: "swift",
  dart: "dart",
  php: "php",
  py: "python", pyi: "python",
  bzl: "starlark", bazel: "starlark",
  rb: "ruby",
  lua: "lua",
  sh: "shell", bash: "shell", zsh: "shell",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  json: "json", jsonc: "json", json5: "json",
  css: "css",
  scss: "scss", less: "scss", sass: "scss",
  html: "html", htm: "html",
  vue: "vue", svelte: "svelte",
  xml: "xml", svg: "xml", iml: "xml",
  properties: "properties",
  sql: "sql",
};

/** Maps a whole file name, for a file with no useful extension. */
const BY_BASENAME: Record<string, string> = {
  BUILD: "starlark",
  WORKSPACE: "starlark",
  Dockerfile: "shell",
  Makefile: "shell",
};

/** Returns the entry for a path, or null when the scanner does not know the type. */
function languageOf(file: string): LangDef | null {
  const base = path.basename(file);
  const byBase = BY_BASENAME[base];
  if (byBase !== undefined) return BY_ID.get(byBase) ?? null;

  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
  return id === undefined ? null : BY_ID.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// The grammars
// ---------------------------------------------------------------------------

interface Grammar {
  parser: Parser;
  /** Every node type of this grammar that names a comment. */
  commentTypes: Set<string>;
}

const requireFrom = createRequire(import.meta.url);

/** Returns the directory that holds the grammar binaries of the pack. */
function grammarDir(): string {
  const override = process.env["TREE_SITTER_WASMS"];
  if (override !== undefined && override !== "") return override;
  return path.join(path.dirname(requireFrom.resolve("tree-sitter-wasms/package.json")), "out");
}

/**
 * The grammars that the pack does not carry. Each one ships its own binary in its own package,
 * and the value resolves to that file. TREE_SITTER_WASMS does not move these.
 */
const OUT_OF_PACK: Record<string, string> = {
  svelte: "@tree-sitter-grammars/tree-sitter-svelte/tree-sitter-svelte.wasm",
};

/** Returns the path of the binary for a grammar. */
function grammarPath(name: string): string {
  const own = OUT_OF_PACK[name];
  if (own !== undefined) return requireFrom.resolve(own);
  return path.join(grammarDir(), `tree-sitter-${name}.wasm`);
}

/**
 * Lists the node types of a grammar that name a comment.
 *
 * The name is not the same in every grammar. Java says `line_comment` and `block_comment`,
 * Kotlin says `multiline_comment`, Dart says `documentation_comment`, and most say `comment`.
 * The scanner reads the list out of the grammar instead of holding a copy of it.
 */
function commentTypesOf(language: Language): Set<string> {
  const out = new Set<string>();
  for (let id = 0; id < language.nodeTypeCount; id++) {
    const type = language.nodeTypeForId(id);
    if (type !== null && language.nodeTypeIsNamed(id) && /comment/i.test(type)) out.add(type);
  }
  return out;
}

let started = false;
const grammars = new Map<string, Grammar | null>();

/** Loads a grammar one time. It returns null when the load fails. */
async function grammarFor(name: string): Promise<Grammar | null> {
  const cached = grammars.get(name);
  if (cached !== undefined) return cached;

  let grammar: Grammar | null = null;
  try {
    if (!started) {
      await Parser.init();
      started = true;
    }
    const language = await Language.load(grammarPath(name));
    const parser = new Parser();
    parser.setLanguage(language);
    // A grammar can load and still trap in the runtime on the first parse. One trial parse
    // finds that here, one time, instead of on a file in the middle of a long run.
    const trial = parser.parse("");
    if (trial === null) throw new Error("the trial parse returned no tree");
    trial.delete();
    grammar = { parser, commentTypes: commentTypesOf(language) };
  }
  catch (error) {
    const reason = (error as Error).message || "the grammar does not match this runtime";
    console.error(`scan: cannot load the ${name} grammar: ${reason}`);
  }
  grammars.set(name, grammar);
  return grammar;
}

// ---------------------------------------------------------------------------
// The embedded code
// ---------------------------------------------------------------------------

/**
 * The code that a markup tag holds.
 *
 * The HTML grammar, the Vue grammar and the Svelte grammar read the body of a `script` tag and
 * a `style` tag as one raw text node. They do not look inside it. The scanner parses that text
 * again with the grammar of the embedded language, so a comment in a Svelte script block is
 * reported.
 */
const EMBEDDED: Record<string, { grammar: string; lineMarkers: string[] }> = {
  script_element: { grammar: "typescript", lineMarkers: ["//"] },
  style_element: { grammar: "css", lineMarkers: ["//"] },
};

interface Region {
  grammar: string;
  lineMarkers: string[];
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

interface RawComment {
  /** The offset of the first character of the marker. */
  start: number;
  /** The offset after the last character. */
  end: number;
  kind: "line" | "block";
  /** The marker that opened the comment. It groups a run of line comments. */
  marker: string;
}

/** Tells a line comment from a block comment, and names the marker. */
function classify(text: string, lineMarkers: string[]): { kind: "line" | "block"; marker: string } {
  const sorted = [...lineMarkers].sort((a, b) => b.length - a.length);
  for (const marker of sorted) {
    if (text.startsWith(marker)) return { kind: "line", marker };
  }
  return { kind: "block", marker: "" };
}

/**
 * Walks the parse tree and reports every comment node.
 *
 * The walk does not go inside a comment. A grammar can put a node inside a comment, such as the
 * Rust doc marker or the TLA+ comment text, and one report for the whole comment is the right one.
 */
function scanTree(src: string, tree: Tree, lineMarkers: string[], types: Set<string>): RawComment[] {
  const out: RawComment[] = [];
  const cursor = tree.rootNode.walk();
  try {
    for (;;) {
      const isComment = types.has(cursor.nodeType);
      if (isComment) {
        const start = cursor.startIndex;
        // A grammar can put the line break inside the node. The record must not hold it.
        let end = cursor.endIndex;
        while (end > start && (src[end - 1] === "\n" || src[end - 1] === "\r")) end--;
        if (end > start) {
          out.push({ start, end, ...classify(src.slice(start, end), lineMarkers) });
        }
      }
      if (!isComment && cursor.gotoFirstChild()) continue;
      for (;;) {
        if (cursor.gotoNextSibling()) break;
        if (!cursor.gotoParent()) return out;
      }
    }
  }
  finally {
    cursor.delete();
  }
}

/** Lists the raw text regions of a markup file that hold code of another language. */
function embeddedRegions(tree: Tree): Region[] {
  const out: Region[] = [];
  const cursor = tree.rootNode.walk();
  try {
    for (;;) {
      if (cursor.nodeType === "raw_text") {
        const parent = cursor.currentNode.parent;
        const host = parent === null ? undefined : EMBEDDED[parent.type];
        if (host !== undefined) {
          out.push({ ...host, start: cursor.startIndex, end: cursor.endIndex });
        }
      }
      if (cursor.gotoFirstChild()) continue;
      for (;;) {
        if (cursor.gotoNextSibling()) break;
        if (!cursor.gotoParent()) return out;
      }
    }
  }
  finally {
    cursor.delete();
  }
}

/** A scheme in front of `//` means a URL and not a comment. */
const URL_SCHEME =
  /(?:^|[^A-Za-z0-9_])(?:https?|ftps?|file|wss?|git|ssh|svn|jdbc|mongodb|redis|s3|gs|data):$/;

/** Returns the offset after the block comment that starts at `start`. */
function endOfBlock(src: string, start: number, rule: BlockRule): number {
  const at = src.indexOf(rule.close, start + rule.open.length);
  return at < 0 ? src.length : at + rule.close.length; // No end means the rest of the file.
}

/** Returns the offset after the string that starts at `start`. */
function endOfString(src: string, start: number, rule: StringRule): number {
  let i = start + rule.open.length;
  while (i < src.length) {
    const c = src[i]!;
    if (rule.escape && c === "\\") {
      i += 2;
      continue;
    }
    if (!rule.multiline && c === "\n") return i; // The string has no end on this line.
    if (src.startsWith(rule.close, i)) return i + rule.close.length;
    i++;
  }
  return src.length;
}

/** Decides if a line comment marker at `i` really opens a comment. */
function opensLineComment(src: string, i: number, marker: string, lex: LexSpec): boolean {
  if (marker === "//" && i > 0 && src[i - 1] === ":") {
    const lineStart = src.lastIndexOf("\n", i - 1) + 1;
    if (URL_SCHEME.test(src.slice(lineStart, i))) return false;
  }
  if (i === 0) return true;
  if (lex.lineBoundary === "space") return /\s/.test(src[i - 1]!);
  if (lex.lineBoundary === "start") {
    const lineStart = src.lastIndexOf("\n", i - 1) + 1;
    return src.slice(lineStart, i).trim() === "";
  }
  return true;
}

/** Finds every comment in a file of a language with no grammar. The result is in file order. */
function scanLexical(src: string, def: LangDef): RawComment[] {
  const lex = def.lex!;
  const blocks = [...lex.block].sort((a, b) => b.open.length - a.open.length);
  const lines = [...def.lineMarkers].sort((a, b) => b.length - a.length);
  const strings = [...lex.strings].sort((a, b) => b.open.length - a.open.length);

  const out: RawComment[] = [];
  const n = src.length;
  let i = 0;

  outer: while (i < n) {
    for (const rule of blocks) {
      if (src.startsWith(rule.open, i)) {
        const end = endOfBlock(src, i, rule);
        out.push({ start: i, end, kind: "block", marker: rule.open });
        i = end;
        continue outer;
      }
    }

    for (const marker of lines) {
      if (src.startsWith(marker, i) && opensLineComment(src, i, marker, lex)) {
        let end = src.indexOf("\n", i);
        if (end < 0) end = n;
        const stop = end > i && src[end - 1] === "\r" ? end - 1 : end;
        out.push({ start: i, end: stop, kind: "line", marker });
        i = end;
        continue outer;
      }
    }

    for (const rule of strings) {
      if (src.startsWith(rule.open, i)) {
        i = endOfString(src, i, rule);
        continue outer;
      }
    }

    i++;
  }
  return out;
}

/**
 * Counts the files that the grammar could not parse in full.
 *
 * A grammar in the pack is community work, so it can miss a recent construct. The parser then
 * builds an error node over the region. A comment inside that region is not reported. The count
 * says how much of a run carries that risk.
 */
let filesWithParseError = 0;

/** Parses text with a grammar. It returns null when the runtime rejects the text. */
function parseOrNull(grammar: Grammar, text: string, file: string): Tree | null {
  try {
    return grammar.parser.parse(text);
  }
  catch (error) {
    console.error(`scan: cannot parse ${file}: ${(error as Error).message}`);
    return null;
  }
}

/** Finds every comment in one file, with the engine that the language asks for. */
async function scanFile(src: string, def: LangDef, file: string): Promise<RawComment[] | null> {
  if (def.grammar === null) return scanLexical(src, def);

  const grammar = await grammarFor(def.grammar);
  if (grammar === null) return null;

  const tree = parseOrNull(grammar, src, file);
  if (tree === null) return null;
  if (tree.rootNode.hasError) filesWithParseError++;

  let out: RawComment[];
  let regions: Region[];
  try {
    out = scanTree(src, tree, def.lineMarkers, grammar.commentTypes);
    regions = def.embeds ? embeddedRegions(tree) : [];
  }
  finally {
    tree.delete();
  }

  for (const region of regions) {
    const sub = await grammarFor(region.grammar);
    if (sub === null) continue;
    const text = src.slice(region.start, region.end);
    const subTree = parseOrNull(sub, text, file);
    if (subTree === null) continue;
    try {
      for (const raw of scanTree(text, subTree, region.lineMarkers, sub.commentTypes)) {
        out.push({ ...raw, start: raw.start + region.start, end: raw.end + region.start });
      }
    }
    finally {
      subTree.delete();
    }
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

interface CommentRecord {
  id: string;
  file: string;
  language: string;
  /** The offset of the first character of the comment, or of the first one in a run. */
  startByte: number;
  /** The offset after the last character of the comment, or of the last one in a run. */
  endByte: number;
  kind: "line" | "block";
  /** The line marker, or the empty string for a block comment. */
  marker: string;
  /** Whether code shares the first line of the comment. */
  trailing: boolean;
  /** A short digest of the file this comment was read from. */
  sha: string;
  text: string;
  before: string;
  after: string;
}

/** Digests a file so a later pass can tell whether it still matches what the scan saw. */
function shaOf(src: string): string {
  return createHash("sha256").update(src).digest("hex").slice(0, 16);
}

/** What `recordsFor` needs to shape a record. */
interface RecordOptions {
  minChars: number;
  context: number;
  trailing: boolean;
}

/** Cuts a context line so one long line cannot dominate the output. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + "…";
}

/** Builds one record for every comment in one file. */
function recordsFor(rel: string, src: string, def: LangDef, raws: RawComment[], opts: RecordOptions, sha: string): CommentRecord[] {
  if (raws.length === 0) return [];

  // The offset of the first character of every line.
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);

  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // A copy of the source with every comment blanked out. It keeps each line break, so the
  // line offsets stay valid. What is left on a line is the code on that line.
  const codeChars = Array.from(src);
  for (const raw of raws) {
    for (let i = raw.start; i < raw.end; i++) if (codeChars[i] !== "\n") codeChars[i] = " ";
  }
  const code = codeChars.join("");

  const lineEnd = (index: number): number => {
    const next = lineStarts[index + 1];
    let end = next === undefined ? src.length : next - 1;
    if (end > lineStarts[index]! && src[end - 1] === "\r") end--;
    return end;
  };
  const codeOnLine = (index: number): string => code.slice(lineStarts[index]!, lineEnd(index)).trim();

  // Merges a run of own-line comments that use the same marker on back-to-back lines.
  interface Group {
    first: RawComment;
    last: RawComment;
    parts: RawComment[];
  }
  const groups: Group[] = [];
  for (const raw of raws) {
    const startLine = lineOf(raw.start);
    const ownLine = code.slice(lineStarts[startLine]!, raw.start).trim() === "";
    const previous = groups[groups.length - 1];
    const joinable =
      previous !== undefined &&
      raw.kind === "line" &&
      previous.last.kind === "line" &&
      previous.last.marker === raw.marker &&
      ownLine &&
      code.slice(lineStarts[lineOf(previous.first.start)]!, previous.first.start).trim() === "" &&
      lineOf(previous.last.start) + 1 === startLine;
    if (joinable) {
      previous.last = raw;
      previous.parts.push(raw);
    }
    else {
      groups.push({ first: raw, last: raw, parts: [raw] });
    }
  }

  const out: CommentRecord[] = [];
  for (const group of groups) {
    const startLine = lineOf(group.first.start);
    const endLine = lineOf(group.last.end);
    const column = group.first.start - lineStarts[startLine]! + 1;

    const codeBeforeOnLine = code.slice(lineStarts[startLine]!, group.first.start).trim();
    const isTrailing = codeBeforeOnLine !== "";
    if (isTrailing && !opts.trailing) continue;

    // One block comment keeps its own layout. A run of line comments joins with a line break,
    // so the indentation of the second line and later does not leak into the text.
    const text =
      group.parts.length === 1
        ? src.slice(group.first.start, group.first.end)
        : group.parts.map((p) => src.slice(p.start, p.end)).join("\n");
    if (text.length < opts.minChars) continue;

    let before = codeBeforeOnLine;
    if (before === "") {
      for (let i = startLine - 1; i >= 0; i--) {
        const candidate = codeOnLine(i);
        if (candidate !== "") {
          before = candidate;
          break;
        }
      }
    }

    let after = code.slice(group.last.end, lineEnd(endLine)).trim();
    if (after === "") {
      for (let i = endLine + 1; i < lineStarts.length; i++) {
        const candidate = codeOnLine(i);
        if (candidate !== "") {
          after = candidate;
          break;
        }
      }
    }

    out.push({
      id: `${rel}:${startLine + 1}:${column}`,
      file: rel,
      language: def.name,
      startByte: group.first.start,
      endByte: group.last.end,
      kind: group.first.kind,
      marker: group.first.marker,
      trailing: isTrailing,
      sha,
      text,
      before: clip(before, opts.context),
      after: clip(after, opts.context),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The file walk
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor", "dist", "build",
  "out", "target", ".gradle", ".idea", ".venv", "venv", "__pycache__", ".next", ".cache",
  "bazel-out", "coverage",
]);

/** Lists the tracked and untracked files of a Git work tree, or null when there is none. */
function gitFiles(root: string): string[] | null {
  try {
    const stdout = execFileSync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return stdout.split("\0").filter((p) => p !== "").map((p) => path.join(root, p));
  }
  catch {
    return null;
  }
}

/** Lists every file under a directory and skips the well known generated directories. */
function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      }
      else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Lists the candidate files for one root, which can be a file or a directory. */
function collect(root: string, useGit: boolean): string[] {
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const fromGit = useGit ? gitFiles(root) : null;
  return fromGit ?? walk(root);
}

/**
 * Picks the directory that every reported path is relative to. One base for the whole run keeps
 * an id unique, which a base for each root does not.
 */
function reportBase(roots: string[], override: string | null): string {
  if (override !== null) return path.resolve(override);

  const cwd = process.cwd();
  const dirs = roots.map((root) => {
    try {
      return fs.statSync(root).isFile() ? path.dirname(root) : root;
    }
    catch {
      return root;
    }
  });
  if (dirs.every((dir) => dir === cwd || dir.startsWith(cwd + path.sep))) return cwd;

  // No root sits under the working directory. Take the deepest shared parent.
  let shared = dirs[0]!.split(path.sep);
  for (const dir of dirs.slice(1)) {
    const parts = dir.split(path.sep);
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) i++;
    shared = shared.slice(0, i);
  }
  return shared.join(path.sep) || path.sep;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 5000;

/** Reads a source file, or returns null when the scanner must not read it. */
function readSource(file: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  }
  catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;

  let src: string;
  try {
    src = fs.readFileSync(file, "utf8");
  }
  catch {
    return null;
  }
  if (src.includes("\0")) return null; // The file is binary.
  for (const line of src.split("\n")) if (line.length > MAX_LINE) return null; // The file is minified.
  return src;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The library entry point
// ---------------------------------------------------------------------------

export type { CommentRecord };
export { shaOf };

/** Every language name the scanner accepts. */
export const LANGUAGE_NAMES: ReadonlySet<string> = NAMES;

/** Lists every language and the engine that reads it, one per line. */
export function languageList(): string {
  return LANGUAGES.map((l) => {
    const engine = l.grammar === null ? "lexer" : `tree-sitter/${l.grammar}`;
    const alias = l.id === l.name ? "" : ` (${l.id})`;
    return `${l.name}${alias}\t${engine}`;
  }).join("\n");
}

export interface ScanOptions {
  /** The files and directories to walk. */
  roots: string[];
  /** The directory every reported path is relative to. Null picks the default. */
  base?: string | null;
  /** Keep only these language names. Null keeps every one. */
  langs?: Set<string> | null;
  /** Drop a path that contains one of these substrings. */
  exclude?: string[];
  /** Drop a comment shorter than this. The default is 0. */
  minChars?: number;
  /** Cut `before` and `after` at this many characters. The default is 200. */
  context?: number;
  /** Keep a comment that shares its line with code. The default is true. */
  trailing?: boolean;
  /** Enumerate through `git ls-files` when the root is a work tree. The default is true. */
  git?: boolean;
}

export interface ScanStats {
  filesSeen: number;
  filesScanned: number;
  /** Files the runtime refused to parse. */
  filesFailed: number;
  /** Files the parser covered with at least one error node. */
  parseErrors: number;
  perLanguage: Map<string, number>;
}

export interface ScanOutcome {
  comments: CommentRecord[];
  stats: ScanStats;
}

/**
 * Scans every root and returns the comments in a stable order.
 *
 * It throws when a root cannot be read. Everything else it can survive it counts instead: an
 * unreadable file, a file the grammar rejects, a binary or minified file.
 */
export async function scan(options: ScanOptions): Promise<ScanOutcome> {
  const shape: RecordOptions = {
    minChars: options.minChars ?? 0,
    context: options.context ?? 200,
    trailing: options.trailing ?? true,
  };

  const langs = options.langs ?? null;
  const exclude = options.exclude ?? [];
  const useGit = options.git ?? true;

  const comments: CommentRecord[] = [];
  const perLanguage = new Map<string, number>();

  let filesSeen = 0;
  let filesScanned = 0;
  let filesFailed = 0;

  filesWithParseError = 0;

  const roots = options.roots.map((root) => path.resolve(root));
  const base = reportBase(roots, options.base ?? null);

  for (const root of roots) {
    for (const file of collect(root, useGit)) {
      filesSeen++;

      const rel = path.relative(base, file) || path.basename(file);
      if (exclude.some((part) => rel.includes(part))) continue;

      const def = languageOf(file);
      if (def === null) continue;
      if (langs !== null && !langs.has(def.name)) continue;

      const src = readSource(file);
      if (src === null) continue;

      const raws = await scanFile(src, def, rel);
      if (raws === null) {
        filesFailed++;
        continue;
      }

      filesScanned++;

      const found = recordsFor(rel, src, def, raws, shape, shaOf(src));
      comments.push(...found);

      if (found.length > 0) {
        perLanguage.set(def.name, (perLanguage.get(def.name) ?? 0) + found.length);
      }
    }
  }

  comments.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return Number(a.id.split(":")[1]) - Number(b.id.split(":")[1]);
  });

  return {
    comments,
    stats: {
      filesSeen,
      filesScanned,
      filesFailed,
      parseErrors: filesWithParseError,
      perLanguage,
    },
  };
}
