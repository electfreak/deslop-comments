#!/usr/bin/env bun
/**
 * The pipeline.
 *
 * It scans a source tree, sends every comment through the transformer and then the critic,
 * reconciles the two verdicts, and edits the source.
 *
 * Usage:
 *     bun src/pipeline/run.ts <path ...> [options]
 *     bun src/pipeline/run.ts --report report.json [options]
 *
 * Judging costs money and takes minutes: it is two model requests per batch. So every judging
 * run saves what it decided under `.deslop`, and `--replay` applies that again for free.
 *
 *     bun src/pipeline/run.ts src/              # judge, print, save the verdicts
 *     bun src/pipeline/run.ts --replay --write  # apply exactly what you just read
 *
 * Reviewing belongs in `git diff`, so the usual run is one command with `--write` on a clean
 * work tree.
 *
 * Options:
 *     --write             Edit the files. Without it the run only prints what it would do.
 *     --report <file>     Judge an existing scan report instead of scanning. `-` reads stdin.
 *     --apply <file>      Apply verdicts from an earlier run instead of calling the model.
 *     --replay            Shorthand for the report and the verdicts under the artifact
 *                         directory, so a run that was already paid for is applied as it was.
 *     --artifacts <dir>   Where to save the report and the verdicts of a judging run.
 *                         The default is `.deslop`.
 *     --no-artifacts      Save nothing. The reasoning is then lost with the terminal.
 *     --root <dir>        Resolve a reported path against this directory. The default is the
 *                         working directory.
 *     --model <name>      opus, sonnet, haiku, fable, or a full model id. The default is sonnet.
 *     --batch-size <n>    Comments per request. The default is 40.
 *     --max-tokens <n>    Output budget per request, shared with thinking. The default is
 *                         64000. Raise it when a batch hits the limit; sonnet allows 128000.
 *     --concurrency <n>   Requests in flight. The default is 4.
 *     --only <part>       Keep a comment whose path contains this substring. Repeatable.
 *     --lang <names>      Scan only these languages. Use a comma to separate them.
 *     --exclude <parts>   Skip a path that contains one of these substrings.
 *     --min-chars <n>     Skip a comment shorter than n characters. The default is 0.
 *     --no-git            Walk the file system instead of `git ls-files`.
 *     --no-critic         Run the transformer alone.
 *     --quiet             Print the summary but not the preview.
 *     --help              Print this help and exit.
 *
 * A file that changed since the scan is skipped, because the offsets no longer describe it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scan } from "../scanner/scanner.js";
import { makeCriticCandidates, runCritic } from "../transformer/run-critic.js";
import { runTransformer, type CommentCandidate } from "../transformer/run-transformer.js";
import { planEdits, previewOf, writePlan } from "./apply.js";
import { mergeDecisions, type MergedDecision } from "./merge.js";
import { readScanReport, type ScanRecord } from "./report.js";

interface Options {
  /** What to scan. Empty when a report is read instead. */
  roots: string[];
  report: string | null;
  apply: string | null;
  /** Where a judging run saves its report and verdicts. Null saves nothing. */
  artifacts: string | null;
  write: boolean;
  root: string;
  model: string;
  batchSize: number;
  /** Null leaves the transformer's own default in place. */
  maxTokens: number | null;
  concurrency: number;
  only: string[];
  langs: Set<string> | null;
  exclude: string[];
  minChars: number;
  git: boolean;
  critic: boolean;
  quiet: boolean;
}

const DEFAULT_ARTIFACTS = ".deslop";

