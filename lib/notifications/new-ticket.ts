import { sendNewTicketNotification } from "./send";

/**
 * The wrapper every ingest path calls.
 *
 * Never throws, for the same reason runRulesSafely does not: a ticket that
 * exists is worth more than a notification about it. The web form would
 * otherwise tell a customer their message was not received because an SMTP
 * call failed, and the mail sync would abandon a batch of real email.
 */
export async function notifyNewTicketSafely(ticketId: string): Promise<void> {
  try {
    const result = await sendNewTicketNotification(ticketId);
    if (result.error) {
      console.error(`[notifications] new-ticket notice failed for ${ticketId}:`, result.error);
      return;
    }
    console.info(
      `[notifications] new ticket ${ticketId}: ${result.sent} sent, ${result.deferred} deferred` +
        (result.skipped.length ? `, skipped ${JSON.stringify(result.skipped)}` : "")
    );
  } catch (e) {
    console.error(`[notifications] new-ticket notice threw for ${ticketId}:`, e);
  }
}
