import {
  getGmailMessage,
  getGmailMessageMetadata,
  listGmailMessages,
} from "@/lib/google/gmail";
import { getAccessToken } from "@/lib/google/tokens";
import { getPersonalConnection } from "@/lib/google/personal-tokens";
import { parseGmailMessage, splitQuotedText } from "@/lib/email/parse";

// Read-only Gmail access for the PRIVATE personal-inbox triage (Phase A).
//
// Every call here uses the gmail.readonly grant stored under provider
// `google_personal`. It can only list and read; it cannot mark-read, label,
// archive, delete, or send. The promise to the owner — nothing is modified in
// Gmail — is therefore enforced by the OAuth scope, not just by this code.
//
// NO BODY IS EVER RETURNED to the sync path: the list fetches metadata only
// (headers + snippet). A body is fetched exactly when the owner opens a
// message, and is returned to the browser without ever being written down.
// Server-only.

/** Thrown when the owner has not connected a personal inbox yet. */
export const PERSONAL_INBOX_NOT_CONNECTED = "PERSONAL_INBOX_NOT_CONNECTED";

export interface PersonalMessageMeta {
  gmailMessageId: string;
  gmailThreadId: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  date: Date;
  /** Gmail's own short preview line. NOT the body. */
  snippet: string;
}

export interface PersonalMessageBody {
  gmailMessageId: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  date: Date;
  /** Fetched on demand, returned to the browser, never stored. */
  bodyText: string;
}

async function personalAccessToken(
  agentId: string
): Promise<{ token: string; accountRef: string } | null> {
  const connection = await getPersonalConnection(agentId);
  if (!connection) return null;
  return { token: await getAccessToken(connection.id), accountRef: connection.account_ref };
}

/** Whether this agent has connected a personal inbox for triage. */
export async function hasPersonalInbox(agentId: string): Promise<string | null> {
  const connection = await getPersonalConnection(agentId);
  return connection?.account_ref ?? null;
}

/**
 * Runs `task` over `items` with at most `limit` in flight. messages.get costs
 * quota, and firing 50 at once risks Gmail's per-user rate limit — a small
 * concurrency window is both polite and reliable.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

/**
 * Recent INBOX messages, newest first, metadata + snippet only.
 *
 * `in:inbox` — the same lens the owner sees. No body is fetched here.
 */
export async function listRecentInboxMessages(
  agentId: string,
  max = 50
): Promise<PersonalMessageMeta[]> {
  const auth = await personalAccessToken(agentId);
  if (!auth) throw new Error(PERSONAL_INBOX_NOT_CONNECTED);

  const { messages } = await listGmailMessages(auth.token, "in:inbox", max);
  const ids = messages ?? [];

  const metas = await mapWithConcurrency(ids, 8, async (m) => {
    const full = await getGmailMessageMetadata(auth.token, m.id);
    const parsed = parseGmailMessage(full);
    return {
      gmailMessageId: full.id,
      gmailThreadId: full.threadId,
      fromEmail: parsed.fromEmail,
      fromName: parsed.fromName,
      subject: parsed.subject,
      date: parsed.date,
      snippet: full.snippet ?? "",
    } satisfies PersonalMessageMeta;
  });

  // Gmail returns inbox order already, but be explicit — the view promises
  // newest first.
  metas.sort((a, b) => b.date.getTime() - a.date.getTime());
  return metas;
}

/**
 * Fetches ONE message's body on demand. Returned to the caller, never stored.
 * The quoted history is stripped so the reader sees what the person wrote.
 */
export async function fetchInboxMessageBody(
  agentId: string,
  gmailMessageId: string
): Promise<PersonalMessageBody> {
  const auth = await personalAccessToken(agentId);
  if (!auth) throw new Error(PERSONAL_INBOX_NOT_CONNECTED);

  const full = await getGmailMessage(auth.token, gmailMessageId);
  const parsed = parseGmailMessage(full);
  const { visible } = splitQuotedText(parsed.bodyText);

  return {
    gmailMessageId: full.id,
    fromEmail: parsed.fromEmail,
    fromName: parsed.fromName,
    subject: parsed.subject,
    date: parsed.date,
    bodyText: visible || parsed.bodyText,
  };
}
