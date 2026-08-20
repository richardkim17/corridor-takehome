import { z } from "zod";
import { FACT_DEFINITIONS, type FactDataType } from "../config/facts.mjs";
import type { Meeting } from "../lib/types.mjs";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:14b";

export interface ExtractedFact {
  fact_key: string;
  value: unknown; // JSON-serializable, shape depends on the fact's data_type
  quote: string;
}

export interface ExtractionResult {
  clientName: string;
  facts: ExtractedFact[];
}

/**
 * The response schema splits facts into two buckets, keyed generically off
 * each fact's declared data_type (config/facts.mts) — not hardcoded to any
 * specific fact name:
 *
 *   - "scalar" facts (number/money/date/string): value is always requested
 *     as a JSON string. Smaller local models are unreliable at emitting a
 *     genuinely untyped/polymorphic field (see below) — string is the one
 *     shape Ollama's grammar-constrained decoding renders reliably, and the
 *     zod coercion in VALUE_SCHEMAS already accepts string input for every
 *     scalar type.
 *   - "list" facts (plan_list): get their own explicitly-typed array field,
 *     because giving the model an `anyOf: [string, array]` choice for a
 *     naturally list-shaped fact tends to make a 14B model pick the easier
 *     string branch instead of the structured one — observed directly while
 *     building this (see DESIGN.md §4.2).
 */
const SCALAR_FACT_DEFS = FACT_DEFINITIONS.filter((f) => f.data_type !== "plan_list");
const LIST_FACT_DEFS = FACT_DEFINITIONS.filter((f) => f.data_type === "plan_list");
const SCALAR_FACT_KEYS = SCALAR_FACT_DEFS.map((f) => f.fact_key);
const LIST_FACT_KEYS = LIST_FACT_DEFS.map((f) => f.fact_key);

const envelopeSchema = z.object({
  client_name: z.string().min(1),
  facts: z
    .array(
      z.object({
        fact_key: z.string(),
        value: z.string(),
        quote: z.string(),
      }),
    )
    .default([]),
  list_facts: z
    .array(
      z.object({
        fact_key: z.string(),
        plans: z.array(
          z.object({
            plan_name: z.string(),
            monthly_price_usd: z.unknown(),
          }),
        ),
        quote: z.string(),
      }),
    )
    .default([]),
});

const SCALAR_VALUE_SCHEMAS: Record<Exclude<FactDataType, "plan_list">, z.ZodTypeAny> = {
  number: z.coerce.number(),
  money: z.coerce.number(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected ISO-8601 date"),
  string: z.string().min(1),
};

const PLAN_LIST_SCHEMA = z.array(
  z.object({
    plan_name: z.string().min(1),
    monthly_price_usd: z.coerce.number(),
  }),
);

const FACT_TYPE_BY_KEY = new Map(FACT_DEFINITIONS.map((f) => [f.fact_key, f.data_type]));

/** Strips currency symbols/commas before numeric coercion — a model that
 * ignores the "no currency symbol" prompt hint (e.g. emits "$700") would
 * otherwise fail z.coerce.number() (Number("$700") is NaN) and get silently
 * dropped rather than salvaged. */
function sanitizeNumericString(value: string): string {
  return value.replace(/[^0-9.\-]/g, "");
}

function buildSystemPrompt(): string {
  const scalarLines = SCALAR_FACT_DEFS.map(
    (f) => `- ${f.fact_key} (${f.data_type}): ${f.description} ${f.extraction_hint}`,
  ).join("\n");
  const listLines = LIST_FACT_DEFS.map(
    (f) => `- ${f.fact_key}: ${f.description} ${f.extraction_hint}`,
  ).join("\n");

  return `You extract structured facts about a client from a health-insurance brokerage meeting transcript.

Configured facts to look for (only report ones actually stated or confirmed in THIS transcript — omit anything not mentioned):
${scalarLines}
${listLines}

If a value is corrected or restated later in the same transcript, report only the final corrected value. Do not infer values that were not actually said.

Respond with JSON in this exact shape:
{
  "client_name": string,
  "facts": [{"fact_key": string, "value": string, "quote": string}],
  "list_facts": [{"fact_key": string, "plans": [{"plan_name": string, "monthly_price_usd": number}], "quote": string}]
}
Put every fact EXCEPT ${LIST_FACT_KEYS.join(", ") || "(none)"} into "facts", with "value" as a plain string (numbers as digit strings with no currency symbol, e.g. "700" not "$700"; dates as YYYY-MM-DD). Put ${LIST_FACT_KEYS.join(", ") || "(none)"} into "list_facts" as a real array of plan objects, never as a string. "quote" must be a short verbatim excerpt from the transcript supporting the value.`;
}

function transcriptToText(meeting: Meeting): string {
  return meeting.transcript
    .map((t) => `[${t.start_time}] ${t.speaker.name}: ${t.text}`)
    .join("\n");
}

/** JSON schema passed to Ollama's `format` field. Ollama enforces this via
 * grammar-constrained decoding — the response is guaranteed to parse and
 * match this shape. It does NOT guarantee the *values* are correct — that's
 * still model judgment, checked by the zod validation below. */
function buildResponseFormat() {
  return {
    type: "object",
    properties: {
      client_name: { type: "string" },
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fact_key: { type: "string", enum: SCALAR_FACT_KEYS },
            value: { type: "string" },
            quote: { type: "string" },
          },
          required: ["fact_key", "value", "quote"],
        },
      },
      list_facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fact_key: { type: "string", enum: LIST_FACT_KEYS },
            plans: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  plan_name: { type: "string" },
                  monthly_price_usd: { type: "number" },
                },
                required: ["plan_name", "monthly_price_usd"],
              },
            },
            quote: { type: "string" },
          },
          required: ["fact_key", "plans", "quote"],
        },
      },
    },
    required: ["client_name", "facts", "list_facts"],
  };
}

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
}

