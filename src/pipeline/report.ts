import { readFileSync } from "node:fs";

import type { CommentRecord } from "../scanner/scanner.js";

export { shaOf } from "../scanner/scanner.js";

/** One record as the scanner produces it. */
export type ScanRecord = CommentRecord;

/** Reads a scan report, either the JSON object or the NDJSON form. */
export function readScanReport(path: string): ScanRecord[] {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  const trimmed = raw.trim();

  if (trimmed === "") return [];

  const records = trimmed.startsWith("{\n") || trimmed.startsWith('{"comments"')
    ? parseObject(trimmed, path)
    : trimmed.split("\n").map((line, index) => parseLine(line, path, index));

  records.forEach((record, index) => validate(record, path, index));

  return records as ScanRecord[];
}

function parseObject(text: string, path: string): unknown[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  }
  catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }

  const comments = (parsed as { comments?: unknown }).comments;

  if (!Array.isArray(comments)) {
    throw new Error(`${path} has no comments array.`);
  }

  return comments;
}

function parseLine(line: string, path: string, index: number): unknown {
  try {
    return JSON.parse(line);
  }
  catch (error) {
    throw new Error(`${path} line ${index + 1} is not valid JSON: ${(error as Error).message}`);
  }
}

const REQUIRED = ["id", "file", "language", "text", "before", "after"] as const;
const POSITIONAL = ["startByte", "endByte", "kind", "marker", "trailing", "sha"] as const;

function validate(record: unknown, path: string, index: number): void {
  const where = `${path} record ${index + 1}`;

  if (typeof record !== "object" || record === null) {
    throw new Error(`${where} is not an object.`);
  }

  const fields = record as Record<string, unknown>;

  for (const key of REQUIRED) {
    if (typeof fields[key] !== "string") {
      throw new Error(`${where} has no ${key}.`);
    }
  }

  for (const key of POSITIONAL) {
    if (fields[key] === undefined) {
      throw new Error(
        `${where} has no ${key}. The report predates the offsets the applier needs, so run the scanner again.`,
      );
    }
  }

  if (typeof fields.startByte !== "number" || typeof fields.endByte !== "number") {
    throw new Error(`${where} has a non-numeric span.`);
  }

  if (fields.kind !== "line" && fields.kind !== "block") {
    throw new Error(`${where} has an unknown kind: ${String(fields.kind)}`);
  }

  if (typeof fields.trailing !== "boolean" || typeof fields.sha !== "string") {
    throw new Error(`${where} has a malformed trailing flag or sha.`);
  }
}
