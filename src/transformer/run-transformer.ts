import { fileURLToPath } from "node:url";

import { runClaudeStructured } from "./claude.js";

const PROMPT_PATH = fileURLToPath(
  new URL("../prompts/transform.md", import.meta.url),
);

const SCHEMA_PATH = fileURLToPath(
  new URL("../schemas/transform.schema.json", import.meta.url),
);

export interface CommentCandidate {
  id: string;
  file: string;
  language: string;

  text: string;

  startByte: number;
  endByte: number;

  context: {
    before?: string;
    after?: string;
    container?: string;
  };
}

export type PropositionDecision = "KEEP" | "DELETE";

export interface Proposition {
  id: string;
  text: string;
  decision: PropositionDecision;
  reason: string;
  depends_on: string | null;
}

export type TransformAction =
  | "DELETE"
  | "REWRITE"
  | "KEEP"
  | "REVIEW";

export interface TransformDecision {
  id: string;
  action: TransformAction;

  propositions: Proposition[];
  surviving_propositions: string[];

  replacement: string | null;
  review_reason: string | null;
}

export interface TransformResult {
  decisions: TransformDecision[];
}

export interface RunTransformerOptions {
  model?: string;
  maxTokens?: number;
}

export async function runTransformer(
  comments: CommentCandidate[],
  options: RunTransformerOptions = {},
): Promise<TransformResult> {
  if (comments.length === 0) {
    return { decisions: [] };
  }

  const input = {
    comments: comments.map((comment) => ({
      id: comment.id,
      file: comment.file,
      language: comment.language,
      comment: comment.text,
      context: comment.context,
    })),
  };

  const result = await runClaudeStructured<TransformResult>({
    systemPromptPath: PROMPT_PATH,
    schemaPath: SCHEMA_PATH,
    input,
    model: options.model ?? "sonnet",
    maxTokens: options.maxTokens,
  });

  validateResult(comments, result);

  return result;
}

function validateResult(
  input: CommentCandidate[],
  result: TransformResult,
): void {
  const expectedIds = new Set(input.map((comment) => comment.id));
  const receivedIds = new Set<string>();

  if (!Array.isArray(result.decisions)) {
    throw new Error("Transformer output has no decisions array.");
  }

  for (const decision of result.decisions) {
    if (!expectedIds.has(decision.id)) {
      throw new Error(
        `Transformer returned unknown comment id: ${decision.id}`,
      );
    }

    if (receivedIds.has(decision.id)) {
      throw new Error(
        `Transformer returned duplicate decision for: ${decision.id}`,
      );
    }

    receivedIds.add(decision.id);

    switch (decision.action) {
      case "DELETE":
      case "KEEP": {
        if (decision.replacement !== null) {
          throw new Error(
            `${decision.id}: ${decision.action} must have replacement=null`,
          );
        }

        if (decision.review_reason !== null) {
          throw new Error(
            `${decision.id}: ${decision.action} must have review_reason=null`,
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

        if (decision.review_reason !== null) {
          throw new Error(
            `${decision.id}: REWRITE must have review_reason=null`,
          );
        }

        break;
      }

      case "REVIEW": {
        if (decision.replacement !== null) {
          throw new Error(
            `${decision.id}: REVIEW must have replacement=null`,
          );
        }

        if (
          typeof decision.review_reason !== "string" ||
          decision.review_reason.trim() === ""
        ) {
          throw new Error(
            `${decision.id}: REVIEW requires review_reason`,
          );
        }

        break;
      }
    }

    const propositionIds = new Set<string>();

    for (const proposition of decision.propositions) {
      if (propositionIds.has(proposition.id)) {
        throw new Error(
          `${decision.id}: duplicate proposition id ${proposition.id}`,
        );
      }

      propositionIds.add(proposition.id);
    }

    for (const proposition of decision.propositions) {
      if (
        proposition.depends_on !== null &&
        !propositionIds.has(proposition.depends_on)
      ) {
        throw new Error(
          `${decision.id}: proposition ${proposition.id} depends on unknown proposition ${proposition.depends_on}`,
        );
      }
    }
  }

  for (const id of expectedIds) {
    if (!receivedIds.has(id)) {
      throw new Error(
        `Transformer returned no decision for comment: ${id}`,
      );
    }
  }
}