import { escapeHtml } from "@/lib/html";
import { CHANNEL_META, PRIORITY_META } from "@/lib/types";
import type { TicketChannel, TicketPriority } from "@/lib/types";
import { describeAge } from "./summary";

// The assignment notification's content. Pure rendering — the data is
// gathered by the caller, so this can be tested without a database.
//
// Same email-client constraints as the customer template: tables, inline
// styles, explicit background on every cell.

export const ASSIGNMENT_SUBJECT = "New Customer Service Ticket Assigned to You";

const TEXT = "#1a1a1a";
const MUTED = "#666666";
const RULE = "#e5e5e5";
const BACKDROP = "#f4f4f5";
const BRAND = "#0061ff";

/** Priority has to read at a glance, so it gets colour weight of its own. */
const PRIORITY_STYLE: Record<TicketPriority, { bg: string; fg: string; weight: string }> = {
  urgent: { bg: "#fef2f2", fg: "#a81f1f", weight: "700" },
  high: { bg: "#fff8ea", fg: "#8a5209", weight: "700" },
  normal: { bg: "#f4f4f5", fg: "#52525b", weight: "600" },
  low: { bg: "#f4f4f5", fg: "#71717a", weight: "500" },
};

export interface QueueBreakdown {
  urgent: number;
  high: number;
  normal: number;
  low: number;
}

export type NotificationVariant = "assignment" | "reminder" | "escalation";

export interface ReminderLink {
  hours: number;
  label: string;
  href: string;
}

export interface AssignmentContext {
  agentName: string;
  /** Changes the opening line; the rest of the email is identical. */
  variant?: NotificationVariant;
  /** Overrides the opening line entirely (escalation copy firms up). */
  lead?: string;
  /** "Remind me later" buttons. Signed links to a confirmation page. */
  reminderLinks?: ReminderLink[];
  ticket: {
    id: string;
    number: number;
    subject: string;
    priority: TicketPriority;
    channel: TicketChannel;
    topic: string | null;
    tags: string[];
    customerName: string;
    createdAt: string;
  };
  /** First ~200 chars of the customer's latest message. */
  summary: string;
  queue: {
    total: number;
    byPriority: QueueBreakdown;
    oldest: { number: number; createdAt: string } | null;
  };
  siteUrl: string;
  now?: number;
}

function defaultLead(ctx: AssignmentContext): string {
  switch (ctx.variant) {
    case "reminder":
      return `${ctx.agentName}, you asked to be reminded about this ticket.`;
    case "escalation":
      return `${ctx.agentName}, this ticket is still unanswered.`;
    default:
      return `Hi ${ctx.agentName}, this ticket is now yours.`;
  }
}

const cell = (content: string, style = "") =>
  `<td style="background-color:#ffffff;${style}">${content}</td>`;

function priorityChip(priority: TicketPriority): string {
  const style = PRIORITY_STYLE[priority] ?? PRIORITY_STYLE.normal;
  return (
    `<span style="display:inline-block;background-color:${style.bg};color:${style.fg};` +
    `font-size:12px;font-weight:${style.weight};letter-spacing:0.04em;text-transform:uppercase;` +
    // Uppercased in the MARKUP, not only via text-transform: several email
    // clients strip that property, and priority is the one thing in here that
    // has to read at a glance.
    `padding:3px 8px;border-radius:4px;">${escapeHtml(
      (PRIORITY_META[priority]?.label ?? priority).toUpperCase()
    )}</span>`
  );
}

function queueRow(label: string, count: number, emphasise: boolean): string {
  return `<tr>
    ${cell(escapeHtml(label), `padding:4px 0;color:${MUTED};font-size:14px;`)}
    ${cell(
      String(count),
      `padding:4px 0;text-align:right;font-size:14px;font-variant-numeric:tabular-nums;` +
        `color:${emphasise && count > 0 ? "#a81f1f" : TEXT};font-weight:${emphasise && count > 0 ? "700" : "500"};`
    )}
  </tr>`;
}

