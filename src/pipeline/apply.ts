import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { applyEdits, editFor, type SourceComment, type TextEdit } from "./edits.js";
import type { MergedDecision } from "./merge.js";
import { shaOf, type ScanRecord } from "./report.js";

export interface PlannedEdit {
  id: string;
  outcome: "DELETE" | "REWRITE";
  decidedBy: MergedDecision["decidedBy"];
  edit: TextEdit;
}

export interface FilePlan {
  /** The path as the report states it. */
  file: string;
  absolute: string;
  source: string;
  edits: PlannedEdit[];
}

export interface Skipped {
  id: string;
  reason: string;
}

export interface ApplyPlan {
  files: FilePlan[];
  skipped: Skipped[];
}

/**
 * Works out every edit without touching a file.
 *
 * A file that changed since the scan is skipped whole: the offsets in the report describe a file
 * that no longer exists, and applying them would corrupt the one that does.
 */
export function planEdits(
  root: string,
  records: ScanRecord[],
  decisions: MergedDecision[],
): ApplyPlan {
  const byId = new Map(records.map((record) => [record.id, record]));
  const actionable = new Map<string, MergedDecision>();
  const skipped: Skipped[] = [];

  for (const decision of decisions) {
    if (decision.outcome === "UNCHANGED" || decision.outcome === "REVIEW") continue;

    if (!byId.has(decision.id)) {
      throw new Error(`${decision.id}: no scanned comment with this id`);
    }

    actionable.set(decision.id, decision);
  }

  const perFile = new Map<string, ScanRecord[]>();

  for (const record of records) {
    if (!actionable.has(record.id)) continue;

    const bucket = perFile.get(record.file);

    if (bucket === undefined) perFile.set(record.file, [record]);
    else bucket.push(record);
  }

  const files: FilePlan[] = [];

  for (const [file, group] of perFile) {
    const absolute = path.resolve(root, file);

    let source: string;

    try {
      source = readFileSync(absolute, "utf8");
    }
    catch (error) {
      for (const record of group) {
        skipped.push({ id: record.id, reason: `cannot read ${file}: ${(error as Error).message}` });
      }

      continue;
    }

    const expected = group[0]!.sha;

    if (shaOf(source) !== expected) {
      for (const record of group) {
        skipped.push({ id: record.id, reason: `${file} changed since the scan` });
      }

      continue;
    }

    const edits: PlannedEdit[] = [];

    for (const record of group) {
      const decision = actionable.get(record.id)!;
      const result = editFor(source, toSourceComment(record), decision.outcome as "DELETE" | "REWRITE", decision.replacement);

      if (!result.ok) {
        skipped.push({ id: record.id, reason: result.reason });
        continue;
      }

      edits.push({
        id: record.id,
        outcome: decision.outcome as "DELETE" | "REWRITE",
        decidedBy: decision.decidedBy,
        edit: result.edit,
      });
    }

    if (edits.length > 0) files.push({ file, absolute, source, edits });
  }

  return { files, skipped };
}

function toSourceComment(record: ScanRecord): SourceComment {
  return {
    id: record.id,
    file: record.file,
    startByte: record.startByte,
    endByte: record.endByte,
    kind: record.kind,
    marker: record.marker,
    trailing: record.trailing,
  };
}

/** Renders the plan the way a reviewer reads it: the lines that go, then the lines that arrive. */
export function previewOf(plan: ApplyPlan): string {
  const out: string[] = [];

  for (const file of plan.files) {
    for (const planned of [...file.edits].sort((a, b) => a.edit.start - b.edit.start)) {
      out.push(`${planned.id}  ${planned.outcome} (${planned.decidedBy})`);

      for (const line of lines(file.source.slice(planned.edit.start, planned.edit.end))) {
        out.push(`  - ${line}`);
      }

      for (const line of lines(planned.edit.text)) {
        out.push(`  + ${line}`);
      }

      out.push("");
    }
  }

  return out.join("\n");
}

function lines(text: string): string[] {
  const trimmed = text.replace(/\n$/, "");
  return trimmed === "" ? [] : trimmed.split("\n");
}

/** Writes every planned file. Returns the paths it wrote. */
export function writePlan(plan: ApplyPlan): string[] {
  const written: string[] = [];

  for (const file of plan.files) {
    let next: string;

    try {
      next = applyEdits(file.source, file.edits.map((planned) => planned.edit));
    }
    catch (error) {
      throw new Error(`${file.file}: ${(error as Error).message}`);
    }

    if (next === file.source) continue;

    writeFileSync(file.absolute, next);
    written.push(file.file);
  }

  return written;
}
