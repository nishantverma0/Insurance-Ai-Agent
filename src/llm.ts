import type { PerceivedField } from "./types.js";
import { normLabel } from "./text.js";

export interface AnswerCatalogEntry {
  key: string;
  preview: string; // short human-readable preview of the value(s)
  isArray: boolean;
  arrayItemKeys?: string[]; // keys within each array item, if isArray
}

export interface LlmMappingResponseItem {
  refId: string;
  answerKey: string | null;
  confidence: number;
  reason: string;
}

export interface LlmClient {
  readonly name: string;
  mapFields(fields: PerceivedField[], catalog: AnswerCatalogEntry[]): Promise<LlmMappingResponseItem[]>;
}

const SYSTEM_PROMPT = `You are a form-field mapping engine used by an insurance carrier-onboarding automation agent.
You will be given:
1. A list of form fields perceived from an HTML page you have never seen before (label, input type, placeholder/helper text, options if any).
2. A catalog of available answer keys from an applicant's data record, each with a short preview of its value.

For EACH field, decide which single answer key (if any) semantically corresponds to it, using the label/placeholder/helper text/options as evidence. Field labels will often use different wording than answer keys (e.g. "Employer Identification Number" vs "FEIN").

Rules:
- If no answer key plausibly corresponds to a field, or you are not confident, set answerKey to null and explain why in "reason". NEVER invent or guess a value that is not clearly supported.
- confidence is a number from 0 to 1 reflecting how sure you are of the match.
- Return ONLY valid JSON.

Example:

[
 {
   "refId":"f0",
   "answerKey":"BusinessLegalName",
   "confidence":0.96,
   "reason":"Business legal name."
 }
]

No markdown.
No explanation.
No code fences.
No extra text. (no markdown fences, no prose) of objects: {"refId": string, "answerKey": string|null, "confidence": number, "reason": string}
- Include exactly one object per input field you were given, in any order.`;