export function renderAssignmentHtml(ctx: AssignmentContext): string {
  const now = ctx.now ?? Date.now();
  const t = ctx.ticket;
  const ticketUrl = `${ctx.siteUrl.replace(/\/$/, "")}/tickets/${t.id}`;
  const queueUrl = `${ctx.siteUrl.replace(/\/$/, "")}/inbox?view=mine`;

  const meta = [CHANNEL_META[t.channel]?.label ?? t.channel, t.topic, ...t.tags]
    .filter(Boolean)
    .map((v) => escapeHtml(String(v)))
    .join(" · ");

  const q = ctx.queue.byPriority;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light only" />
<title>${escapeHtml(ASSIGNMENT_SUBJECT)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BACKDROP};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BACKDROP};border-collapse:collapse;">
  <tr>
    <td align="center" style="padding:24px 12px;background-color:${BACKDROP};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background-color:#ffffff;border-collapse:collapse;">
        <tr>
          <td style="padding:24px;background-color:#ffffff;color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;">

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
              <tr>${cell(
                escapeHtml(ctx.lead ?? defaultLead(ctx)),
                `padding:0 0 16px 0;color:${TEXT};font-size:15px;`
              )}</tr>

              <tr>${cell(priorityChip(t.priority), "padding:0 0 8px 0;")}</tr>

              <tr>${cell(
                `<span style="font-size:17px;font-weight:600;color:${TEXT};">#${t.number} — ${escapeHtml(t.subject)}</span>`,
                "padding:0 0 4px 0;"
              )}</tr>

              <tr>${cell(
                `${escapeHtml(t.customerName)}${meta ? ` &middot; ${meta}` : ""}`,
                `padding:0 0 2px 0;color:${MUTED};font-size:13px;`
              )}</tr>

              <tr>${cell(
                `Opened ${escapeHtml(describeAge(t.createdAt, now))} ago`,
                `padding:0 0 16px 0;color:${MUTED};font-size:13px;`
              )}</tr>

              ${
                ctx.summary
                  ? `<tr>${cell(
                      `<div style="border-left:3px solid ${RULE};padding:2px 0 2px 12px;color:${TEXT};font-size:14px;line-height:1.5;">${escapeHtml(
                        ctx.summary
                      )}</div>`,
                      "padding:0 0 20px 0;"
                    )}</tr>`
                  : ""
              }

              <tr>${cell(
                `<a href="${escapeHtml(ticketUrl)}" style="display:inline-block;background-color:${BRAND};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:11px 22px;border-radius:8px;">Open ticket #${t.number}</a>`,
                "padding:0 0 20px 0;"
              )}</tr>

              ${
                ctx.reminderLinks?.length
                  ? `<tr>${cell(
                      `<span style="display:block;margin:0 0 6px 0;color:${MUTED};font-size:13px;">Not now? Remind me in</span>` +
                        ctx.reminderLinks
                          .map(
                            (link) =>
                              `<a href="${escapeHtml(link.href)}" style="display:inline-block;margin:0 6px 6px 0;padding:7px 12px;border:1px solid ${RULE};border-radius:6px;color:${TEXT};font-size:13px;text-decoration:none;">${escapeHtml(
                                link.label
                              )}</a>`
                          )
                          .join(""),
                      "padding:0 0 16px 0;"
                    )}</tr>`
                  : ""
              }

              <tr>${cell(
                "",
                `padding:0 0 16px 0;border-top:1px solid ${RULE};font-size:0;line-height:0;`
              )}</tr>

              <tr>${cell(
                `<span style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">Your outstanding queue</span>`,
                "padding:0 0 10px 0;"
              )}</tr>

              <tr>${cell(
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                  ${queueRow("Urgent", q.urgent, true)}
                  ${queueRow("High", q.high, true)}
                  ${queueRow("Normal", q.normal, false)}
                  ${queueRow("Low", q.low, false)}
                  <tr>${cell(
                    "<strong>Total open</strong>",
                    `padding:8px 0 0 0;border-top:1px solid ${RULE};color:${TEXT};font-size:14px;`
                  )}${cell(
                    `<strong>${ctx.queue.total}</strong>`,
                    `padding:8px 0 0 0;border-top:1px solid ${RULE};text-align:right;color:${TEXT};font-size:14px;font-variant-numeric:tabular-nums;`
                  )}</tr>
                </table>`,
                "padding:0 0 12px 0;"
              )}</tr>

              ${
                ctx.queue.oldest
                  ? `<tr>${cell(
                      `Oldest open: <strong>#${ctx.queue.oldest.number}</strong>, waiting ${escapeHtml(
                        describeAge(ctx.queue.oldest.createdAt, now)
                      )} (${escapeHtml(formatStamp(ctx.queue.oldest.createdAt))})`,
                      `padding:0 0 18px 0;color:${MUTED};font-size:13px;`
                    )}</tr>`
                  : ""
              }

              <tr>${cell(
                `<a href="${escapeHtml(queueUrl)}" style="color:#0047c2;font-size:14px;text-decoration:underline;">See all of your tickets</a>`,
                "padding:0;"
              )}</tr>
            </table>

          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Stable UTC stamp — same reasoning as the quote attribution. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(
    d.getUTCHours()
  ).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function renderAssignmentText(ctx: AssignmentContext): string {
  const now = ctx.now ?? Date.now();
  const t = ctx.ticket;
  const base = ctx.siteUrl.replace(/\/$/, "");
  const q = ctx.queue.byPriority;

  const lines = [
    ctx.lead ?? defaultLead(ctx),
    "",
    `[${(PRIORITY_META[t.priority]?.label ?? t.priority).toUpperCase()}] #${t.number} — ${t.subject}`,
    [t.customerName, CHANNEL_META[t.channel]?.label ?? t.channel, t.topic, ...t.tags]
      .filter(Boolean)
      .join(" · "),
    `Opened ${describeAge(t.createdAt, now)} ago`,
  ];

  if (ctx.summary) lines.push("", `"${ctx.summary}"`);

  lines.push(
    "",
    `Open ticket: ${base}/tickets/${t.id}`,
    "",
    "YOUR OUTSTANDING QUEUE",
    `  Urgent  ${q.urgent}`,
    `  High    ${q.high}`,
    `  Normal  ${q.normal}`,
    `  Low     ${q.low}`,
    `  Total   ${ctx.queue.total}`
  );

  if (ctx.queue.oldest) {
    lines.push(
      "",
      `Oldest open: #${ctx.queue.oldest.number}, waiting ${describeAge(
        ctx.queue.oldest.createdAt,
        now
      )} (${formatStamp(ctx.queue.oldest.createdAt)})`
    );
  }

  if (ctx.reminderLinks?.length) {
    lines.push("", "Not now? Remind me in:");
    for (const link of ctx.reminderLinks) {
      lines.push(`  ${link.label}: ${link.href}`);
    }
  }

  lines.push("", `All of your tickets: ${base}/inbox?view=mine`);
  return lines.join("\n");
}