function help(): string {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const doc = source.slice(source.indexOf("/**"), source.indexOf("*/") + 2);
  return doc.replace(/^\/\*\*\n?/, "").replace(/\n? \*\/$/, "").replace(/^ \* ?/gm, "").trim();
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    roots: [],
    report: null,
    apply: null,
    artifacts: DEFAULT_ARTIFACTS,
    write: false,
    root: process.cwd(),
    model: "sonnet",
    batchSize: 40,
    maxTokens: null,
    concurrency: 4,
    only: [],
    langs: null,
    exclude: [],
    minChars: 0,
    git: true,
    critic: true,
    quiet: false,
  };

  let replay = false;

  const next = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  const count = (i: number, flag: string): number => {
    const value = Number(next(i, flag));
    if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} needs a positive integer`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    switch (arg) {
      case "--help": case "-h":
        console.log(help());
        process.exit(0);
      case "--write": opts.write = true; break;
      case "--no-critic": opts.critic = false; break;
      case "--no-git": opts.git = false; break;
      case "--min-chars": opts.minChars = count(i, arg); i++; break;
      case "--no-artifacts": opts.artifacts = null; break;
      case "--replay": replay = true; break;
      case "--quiet": opts.quiet = true; break;
      case "--root": opts.root = next(i, arg); i++; break;
      case "--model": opts.model = next(i, arg); i++; break;
      case "--batch-size": opts.batchSize = count(i, arg); i++; break;
      case "--max-tokens": opts.maxTokens = count(i, arg); i++; break;
      case "--concurrency": opts.concurrency = count(i, arg); i++; break;
      case "--only": opts.only.push(next(i, arg)); i++; break;
      case "--report": opts.report = next(i, arg); i++; break;
      case "--apply": opts.apply = next(i, arg); i++; break;
      case "--artifacts": opts.artifacts = next(i, arg); i++; break;
      case "--lang":
        opts.langs ??= new Set();
        for (const name of next(i, arg).split(",")) opts.langs.add(name.trim());
        i++; break;
      case "--exclude":
        opts.exclude.push(...next(i, arg).split(",").map((s) => s.trim()).filter(Boolean));
        i++; break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        opts.roots.push(arg);
    }
  }

  if (replay) {
    const dir = opts.artifacts ?? DEFAULT_ARTIFACTS;
    opts.report ??= join(dir, "report.json");
    opts.apply ??= join(dir, "verdicts.json");
  }

  if (opts.roots.length > 0 && opts.report !== null) {
    throw new Error("pass paths to scan or a report to read, not both");
  }

  if (opts.roots.length === 0 && opts.report === null) {
    throw new Error("nothing to do. Pass a path to scan, or --report, or --replay.");
  }

  return opts;
}

/** Scans, or reads a report the scanner already wrote. */
async function collectRecords(opts: Options): Promise<ScanRecord[]> {
  if (opts.report !== null) return readScanReport(opts.report);

  const { comments, stats } = await scan({
    roots: opts.roots,
    base: opts.root,
    langs: opts.langs,
    exclude: opts.exclude,
    minChars: opts.minChars,
    git: opts.git,
  });

  process.stderr.write(
    `scanned ${stats.filesScanned} files, found ${comments.length} comments\n`,
  );

  return comments;
}

function candidateOf(record: ScanRecord): CommentCandidate {
  return {
    id: record.id,
    file: record.file,
    language: record.language,
    text: record.text,
    startByte: record.startByte,
    endByte: record.endByte,
    context: { before: record.before, after: record.after },
  };
}

/** Groups by file, then cuts a long file into batches, so one request holds related comments. */
function batchesOf(records: ScanRecord[], size: number): ScanRecord[][] {
  const perFile = new Map<string, ScanRecord[]>();

  for (const record of records) {
    const bucket = perFile.get(record.file);
    if (bucket === undefined) perFile.set(record.file, [record]);
    else bucket.push(record);
  }

  const batches: ScanRecord[][] = [];

  for (const group of perFile.values()) {
    for (let i = 0; i < group.length; i += size) {
      batches.push(group.slice(i, i + size));
    }
  }

  return batches;
}

async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
}

interface Failure {
  file: string;
  ids: number;
  message: string;
}

async function decide(records: ScanRecord[], opts: Options): Promise<{
  decisions: MergedDecision[];
  failures: Failure[];
}> {
  const batches = batchesOf(records, opts.batchSize);
  const decisions: MergedDecision[] = [];
  const failures: Failure[] = [];
  let done = 0;

  await pool(batches, opts.concurrency, async (batch) => {
    const file = batch[0]!.file;
    const comments = batch.map(candidateOf);

    try {
      const budget = opts.maxTokens ?? undefined;

      const transform = await runTransformer(comments, {
        model: opts.model,
        maxTokens: budget,
      });

      const critic = opts.critic
        ? await runCritic(makeCriticCandidates(comments, transform.decisions), {
            model: opts.model,
            maxTokens: budget,
          })
        : null;

      decisions.push(...mergeDecisions(transform, critic));
    }
    catch (error) {
      failures.push({ file, ids: batch.length, message: (error as Error).message });
    }

    done++;
    process.stderr.write(`[${done}/${batches.length}] ${file} (${batch.length})\n`);
  });

  return { decisions, failures };
}

function loadDecisions(path: string): MergedDecision[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const decisions = (parsed as { decisions?: unknown }).decisions;

  if (!Array.isArray(decisions)) {
    throw new Error(`${path} has no decisions array.`);
  }

  return decisions as MergedDecision[];
}

async function main(): Promise<void> {
  let opts: Options;

  try {
    opts = parseArgs(process.argv.slice(2));
  }
  catch (error) {
    console.error(`run: ${(error as Error).message}`);
    process.exit(2);
  }

  let records: ScanRecord[];

  try {
    records = await collectRecords(opts);
  }
  catch (error) {
    console.error(`run: ${(error as Error).message}`);
    process.exit(1);
  }

  if (opts.only.length > 0) {
    records = records.filter((record) => opts.only.some((part) => record.file.includes(part)));
  }

  if (records.length === 0) {
    console.error("run: no comments to consider.");
    return;
  }

  let decisions: MergedDecision[];
  let failures: Failure[] = [];

  if (opts.apply !== null) {
    try {
      decisions = loadDecisions(opts.apply);
    }
    catch (error) {
      console.error(`run: ${(error as Error).message}`);
      process.exit(1);
    }

    const known = new Set(records.map((record) => record.id));
    decisions = decisions.filter((decision) => known.has(decision.id));
  }
  else {
    const outcome = await decide(records, opts);
    decisions = outcome.decisions;
    failures = outcome.failures;
  }

  if (opts.artifacts !== null && opts.apply === null) {
    const dir = opts.artifacts;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.json"), `${JSON.stringify({ comments: records }, null, 2)}\n`);
    writeFileSync(join(dir, "verdicts.json"), `${JSON.stringify({ decisions }, null, 2)}\n`);
    console.error(`saved: ${join(dir, "verdicts.json")}`);
  }

  const plan = planEdits(opts.root, records, decisions);

  if (!opts.quiet) {
    const preview = previewOf(plan);
    if (preview.trim() !== "") process.stdout.write(`${preview}\n`);
  }

  const reviews = decisions.filter((decision) => decision.outcome === "REVIEW");

  if (reviews.length > 0) {
    process.stdout.write("review:\n");
    for (const decision of reviews) {
      process.stdout.write(`  ${decision.id}: ${decision.reason ?? "no reason given"}\n`);
    }
  }

  const deleted = plan.files.reduce(
    (total, file) => total + file.edits.filter((edit) => edit.outcome === "DELETE").length,
    0,
  );
  const rewritten = plan.files.reduce(
    (total, file) => total + file.edits.filter((edit) => edit.outcome === "REWRITE").length,
    0,
  );

  console.error(`comments considered: ${records.length}`);
  console.error(`decided: ${decisions.length}`);
  console.error(`to delete: ${deleted}`);
  console.error(`to rewrite: ${rewritten}`);
  console.error(`to review: ${reviews.length}`);

  if (plan.skipped.length > 0) {
    console.error(`skipped: ${plan.skipped.length}`);
    for (const skip of plan.skipped) console.error(`  ${skip.id}: ${skip.reason}`);
  }

  if (failures.length > 0) {
    console.error(`failed batches: ${failures.length}`);
    for (const failure of failures) {
      console.error(`  ${failure.file} (${failure.ids} comments): ${failure.message}`);
    }
  }

  if (opts.write) {
    const written = writePlan(plan);
    console.error(`files written: ${written.length}`);
    for (const file of written) console.error(`  ${file}`);
  }
  else if (plan.files.length > 0) {
    console.error(
      opts.artifacts !== null && opts.apply === null
        ? `nothing written. Apply exactly this with: --replay --write`
        : "nothing written. Pass --write to edit the files.",
    );
  }

  if (failures.length > 0) process.exitCode = 1;
}

await main();
