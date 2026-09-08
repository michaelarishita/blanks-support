import { getPageAccessToken, withPageToken } from "./graph";
import { isWrongTokenKind } from "./page-token";
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
  /**
   * Already-stored attachments to send alongside the text.
   *
   * Meta takes ONE attachment per Send API call, so several become several
   * calls — see `sendMetaMessage`. Each needs a URL Meta's servers can fetch,
   * which is why these are signed URLs rather than our own private paths.
   */
  attachments?: OutboundAttachment[];
}

/** One file to send, already validated and stored by the upload path. */
export interface OutboundAttachment {
  /** A signed, time-limited URL Meta can fetch. Never a private storage path. */
  url: string;
  /** Meta's own coarse types. Anything not an image goes as `file`. */
  kind: "image" | "file";
  filename: string;
}

/**
 * Sends the text, then each attachment, stopping at the first failure.
 *
 * ORDER MATTERS AND IS DELIBERATE. The text goes first, so a customer whose
 * photo fails still receives the words explaining what was meant to arrive.
 * The reverse — a bare image with no context — is the worse half to deliver.
 *
 * PARTIAL SUCCESS IS REPORTED AS FAILURE, with what did get through named.
 * An agent must never be told "sent" about a reply the customer received only
 * part of; that is the same shape as a ticket created without its photo.
 */
export async function sendMetaMessage(options: SendTextOptions): Promise<SendResult> {
  const text = await sendMetaText(options);
  if (!text.ok) return text;

  const attachments = options.attachments ?? [];
  if (!attachments.length) return text;

  const sentNames: string[] = [];
  for (const attachment of attachments) {
    const result = await sendMetaAttachment({ ...options, attachment });
    if (!result.ok) {
      return {
        ok: false,
        error:
          `Your message was sent, but ${attachment.filename} did not: ${result.error}` +
          (sentNames.length ? ` (${sentNames.join(", ")} did send.)` : "") +
          " Send the file again on its own.",
      };
    }
    sentNames.push(attachment.filename);
  }

  return text;
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

  return dispatch({ recipient: { id: recipientId }, message: { text }, ...params });
}

/** One attachment, by URL, in its own Send API call. */
async function sendMetaAttachment({
  recipientId,
  windowState,
  attachment,
}: SendTextOptions & { attachment: OutboundAttachment }): Promise<SendResult> {
  const params = sendParamsFor(windowState);
  if (!params) {
    return { ok: false, error: "Meta's reply window has closed for this conversation." };
  }

  return dispatch({
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: attachment.kind,
        // is_reusable false: these are customer-specific and short-lived, and
        // asking Meta to keep them would outlive the signed URL anyway.
        payload: { url: attachment.url, is_reusable: false },
      },
    },
    ...params,
  });
}

/**
 * Posts to the Send API, RE-DERIVING the Page token once if it is rejected.
 *
 * The retry is the point. A Page token derived from a non-expiring system
 * user token should not expire — but "should not" is not a guarantee, and
 * without this the failure mode is a channel that goes dead and reports a
 * permissions error nobody can act on. `withPageToken` existed for exactly
 * this and had no caller until now.
 */
async function dispatch(body: Record<string, unknown>): Promise<SendResult> {
  const outcome = await withPageToken(async (token) => {
    const result = await post(body, token);
    // A rejected token is the one failure worth a second attempt with a
    // freshly derived one. Everything else is a real refusal.
    const rejected =
      !result.ok && (isWrongTokenKind(result.json) || isRejectedToken(result.json));
    return { rejected, result };
  });

  if (!outcome) {
    return {
      ok: false,
      error: "No Meta page token available — check Settings → Facebook Messenger.",
    };
  }

  if (!outcome.ok) {
    const error = readError(outcome.status, outcome.json, outcome.body);
    // Logged in full: 9A says the ACCESS-LEVEL error is what tells us whether
    // App Review is genuinely required, and that has to be read rather than
    // guessed at.
    console.error(`[meta] send failed (${outcome.status}):`, outcome.body.slice(0, 600));
    return { ok: false, error };
  }

  return {
    ok: true,
    messageId: typeof outcome.json?.message_id === "string" ? outcome.json.message_id : null,
  };
}

/** Code 190 is Meta saying the token itself was refused. */
function isRejectedToken(json: Record<string, unknown> | null): boolean {
  const error = json?.error as { code?: number } | undefined;
  return error?.code === 190;
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
