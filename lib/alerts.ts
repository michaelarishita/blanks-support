import { buildRawEmail, generateMessageId } from "@/lib/email/mime";
import { sendGmailMessage } from "@/lib/google/gmail";
import { getAccessToken, getSupportInboxConnection } from "@/lib/google/tokens";

// Operational alerts, sent through the support mailbox connection.
// Plain text on purpose: an alert about mail being broken should use the
// simplest possible path through the mail stack.

export function alertRecipient(): string {
  return process.env.ALERT_EMAIL ?? "michael@blankssportsnutrition.com";
}

export async function sendOperationalAlert(
  subject: string,
  body: string
): Promise<{ sent: boolean; error?: string }> {
  const connection = await getSupportInboxConnection();
  if (!connection) {
    return { sent: false, error: "No support mailbox connected" };
  }

  try {
    const accessToken = await getAccessToken(connection.id);
    const to = alertRecipient();

    const raw = buildRawEmail({
      fromEmail: connection.account_ref,
      fromName: "Blanks Support Monitor",
      to,
      subject,
      bodyText: body,
      messageId: generateMessageId(connection.account_ref),
    });

    await sendGmailMessage(accessToken, { raw });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}
