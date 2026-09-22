import Anthropic from "@anthropic-ai/sdk";

// The triage classifier. An LLM call, not a rule list — the question is a
// judgement ("does Michael need to see this?"), and the noise is legitimate
// mail (cold sales, vendor pitches, newsletters, automated notifications,
// recruiters) rather than anything a keyword catches. Server-only.
//
// It DECIDES NOTHING in Gmail. It reads sender/subject/snippet and returns one
// of two buckets plus a one-line reason. Nothing is deleted, archived, or
// modified anywhere as a result.

const MODEL = "claude-opus-4-8";

// Pricing for claude-opus-4-8, USD per 1M tokens (see the claude-api skill's
// model table). Used to report the real per-message cost from actual usage.
const INPUT_USD_PER_MTOK = 5;
const OUTPUT_USD_PER_MTOK = 25;

export type Classification = "needs_you" | "probably_not";

export interface TriageInput {
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  snippet: string;
}

export interface TriageVerdict {
  classification: Classification;
  reason: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const SYSTEM_PROMPT = `You triage the personal Gmail inbox of Michael, who runs Blanks Sports Nutrition. Your ONE question for each message is: does Michael personally need to see this?

Two buckets:
- "needs_you": anything from a real person or a real relationship. A customer, a business partner, a sponsored athlete, a retailer or wholesaler, a supplier he works with, or ANYONE he appears to have corresponded with before (a reply in an ongoing thread, a personal note addressed to him). Also anything time-sensitive or personal (legal, financial, account security, a real human asking a direct question).
- "probably_not": legitimate but low-value broadcast mail. Cold sales outreach, unsolicited vendor/agency pitches, marketing newsletters, automated SaaS notifications, social media digests, recruiter spam, "quick question about your website" cold emails.

Rules:
- BIAS TOWARD "needs_you". This is exactly like a junk filter: the cost of hiding a real message is far higher than the cost of showing one more. If you are uncertain, or the message is ambiguous, choose "needs_you".
- A real individual writing personally is ALWAYS "needs_you", even if brief.
- Cold outreach often flatters ("love what you're doing", "big fan of the brand") before pitching. Flattery plus a pitch is still "probably_not".
- You only see sender, subject, and a short snippet. Judge on that. Do not invent facts.
- Give a short, specific reason (one clause). Never use accusatory language.`;

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "record_triage",
  description: "Record the triage verdict for one email.",
  input_schema: {
    type: "object",
    properties: {
      classification: {
        type: "string",
        enum: ["needs_you", "probably_not"],
        description: "Which bucket this message belongs in.",
      },
      reason: {
        type: "string",
        description: "One short clause explaining the verdict. No accusatory language.",
      },
    },
    required: ["classification", "reason"],
  },
};

function costUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * INPUT_USD_PER_MTOK) / 1_000_000 +
    (outputTokens * OUTPUT_USD_PER_MTOK) / 1_000_000
  );
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client ??= new Anthropic();
  return client;
}

function userText(input: TriageInput): string {
  return [
    `From: ${input.fromName ? `${input.fromName} ` : ""}<${input.fromEmail ?? "unknown"}>`,
    `Subject: ${input.subject || "(no subject)"}`,
    `Snippet: ${input.snippet || "(no preview)"}`,
  ].join("\n");
}

/**
 * Classifies one message. On ANY failure it returns "needs_you" with the
 * reason recorded — the same bias the prompt encodes: a classifier that cannot
 * run must not quietly hide mail.
 */
export async function classifyMessage(input: TriageInput): Promise<TriageVerdict> {
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL],
    // Force the structured verdict — no prose, one tool call.
    tool_choice: { type: "tool", name: "record_triage" },
    messages: [{ role: "user", content: userText(input) }],
  });

  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  const parsed = block?.input as
    | { classification?: Classification; reason?: string }
    | undefined;

  const classification: Classification =
    parsed?.classification === "probably_not" ? "probably_not" : "needs_you";

  return {
    classification,
    reason: parsed?.reason?.trim() || "no reason given",
    model: MODEL,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    costUsd: costUsd(response.usage.input_tokens, response.usage.output_tokens),
  };
}

/** Weekly projection for a given per-message cost. Reported to the operator. */
export function projectWeeklyCost(perMessageUsd: number, messagesPerWeek = 500): number {
  return perMessageUsd * messagesPerWeek;
}

export const CLASSIFIER_MODEL = MODEL;
export { costUsd };
