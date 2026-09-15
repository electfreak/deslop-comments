import { fileURLToPath } from "node:url";

import { runClaudeStructured } from "./claude.js";
import type {
  CommentCandidate,
  TransformDecision,
} from "./run-transformer.js";

const PROMPT_PATH = fileURLToPath(
  new URL("../prompts/critic.md", import.meta.url),
);

const SCHEMA_PATH = fileURLToPath(
  new URL("../schemas/critic.schema.json", import.meta.url),
);

export type CriticAction =
  | "ACCEPT"
  | "DELETE"
  | "REWRITE"
  | "REVIEW";

export interface CriticDecision {
  id: string;
  action: CriticAction;

  replacement: string | null;
  removed_information: string[];
  reason: string | null;
}

export interface CriticResult {
  decisions: CriticDecision[];
}

export interface CriticCandidate {
  id: string;
  file: string;
  language: string;

  originalComment: string;
  proposedComment: string;

  context: {
    before?: string;
    after?: string;
    container?: string;
  };

  survivingPropositions: string[];
}

export interface RunCriticOptions {
  model?: string;
  maxTokens?: number;
}

export function makeCriticCandidates(
  comments: CommentCandidate[],
  transform: TransformDecision[],
): CriticCandidate[] {
  const commentsById = new Map(
    comments.map((comment) => [comment.id, comment]),
  );

  const candidates: CriticCandidate[] = [];

  for (const decision of transform) {
    /*
     * DELETE has no remaining comment to challenge.
     * REVIEW has deliberately been deferred for manual/extended analysis.
     */
    if (
      decision.action === "DELETE" ||
      decision.action === "REVIEW"
    ) {
      continue;
    }

    const comment = commentsById.get(decision.id);

    if (!comment) {
      throw new Error(
        `Cannot build critic input for unknown comment: ${decision.id}`,
      );
    }

    const proposedComment =
      decision.action === "REWRITE"
        ? decision.replacement
        : comment.text;

    if (!proposedComment) {
      throw new Error(
        `${decision.id}: no proposed comment available for critic`,
      );
    }

    candidates.push({
      id: decision.id,
      file: comment.file,
      language: comment.language,

      originalComment: comment.text,
      proposedComment,

      context: comment.context,

      survivingPropositions:
        decision.surviving_propositions,
    });
  }

  return candidates;
}

export async function runCritic(
  candidates: CriticCandidate[],
  options: RunCriticOptions = {},
): Promise<CriticResult> {
  if (candidates.length === 0) {
    return { decisions: [] };
  }

  const input = {
    comments: candidates.map((candidate) => ({
      id: candidate.id,
      file: candidate.file,
      language: candidate.language,

      original_comment: candidate.originalComment,
      proposed_comment: candidate.proposedComment,

      surviving_propositions:
        candidate.survivingPropositions,

      context: candidate.context,
    })),
  };

  const result = await runClaudeStructured<CriticResult>({
    systemPromptPath: PROMPT_PATH,
    schemaPath: SCHEMA_PATH,
    input,
    model: options.model ?? "sonnet",
    maxTokens: options.maxTokens,
  });

  validateResult(candidates, result);

  return result;
}

function validateResult(
  input: CriticCandidate[],
  result: CriticResult,
): void {
  const expectedIds = new Set(
    input.map((candidate) => candidate.id),
  );

  const receivedIds = new Set<string>();

  if (!Array.isArray(result.decisions)) {
    throw new Error("Critic output has no decisions array.");
  }

  for (const decision of result.decisions) {
    if (!expectedIds.has(decision.id)) {
      throw new Error(
        `Critic returned unknown comment id: ${decision.id}`,
      );
    }

    if (receivedIds.has(decision.id)) {
      throw new Error(
        `Critic returned duplicate decision for: ${decision.id}`,
      );
    }

    receivedIds.add(decision.id);

    switch (decision.action) {
      case "ACCEPT": {
        if (decision.replacement !== null) {
          throw new Error(
            `${decision.id}: ACCEPT must have replacement=null`,
          );
        }

        break;
      }

      case "DELETE": {
        if (decision.replacement !== null) {
          throw new Error(
            `${decision.id}: DELETE must have replacement=null`,
          );
        }

        break;
      }

      case "REWRITE": {
        if (
          typeof decision.replacement !== "string" ||
          decision.replacement.trim() === ""
        ) {
          throw new Error(
            `${decision.id}: REWRITE requires a non-empty replacement`,
          );
        }

        break;
      }

      case "REVIEW": {
        if (
          typeof decision.reason !== "string" ||
          decision.reason.trim() === ""
        ) {
          throw new Error(
            `${decision.id}: REVIEW requires a reason`,
          );
        }

        if (decision.replacement !== null) {
          throw new Error(
            `${decision.id}: REVIEW must have replacement=null`,
          );
        }

        break;
      }
    }
  }

  for (const id of expectedIds) {
    if (!receivedIds.has(id)) {
      throw new Error(
        `Critic returned no decision for comment: ${id}`,
      );
    }
  }
}