/** Calls a local Ollama model with schema-constrained JSON output, then
 * validates each returned fact against its declared data_type (DESIGN.md
 * §4.1 step 4d) — invalid individual facts are dropped with a warning rather
 * than failing the whole meeting. */
export async function extractFacts(meeting: Meeting): Promise<ExtractionResult> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { temperature: 0 },
      format: buildResponseFormat(),
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: transcriptToText(meeting) },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as OllamaChatResponse;
  const parsedJson: unknown = JSON.parse(body.message.content);
  const envelope = envelopeSchema.parse(parsedJson);

  const validFacts: ExtractedFact[] = [];

  for (const fact of envelope.facts) {
    // Despite the prompt instruction to omit unmentioned facts, this model
    // reliably includes every fact_key anyway with an empty placeholder
    // ("", []) when nothing was said. Treat that as "not reported" and skip
    // silently — NOT a validation failure. This matters beyond tidiness:
    // Number("") is 0 in JS, not NaN, so without this check an empty
    // placeholder for a number/money fact would silently coerce to a
    // spurious 0 and overwrite a real prior value (caught by hand while
    // testing — see DESIGN.md §4.2).
    if (fact.value.trim() === "") continue;

    const dataType = FACT_TYPE_BY_KEY.get(fact.fact_key);
    if (!dataType || dataType === "plan_list") {
      console.warn(`[extract] unexpected fact_key "${fact.fact_key}" in scalar facts, dropping`);
      continue;
    }
    const raw =
      dataType === "number" || dataType === "money" ? sanitizeNumericString(fact.value) : fact.value;
    if ((dataType === "number" || dataType === "money") && raw.trim() === "") {
      console.warn(
        `[extract] fact "${fact.fact_key}" had no numeric content after sanitizing ("${fact.value}"), dropping`,
      );
      continue;
    }
    const parsed = SCALAR_VALUE_SCHEMAS[dataType].safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[extract] fact "${fact.fact_key}" failed ${dataType} validation, dropping: ${parsed.error.message}`,
      );
      continue;
    }
    validFacts.push({ fact_key: fact.fact_key, value: parsed.data, quote: fact.quote });
  }

  for (const fact of envelope.list_facts) {
    // Same "not reported" placeholder pattern as above — an empty plans
    // array means the model found nothing, not that it confirmed zero plans.
    // Treating it as a real value would supersede real historical pricing
    // with nothing every time a later meeting doesn't re-discuss pricing.
    if (fact.plans.length === 0) continue;

    const dataType = FACT_TYPE_BY_KEY.get(fact.fact_key);
    if (dataType !== "plan_list") {
      console.warn(`[extract] unexpected fact_key "${fact.fact_key}" in list_facts, dropping`);
      continue;
    }
    const parsed = PLAN_LIST_SCHEMA.safeParse(fact.plans);
    if (!parsed.success) {
      console.warn(
        `[extract] fact "${fact.fact_key}" failed plan_list validation, dropping: ${parsed.error.message}`,
      );
      continue;
    }
    validFacts.push({ fact_key: fact.fact_key, value: parsed.data, quote: fact.quote });
  }

  return { clientName: envelope.client_name, facts: validFacts };
}
