import { readFileSync } from "node:fs";

import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  RateLimitError,
} from "@anthropic-ai/sdk";

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
};

const DEFAULT_MODEL = "sonnet";

/*
 * Adaptive thinking spends from this same budget, and a batch of long comments asks for an
 * analysis several times the size of its input. Sonnet 5 allows 128k, and 64k is the API's own
 * default for a streaming request, which is what this module makes.
 */
const DEFAULT_MAX_TOKENS = 64_000;

const DEFAULT_EFFORT = "high";

/*
 * The SDK retries the request that opens a stream, but not a stream that dies once it is open.
 * A response long enough to need minutes is the one that gets cut, so retry it here.
 */
const STREAM_ATTEMPTS = 2;

// Structured outputs reject these JSON Schema keywords.
const STRIPPED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RunClaudeStructuredOptions {
  systemPromptPath: string;
  schemaPath: string;

  input: unknown;

  model?: string;
  maxTokens?: number;
  effort?: Effort;

  client?: Anthropic;
}

export interface JsonSchemaObject {
  [key: string]: unknown;
}

export async function runClaudeStructured<T>(
  options: RunClaudeStructuredOptions,
): Promise<T> {
  const model = resolveModel(options.model ?? DEFAULT_MODEL);
  const systemPrompt = readTextFile(options.systemPromptPath);
  const schema = sanitizeSchema(readJsonFile(options.schemaPath));

  if (options.client === undefined && !hasCredentials()) {
    throw new Error(
      "No Anthropic credentials found. Export ANTHROPIC_API_KEY=sk-ant-..., or set " +
        "ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL to go through a gateway.",
    );
  }

  const client = options.client ?? new Anthropic();

  const send = () =>
    client.messages.stream({
      model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: thinkingFor(model),
      output_config: {
        effort: options.effort ?? DEFAULT_EFFORT,
        format: {
          type: "json_schema",
          schema,
        },
      },
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: JSON.stringify(options.input),
        },
      ],
    }).finalMessage();

  let message;

  for (let attempt = 1; ; attempt++) {
    try {
      message = await send();
      break;
    } catch (error) {
      if (attempt < STREAM_ATTEMPTS && isTruncatedStream(error)) {
        continue;
      }

      throw describeApiError(error, model);
    }
  }

  if (message.stop_reason === "refusal") {
    const details = message.stop_details;

    throw new Error(
      [
        `${model} refused the request`,
        details?.category ? ` (${details.category})` : "",
        details?.explanation ? `: ${details.explanation}` : ".",
      ].join(""),
    );
  }

  if (message.stop_reason === "max_tokens") {
    throw new Error(
      `${model} hit max_tokens before completing the structured response. Retry with a larger --max-tokens or a smaller --batch-size.`,
    );
  }

  return parseJson<T>(collectText(message.content), model);
}

// The SDK resolves credentials from any of these; a gateway may authenticate the
// request itself and need no client-side secret at all.
function hasCredentials(): boolean {
  return (
    (process.env.ANTHROPIC_API_KEY ?? "") !== "" ||
    (process.env.ANTHROPIC_AUTH_TOKEN ?? "") !== "" ||
    (process.env.ANTHROPIC_BASE_URL ?? "") !== ""
  );
}

function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

function thinkingFor(model: string) {
  // Haiku 4.5 predates adaptive thinking.
  if (model.startsWith("claude-haiku-4-5")) {
    return { type: "enabled", budget_tokens: 4_000 } as const;
  }

  return { type: "adaptive" } as const;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${messageOf(error)}`);
  }
}

function readJsonFile(path: string): JsonSchemaObject {
  const raw = readTextFile(path);

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${messageOf(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON Schema object.`);
  }

  return parsed as JsonSchemaObject;
}

function sanitizeSchema(schema: JsonSchemaObject): JsonSchemaObject {
  return stripKeywords(schema) as JsonSchemaObject;
}

function stripKeywords(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripKeywords);
  }

  if (typeof node !== "object" || node === null) {
    return node;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }

    result[key] = stripKeywords(value);
  }

  return result;
}

function collectText(content: Array<{ type: string }>): string {
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join("");

  if (text.trim() === "") {
    throw new Error("Model returned no text content.");
  }

  return text;
}

function parseJson<T>(text: string, model: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `${model} returned output that is not valid JSON (${messageOf(error)}): ${truncate(text)}`,
    );
  }
}

function describeApiError(error: unknown, model: string): Error {
  if (error instanceof BadRequestError) {
    return new Error(
      `${model} rejected the request (400). Usually an unsupported JSON Schema keyword or an oversized batch: ${error.message}`,
    );
  }

  if (error instanceof AuthenticationError) {
    return new Error(
      `Authentication failed (401). Set ANTHROPIC_API_KEY or configure a credential profile: ${error.message}`,
    );
  }

  if (error instanceof RateLimitError) {
    return new Error(`Rate limited (429) after retries: ${error.message}`);
  }

  if (error instanceof APIConnectionError) {
    return new Error(`Could not reach the Claude API: ${error.message}`);
  }

  if (error instanceof APIError) {
    return new Error(`Claude API error (${error.status ?? "unknown"}): ${error.message}`);
  }

  // Everything above carries a status, so what is left failed client-side, usually the stream.
  if (error instanceof AnthropicError) {
    return new Error(`The response stream from ${model} failed: ${error.message}`);
  }

  return error instanceof Error ? error : new Error(String(error));
}

/*
 * The SDK assembles the message from the stream and throws a plain `AnthropicError` when the
 * stream closed before a whole one arrived. Nothing was returned, so sending it again is safe.
 */
function isTruncatedStream(error: unknown): boolean {
  return (
    error instanceof AnthropicError &&
    !(error instanceof APIError) &&
    error.message.includes("without producing a Message")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, limit = 400): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}
