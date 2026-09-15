#!/usr/bin/env bun
/**
 * A comment scanner.
 *
 * It walks a source tree, finds every comment, and prints one JSON record for each one.
 * The output shape is:
 *
 *     { "comments": [ { id, file, language, startByte, endByte, kind, marker, trailing, sha,
 *                       text, before, after } ] }
 *
 * `startByte` and `endByte` span the whole comment, so a run of line comments is one span.
 * `sha` is a short digest of the file as it was read, which lets a later pass detect an edit.
 *
 * The scanning itself lives in `scanner.ts`. This file is the command line over it, so the
 * pipeline can scan in process and skip the report file entirely.
 *
 * The scanner parses. It uses tree-sitter through `web-tree-sitter`, and it takes most grammar
 * binaries from `tree-sitter-wasms`. A comment is a node in the parse tree, so a string, a
 * template, a regular expression and a nested block comment need no special rule. Svelte is not
 * in that pack, so its grammar comes from `@tree-sitter-grammars/tree-sitter-svelte`.
 *
 * Seven types have no grammar at all: shell, yaml, scss, sql, groovy, xml and properties.
 * For those the scanner falls back to a small lexical pass that knows the comment markers and
 * the string forms.
 *
 * Usage:
 *     bun scan.ts [root ...] [options]
 *
 * Options:
 *     --base <dir>        Report every path relative to this directory. The default is the
 *                         working directory, or the shared parent when no root sits under it.
 *     --out <file>        Write the JSON to a file. The default is stdout.
 *     --lang <names>      Keep only these languages. Use a comma to separate them.
 *     --exclude <parts>   Drop a path that contains one of these substrings.
 *     --min-chars <n>     Drop a comment shorter than n characters. The default is 0.
 *     --context <n>       Cut `before` and `after` at n characters. The default is 200.
 *     --no-trailing       Drop a comment that shares its line with code.
 *     --no-git            Walk the file system instead of `git ls-files`.
 *     --ndjson            Print one JSON record per line instead of one object.
 *     --stats             Print a summary to stderr.
 *     --languages         Print the supported languages and the engine of each one, then exit.
 *     --help              Print this help and exit.
 *
 * The environment variable TREE_SITTER_WASMS overrides the grammar directory of the pack. It
 * does not move the Svelte grammar, which is resolved from its own package.
 *
 * Known limits, on purpose:
 *   - A grammar in the pack is community work. It can lag behind the language. The parser is
 *     error tolerant, so a comment beside an unknown construct is still reported.
 *   - A `.h` file is read as C. A C++ header with a C++ only construct can produce a parse error.
 *   - In an HTML, Vue or Svelte file the `script` body is read as TypeScript and the `style` body
 *     as CSS. A block in another language, such as Sass, can produce a parse error.
 *   - The seven lexical types keep the limits of a lexer. A heredoc is not supported, and one
 *     language covers the whole file.
 *   - `before` and `after` are the nearest code lines, not the neighbouring declarations. The
 *     parse tree makes the second choice possible. Nobody asked for it yet.
 */

import * as fs from "node:fs";

import { LANGUAGE_NAMES, languageList, scan, type ScanOptions } from "./scanner.ts";

interface Options extends ScanOptions {
  out: string | null;
  ndjson: boolean;
  stats: boolean;
}

function help(): string {
  const source = fs.readFileSync(new URL(import.meta.url), "utf8");
  const doc = source.slice(source.indexOf("/**"), source.indexOf("*/") + 2);
  return doc.replace(/^\/\*\*\n?/, "").replace(/\n? \*\/$/, "").replace(/^ \* ?/gm, "").trim();
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    roots: [],
    base: null,
    out: null,
    langs: null,
    exclude: [],
    minChars: 0,
    context: 200,
    trailing: true,
    git: true,
    ndjson: false,
    stats: false,
  };

  const next = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help": case "-h":
        console.log(help());
        process.exit(0);
      case "--languages":
        console.log(languageList());
        process.exit(0);
      case "--base":
        opts.base = next(i, arg); i++; break;
      case "--out":
        opts.out = next(i, arg); i++; break;
      case "--lang":
        opts.langs ??= new Set();
        for (const name of next(i, arg).split(",")) opts.langs.add(name.trim());
        i++; break;
      case "--exclude":
        opts.exclude!.push(...next(i, arg).split(",").map((s) => s.trim()).filter(Boolean));
        i++; break;
      case "--min-chars":
        opts.minChars = Number(next(i, arg)); i++; break;
      case "--context":
        opts.context = Number(next(i, arg)); i++; break;
      case "--no-trailing": opts.trailing = false; break;
      case "--no-git": opts.git = false; break;
      case "--ndjson": opts.ndjson = true; break;
      case "--stats": opts.stats = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        opts.roots.push(arg);
    }
  }

  if (opts.roots.length === 0) opts.roots.push(".");
  if (opts.langs != null) {
    for (const name of opts.langs) {
      if (!LANGUAGE_NAMES.has(name)) throw new Error(`unknown language: ${name}. Use --languages.`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  }
  catch (error) {
    console.error(`scan: ${(error as Error).message}`);
    process.exit(2);
  }

  let comments;
  let stats;
  try {
    ({ comments, stats } = await scan(opts));
  }
  catch (error) {
    console.error(`scan: ${(error as Error).message}`);
    process.exit(1);
  }

  const text = opts.ndjson
    ? comments.map((r) => JSON.stringify(r)).join("\n") + (comments.length > 0 ? "\n" : "")
    : JSON.stringify({ comments }, null, 2) + "\n";

  if (opts.out === null) process.stdout.write(text);
  else fs.writeFileSync(opts.out, text);

  if (opts.stats) {
    console.error(`files seen: ${stats.filesSeen}`);
    console.error(`files scanned: ${stats.filesScanned}`);
    if (stats.filesFailed > 0) console.error(`files failed: ${stats.filesFailed}`);
    if (stats.parseErrors > 0) console.error(`files with a parse error: ${stats.parseErrors}`);
    console.error(`comments: ${comments.length}`);
    for (const [name, count] of [...stats.perLanguage].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${name}: ${count}`);
    }
  }
}

await main();