export class GroqLlmClient implements LlmClient {
  readonly name = "groq";
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model || "llama-3.3-70b-versatile";
  }

  async mapFields(fields: PerceivedField[], catalog: AnswerCatalogEntry[]): Promise<LlmMappingResponseItem[]> {
    const userPayload = {
      fields: fields.map((f) => ({
        refId: f.refId,
        label: f.label,
        kind: f.kind,
        helperText: f.helperText,
        placeholder: f.placeholder,
        required: f.required,
        options: f.options?.map((o) => o.text),
      })),
      answerCatalog: catalog,
    };

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
  "Content-Type": "application/json",
  Authorization: `Bearer ${this.apiKey}`,
},
      body: JSON.stringify({
    model: this.model,
    temperature: 0,
    messages: [
        {
            role: "system",
            content: SYSTEM_PROMPT
        },
        {
            role: "user",
            content: JSON.stringify(userPayload)
        }
    ]
}),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Groq API error ${res.status}: ${body}`);
    }
      const data = await res.json();

console.log("========== GROQ RESPONSE ==========");
console.dir(data, { depth: null });
console.log("===================================");


const text = data?.choices?.[0]?.message?.content;

if (!text) {
    throw new Error(JSON.stringify(data, null, 2));
}

const cleaned = text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

let parsed;

try {
    parsed = JSON.parse(cleaned);
} catch {
    throw new Error("Groq returned:\n\n" + text);
}

// Standard array
if (Array.isArray(parsed))
    return parsed;

if (parsed.refId)
    return [parsed];

if (Array.isArray(parsed.results))
    return parsed.results;

if (Array.isArray(parsed.fields))
    return parsed.fields;
throw new Error(
    "Unexpected JSON:\n" +
    JSON.stringify(parsed, null, 2)
);
  }
}

/**
 * Deterministic, offline stand-in for the LLM used in this sandbox (no
 * outbound network access to a keyed LLM endpoint is available here) and
 * for cheap local/CI testing. It approximates "semantic" matching with
 * generic string-similarity over label vs. answer-key tokens plus a small
 * set of DOMAIN-GENERAL synonym expansions (concepts like "EIN"/"tax id",
 * "DBA"/"trade name" are standard business-form vocabulary, not anything
 * specific to form_a/form_b). It is deliberately conservative: anything
 * below its confidence floor is left unmapped so the fallback/flag policy
 * still applies. This class exists purely so the pipeline is runnable
 * end-to-end without a live API key -- production runs should use
 * GroqLlmClient.
 */
export class MockSemanticLlmClient implements LlmClient {
  readonly name = "mock-offline";

  private static SYNONYMS: Record<string, string[]> = {
    ein: ["tax id", "federal tax id", "employer identification number", "fein"],
    dba: ["doing business as", "trade name"],
    legal: ["registered", "insured"],
    entity: ["organization", "org type", "legal structure"],
    phone: ["telephone", "tel"],
    zip: ["postal code"],
    payroll: ["annual payroll", "estimated payroll"],
    effective: ["inception", "start date"],
    expiration: ["expiring", "end date"],
    carrier: ["insurer"],
    claims: ["claim count", "loss count"],
    prior: ["expiring", "current", "previous", "last term"],
    subcontractor: ["subcontractors", "subs"],
    classification: ["class code", "governing class"],
  };

  async mapFields(fields: PerceivedField[], catalog: AnswerCatalogEntry[]): Promise<LlmMappingResponseItem[]> {
    const expand = (s: string): string => {
      let out = s;
      for (const [k, syns] of Object.entries(MockSemanticLlmClient.SYNONYMS)) {
        for (const syn of syns) {
          if (out.includes(syn)) out += " " + k;
        }
      }
      return out;
    };
    const tokensOf = (s: string) => new Set(expand(normLabel(s)).split(" ").filter((t) => t.length > 2));

    // Precompute per-key token sets once, plus an IDF-style weight per token
    // (tokens that show up in many keys -- e.g. "business", "date" -- are
    // generic and shouldn't be allowed to win a match on their own).
    const keyTokenSets = catalog.map((entry) => ({ entry, tokens: tokensOf(entry.key) }));
    const docFreq = new Map<string, number>();
    for (const { tokens } of keyTokenSets) {
      for (const t of tokens) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
    const weight = (t: string) => 1 / (1 + Math.log(1 + (docFreq.get(t) || 1)));

    return fields.map((f) => {
      const labelTokens = tokensOf(`${f.label} ${f.helperText || ""} ${f.placeholder || ""}`);

      const scored = keyTokenSets.map(({ entry, tokens: keyTokens }) => {
        const shared = [...labelTokens].filter((t) => keyTokens.has(t));
        const weightedOverlap = shared.reduce((sum, t) => sum + weight(t), 0);
        const maxPossible = [...keyTokens].reduce((sum, t) => sum + weight(t), 0) || 1;
        return { key: entry.key, score: weightedOverlap / maxPossible };
      });
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      const runnerUp = scored[1];
      const margin = best ? best.score - (runnerUp?.score ?? 0) : 0;

      // Require both a reasonable absolute score AND a clear margin over the
      // next-best candidate, so generic shared words (e.g. "business") that
      // tie across multiple keys don't produce a confident false match.
      if (best && best.score >= 0.4 && (margin >= 0.15 || !runnerUp || runnerUp.score === 0)) {
        return {
          refId: f.refId,
          answerKey: best.key,
          confidence: Math.min(0.88, 0.5 + best.score / 2),
          reason: `token-overlap match between field label "${f.label}" and answer key "${best.key}" (score ${best.score.toFixed(2)})`,
        };
      }
      return {
        refId: f.refId,
        answerKey: null,
        confidence: 0,
        reason: `no answer-catalog key crossed the confidence threshold for label "${f.label}"`,
      };
    });
  }
}

export function buildLlmClient(): LlmClient {
    const apiKey = process.env.GROQ_API_KEY;
    const model = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

    if (apiKey) {
        return new GroqLlmClient(apiKey, model);
    }

    return new MockSemanticLlmClient();
}

declare const process: { env: Record<string, string | undefined> };
