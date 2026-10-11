# Email surface — every email a human on the team can receive

Three separate senders have flooded this inbox (the new-ticket broadcast, the
Messenger heartbeat, the escalation hand-off). This file is the single list of
everything that can reach a team member, so the surface is known **before** the
next flood rather than discovered by it.

**The enforcement point is one chokepoint: `sendTeamEmail` in
`lib/notifications/delivery.ts`.** Every sender below passes through it and is
subject to the per-agent daily cap (`agents.daily_email_cap`, 0029). Anything
over the cap is deferred into `email_ledger` and rolled into the overflow
digest — never dropped. A new sender is added to this table in the same change
that introduces it.

Customer-facing replies (`lib/google/outbound.ts` → the customer) are **not**
team email and are deliberately out of scope.

| Kind (`email_ledger.kind`) | Trigger | Recipient | Source | Capped? |
|---|---|---|---|---|
| `assignment` | Ticket assigned to an agent | that agent | `sendAssignmentNotification` (send.ts) | yes |
| `assignment` (reassign) | Agent's reply auto-claims a ticket from a previous owner | previous owner | `sendReassignmentNotification` (send.ts) | yes |
| `new_ticket` | New ticket created (after routing) | `watch_new_tickets` watchers; unassigned High/Urgent → `notifications_enabled` agents | `sendNewTicketNotification` (send.ts) | yes |
| `reminder` | Agent's "remind me in Xh" fires | that agent | `sendFollowUp` (send.ts) | yes |
| `escalation` | Assigned ticket past its priority threshold, chase 1–3 | the assignee | `sendFollowUp` (send.ts) | yes |
| `escalation_handoff` | Past the 3-chase cap → raised with an admin | `ALERT_EMAIL` (Michael) | `sendOperationalAlert` → `deliverAlertEmail` (alerts.ts) | yes |
| `unassigned_digest` | Daily, if unassigned queue non-empty | `watch_unassigned_digest` agents | `sendUnassignedDigest` (unassigned-send.ts) | yes |
| `system_alert` *(kind is the alert's own kind, e.g. `inbound_email_down`, `meta_messenger_down`, `deploy_behind`, `inbound_quarantine`, `inbound_reconciliation…`)* | A degraded system-health check | `ALERT_EMAIL` (Michael) | `raiseSystemAlert` → `deliverAlertEmail` (alerts.ts) | yes |
| `overflow_digest` | Daily, if anything was deferred by the cap | the capped recipient | `sendOverflowDigests` (delivery.ts) | **bypass** (explicit, named, logged — see below) |

## The cap, precisely

- **`agents.daily_email_cap`** — Michael = 1; default 50 (a flood backstop, not
  a day-to-day limit) for everyone else; configurable per agent. Set it to 0 for
  a strict single-overflow-digest-per-day.
- **Counting** — `sendTeamEmail` counts `email_ledger` rows with `outcome='sent'`
  for the recipient on the local day. At/over the cap → `outcome='deferred'` and
  the email is NOT sent; its full body is kept for the digest.
- **The overflow digest** rolls every deferred, not-yet-digested row into one
  summary per recipient, once per day at/after the digest hour, quiet-on-empty.
  It is the one sanctioned cap **bypass** (`bypassCap: { reason }`,
  `outcome='bypassed'`) because it is the mechanism that makes the cap lossless —
  it must deliver even when the cap is spent.
- **Fails open** — if `daily_email_cap` or `email_ledger` can't be read (0029
  not applied), `sendTeamEmail` SENDS. A missing cap is the old behaviour; a
  chokepoint that blocked every alert because a table was absent would be the
  worse outage.

## Adding a new human-facing sender

1. Call `sendTeamEmail(...)` with a distinct `kind`. Do not call
   `sendGmailMessage` directly — `tests/email-cap.test.ts` enforces this for the
   existing sender modules.
2. Add a row to the table above.
3. If — and only if — it genuinely must ignore the cap, pass `bypassCap` with a
   written reason. It will be logged as `bypassed`. A bypass is never a default
   a new sender inherits.
