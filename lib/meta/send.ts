import { getPageAccessToken } from "./graph";
import type { MetaChannel } from "./events";
import { sendParamsFor, type ReplyWindowState } from "./window";

/**
 * The Send API.
 *
 * Both channels use the same endpoint with the Page token — that is what 9A's
 * single-integration choice buys. Instagram and Messenger differ in which id
 * identifies the recipient, and nothing else here.
 *
 * Server-only.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export type SendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string };

async function post(
  body: Record<string, unknown>,
  token: string
): Promise<{ ok: boolean; status: number; body: string; json: Record<string, unknown> | null }> {
  const response = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, body: text, json };
}

/** Turns Meta's error envelope into something worth putting in front of a person. */
function readError(
  status: number,
  json: Record<string, unknown> | null,
  raw: string
): string {
  const error = json?.error as
    | { message?: string; code?: number; error_subcode?: number; type?: string }
    | undefined;

  if (error?.message) {
    // Code 10 / subcode 2018278 is the window having closed underneath us —
    // the customer's last message aged out between render and send. Worth
    // naming, because "permission denied" would send someone to the app
    // settings for a problem that is purely about time.
    if (error.code === 10 || error.error_subcode === 2018278) {
      return "Meta refused the send: the reply window closed. The customer needs to message again.";
    }
    return `Meta refused the send: ${error.message}`;
  }
  return `Meta refused the send (HTTP ${status}): ${raw.slice(0, 200)}`;
}

export interface SendTextOptions {
  recipientId: string;
  text: string;
  windowState: ReplyWindowState;
  channel: MetaChannel;
}

export async function sendMetaText({
  recipientId,
  text,
  windowState,
}: SendTextOptions): Promise<SendResult> {
  const params = sendParamsFor(windowState);
  if (!params) {
    // Should never be reached — the composer blocks first — but a send that
    // cannot legally happen must not be attempted rather than failing at the
    // API with a message nobody can act on.
    return { ok: false, error: "Meta's reply window has closed for this conversation." };
  }

  const token = await getPageAccessToken();
  if (!token) {
    return {
      ok: false,
      error: "No Meta page token configured — set META_PAGE_ACCESS_TOKEN.",
    };
  }

  const result = await post(
    { recipient: { id: recipientId }, message: { text }, ...params },
    token
  );

  if (!result.ok) {
    const error = readError(result.status, result.json, result.body);
    // Logged in full: 9A says the ACCESS-LEVEL error is what tells us whether
    // App Review is genuinely required, and that has to be read rather than
    // guessed at.
    console.error(`[meta] send failed (${result.status}):`, result.body.slice(0, 600));
    return { ok: false, error };
  }

  return {
    ok: true,
    messageId: typeof result.json?.message_id === "string" ? result.json.message_id : null,
  };
}

/**
 * Marks the conversation seen.
 *
 * Best-effort by design: the customer seeing a read receipt is a courtesy,
 * and failing to set one must never surface as an error on opening a ticket.
 */
export async function markMetaSeen(recipientId: string): Promise<void> {
  try {
    const token = await getPageAccessToken();
    if (!token) return;
    await post({ recipient: { id: recipientId }, sender_action: "mark_seen" }, token);
  } catch (e) {
    console.warn("[meta] mark_seen failed:", e);
  }
}

/** Typing indicator. Same best-effort reasoning as mark_seen. */
export async function sendMetaTyping(
  recipientId: string,
  on: boolean
): Promise<void> {
  try {
    const token = await getPageAccessToken();
    if (!token) return;
    await post(
      { recipient: { id: recipientId }, sender_action: on ? "typing_on" : "typing_off" },
      token
    );
  } catch {
    /* never worth surfacing */
  }
}
