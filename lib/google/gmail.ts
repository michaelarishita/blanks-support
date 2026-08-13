// Gmail REST API calls. Server-only.

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailSendResult {
  id: string;
  threadId: string;
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } })?.error?.message ??
      `Gmail API error ${res.status}`;
    throw new Error(message);
  }
  return json;
}

/**
 * Sends a message. Passing `threadId` makes Gmail file it into an existing
 * thread — but Gmail only honours that when the subject and References line
 * up, so we set those too rather than relying on threadId alone.
 */
export async function sendGmailMessage(
  accessToken: string,
  opts: { raw: string; threadId?: string | null }
): Promise<GmailSendResult> {
  const body: Record<string, string> = { raw: opts.raw };
  if (opts.threadId) body.threadId = opts.threadId;

  const json = (await gmailFetch(accessToken, "/messages/send", {
    method: "POST",
    body: JSON.stringify(body),
  })) as GmailSendResult;

  return json;
}
