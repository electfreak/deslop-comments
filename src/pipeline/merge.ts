import type { CriticDecision, CriticResult } from "../transformer/run-critic.js";
import type { TransformDecision, TransformResult } from "../transformer/run-transformer.js";

export type MergedOutcome = "DELETE" | "REWRITE" | "UNCHANGED" | "REVIEW";

/** A piece of information the pipeline judged unnecessary, kept so the verdict can be read back. */
export interface DroppedInformation {
  text: string;
  reason: string;
}

export interface MergedDecision {
  id: string;
  outcome: MergedOutcome;
  /** Non-null exactly when the outcome is REWRITE. */
  replacement: string | null;
  decidedBy: "transformer" | "critic";
  reason: string | null;
  /**
   * What the two passes threw away to reach this verdict.
   *
   * The applier ignores it. It is the record of why a comment went, which is the one thing a
   * diff cannot show, and it is optional so a hand written verdict file need not carry it.
   */
  dropped?: DroppedInformation[];
}

/** Collects the propositions the transformer judged unnecessary. */
function droppedByTransformer(decision: TransformDecision): DroppedInformation[] {
  return decision.propositions
    .filter((proposition) => proposition.decision === "DELETE")
    .map((proposition) => ({
      text: proposition.text,
      reason: proposition.depends_on === null
        ? proposition.reason
        : `${proposition.reason} (subsumed by ${proposition.depends_on})`,
    }));
}

/** Collects what the critic cut from the transformer's proposal. */
function droppedByCritic(reviewed: CriticDecision): DroppedInformation[] {
  return reviewed.removed_information.map((text) => ({
    text,
    reason: reviewed.reason ?? "the critic judged it unnecessary",
  }));
}

/**
 * Reconciles the two passes into one verdict per comment.
 *
 * The critic never sees a comment the transformer deleted or sent to review, so those verdicts
 * stand unopposed. For the rest the critic has the last word: it accepts the transformer's
 * output, shrinks it further, deletes it, or asks for a human.
 *
 * A null critic result is a transformer-only run.
 */
export function mergeDecisions(
  transform: TransformResult,
  critic: CriticResult | null,
): MergedDecision[] {
  const criticById = new Map(
    (critic?.decisions ?? []).map((decision) => [decision.id, decision]),
  );

  const transformIds = new Set(transform.decisions.map((decision) => decision.id));

  for (const id of criticById.keys()) {
    if (!transformIds.has(id)) {
      throw new Error(`${id}: the critic returned a comment the transformer never saw`);
    }
  }

  const merged: MergedDecision[] = [];

  for (const decision of transform.decisions) {
    const reviewed = criticById.get(decision.id);

    if (decision.action === "DELETE" || decision.action === "REVIEW") {
      if (reviewed !== undefined) {
        throw new Error(
          `${decision.id}: the critic reviewed a comment the transformer marked ${decision.action}`,
        );
      }

      merged.push({
        id: decision.id,
        outcome: decision.action,
        replacement: null,
        decidedBy: "transformer",
        reason: decision.review_reason,
        dropped: droppedByTransformer(decision),
      });

      continue;
    }

    if (reviewed === undefined) {
      if (critic !== null) {
        throw new Error(`${decision.id}: no critic decision`);
      }

      merged.push({
        id: decision.id,
        outcome: decision.action === "KEEP" ? "UNCHANGED" : "REWRITE",
        replacement: decision.action === "KEEP" ? null : decision.replacement,
        decidedBy: "transformer",
        reason: null,
        dropped: droppedByTransformer(decision),
      });

      continue;
    }

    switch (reviewed.action) {
      case "ACCEPT": {
        merged.push({
          id: decision.id,
          outcome: decision.action === "KEEP" ? "UNCHANGED" : "REWRITE",
          replacement: decision.action === "KEEP" ? null : decision.replacement,
          decidedBy: "transformer",
          reason: null,
          dropped: droppedByTransformer(decision),
        });

        break;
      }

      case "DELETE": {
        merged.push({
          id: decision.id,
          outcome: "DELETE",
          replacement: null,
          decidedBy: "critic",
          reason: reviewed.reason,
          dropped: [...droppedByTransformer(decision), ...droppedByCritic(reviewed)],
        });

        break;
      }

      case "REWRITE": {
        merged.push({
          id: decision.id,
          outcome: "REWRITE",
          replacement: reviewed.replacement,
          decidedBy: "critic",
          reason: reviewed.reason,
          dropped: [...droppedByTransformer(decision), ...droppedByCritic(reviewed)],
        });

        break;
      }

      case "REVIEW": {
        merged.push({
          id: decision.id,
          outcome: "REVIEW",
          replacement: null,
          decidedBy: "critic",
          reason: reviewed.reason,
          dropped: [...droppedByTransformer(decision), ...droppedByCritic(reviewed)],
        });

        break;
      }
    }
  }

  for (const decision of merged) {
    if (decision.outcome === "REWRITE") {
      if (typeof decision.replacement !== "string" || decision.replacement.trim() === "") {
        throw new Error(`${decision.id}: REWRITE without a replacement`);
      }
    }
    else if (decision.replacement !== null) {
      throw new Error(`${decision.id}: ${decision.outcome} carries a replacement`);
    }
  }

  return merged;
}
