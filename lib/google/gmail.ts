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

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
  messagesTotal: number;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

export interface GmailHistoryPage {
  history?: { messagesAdded?: { message: { id: string; threadId: string } }[] }[];
  historyId?: string;
  nextPageToken?: string;
}

/** Current mailbox state. The historyId is the cursor incremental sync starts from. */
export async function getGmailProfile(accessToken: string): Promise<GmailProfile> {
  return (await gmailFetch(accessToken, "/profile")) as GmailProfile;
}

/**
 * Incremental change feed since `startHistoryId`.
 *
 * Gmail expires history older than roughly a week; when the cursor is too old
 * it answers 404, which callers must treat as "resync from scratch" rather
 * than as a hard failure.
 */
export async function listGmailHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string
): Promise<GmailHistoryPage> {
  const params = new URLSearchParams({
    startHistoryId,
    historyTypes: "messageAdded",
  });
  if (pageToken) params.set("pageToken", pageToken);
  return (await gmailFetch(
    accessToken,
    `/history?${params.toString()}`
  )) as GmailHistoryPage;
}

/** Message id search — the fallback when the history cursor is unusable. */
export async function listGmailMessages(
  accessToken: string,
  query: string,
  maxResults = 25
): Promise<{ messages?: { id: string; threadId: string }[] }> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
  });
  return (await gmailFetch(accessToken, `/messages?${params.toString()}`)) as {
    messages?: { id: string; threadId: string }[];
  };
}

export async function getGmailMessage(
  accessToken: string,
  id: string
): Promise<GmailMessage> {
  return (await gmailFetch(
    accessToken,
    `/messages/${encodeURIComponent(id)}?format=full`
  )) as GmailMessage;
}

export async function getGmailAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<{ size: number; data: string }> {
  return (await gmailFetch(
    accessToken,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  )) as { size: number; data: string };
}

export async function modifyGmailMessage(
  accessToken: string,
  id: string,
  changes: { addLabelIds?: string[]; removeLabelIds?: string[] }
): Promise<void> {
  await gmailFetch(accessToken, `/messages/${encodeURIComponent(id)}/modify`, {
    method: "POST",
    body: JSON.stringify(changes),
  });
}

/**
 * Asks Gmail to push change notifications to a Pub/Sub topic. Expires after
 * seven days, so production needs a cron to renew it.
 */
export async function watchGmailMailbox(
  accessToken: string,
  topicName: string
): Promise<{ historyId: string; expiration: string }> {
  return (await gmailFetch(accessToken, "/watch", {
    method: "POST",
    body: JSON.stringify({ topicName, labelIds: ["INBOX"] }),
  })) as { historyId: string; expiration: string };
}

export async function stopGmailWatch(accessToken: string): Promise<void> {
  await gmailFetch(accessToken, "/stop", { method: "POST" });
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
