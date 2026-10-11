# Email surface — every email a human on the team can receive

Three separate senders have flooded this inbox (the new-ticket broadcast, the
Messenger heartbeat, the escalation hand-off). This file is the single list of
everything that can reach a team member, so the surface is known **before** the
next flood rather than discovered by it. A new human-facing sender is added to
this table in the same change that introduces it.

There are two independent throttles, and every sender is subject to both:

1. **Cadence** (`agents.notification_frequency`, 0028) — `immediate` / `daily` /
   `off`. Governs the per-agent *ticket* notifications (assignment, reminder,
   escalation, new-ticket). `daily` folds them into one personal digest;
   `off` sends none; an **urgent ticket assigned directly to you stays
   immediate even on `daily`** (`shouldEmailNow`, `lib/notifications/preference.ts`).
2. **Delivery cap** (`agents.daily_email_cap`, 0029) — the hard ceiling,
   enforced at the one chokepoint **`sendTeamEmail` (`lib/notifications/delivery.ts`)**
   that every human-facing email passes through. Over the cap → deferred into
   `email_ledger` and rolled into the overflow digest. Nothing is dropped.

Customer-facing replies (`lib/google/outbound.ts` → the customer) are **not**
team email and are deliberately out of scope of both.

| Kind (`email_ledger.kind`) | Trigger | Recipient | Source | Cadence-gated | Capped |
|---|---|---|---|---|---|
| `assignment` | Ticket assigned to an agent | that agent | `sendAssignmentNotification` (send.ts) | yes | yes |
| `assignment` (reassign) | Agent's reply auto-claims a ticket | previous owner | `sendReassignmentNotification` (send.ts) | yes | yes |
| `new_ticket` | New ticket (after routing) | `watch_new_tickets` watchers; unassigned High/Urgent → enabled agents | `sendNewTicketNotification` (send.ts) | yes | yes |
| `reminder` | Agent's "remind me in Xh" fires | that agent | `sendFollowUp` (send.ts) | yes | yes |
| `escalation` | Assigned ticket past threshold, chases 1–N | the assignee | `sendFollowUp` (send.ts) | yes | yes |
| `escalation_handoff` | Past the chase cap → raised with an admin | `ALERT_EMAIL` (Michael) | `sendOperationalAlert` → `deliverAlertEmail` (alerts.ts) | no | yes (mutable via `alert_mutes`) |
| `unassigned_digest` | Daily, if queue non-empty, **only for `immediate` agents** (daily agents get it folded into their personal digest) | `watch_unassigned_digest` agents | `sendUnassignedDigest` (unassigned-send.ts) | yes | yes |
| `daily_digest` | Daily at the agent's hour, for `daily`-cadence agents | that agent | `runDailyDigests` (digest.ts) | — (it IS the daily channel) | **bypass** (logged) |
| `system_alert` *(kind is the alert's own, e.g. `inbound_email_down`, `meta_messenger_down`, `deploy_behind`, `inbound_quarantine`)* | A degraded system-health check | `ALERT_EMAIL` (Michael) | `raiseSystemAlert` → `deliverAlertEmail` (alerts.ts) | no | yes |
| `overflow_digest` | Daily, if the cap held anything back **and no cadence digest fired for that person today** | the capped recipient | `sendOverflowDigests` (delivery.ts) | — | **bypass** (logged) |

## The cap, precisely

- **`agents.daily_email_cap`** — Michael = 1; default 50 (a flood backstop, not
  a day-to-day limit) for everyone else; configurable per agent. Set it to 0
  to force everything into a single daily roundup.
- **Counting** — `sendTeamEmail` counts `email_ledger` rows with `outcome='sent'`
  for the recipient on the local day. At/over the cap → `outcome='deferred'`,
  the email is NOT sent, and its full body is kept for the digest.
- **Fails open** — if `daily_email_cap` or `email_ledger` can't be read,
  `sendTeamEmail` sends rather than blocks. A missing cap is the old behaviour;
  a chokepoint that blocked every alert because a table was absent is worse.

## One email a day, honoured — how the two digests coordinate

`cap=1` must mean *one*, not "one plus a digest plus an overflow digest". So the
two roundups never both reach the same person on the same day:

- The **daily cadence digest** (`runDailyDigests`) runs first on the cron. When
  it sends to an agent, it **folds that agent's capped-overflow items in as a
  section** and stamps the day. It delivers through `sendTeamEmail` with an
  explicit logged bypass (`bypassCap: { reason: "daily cadence digest" }`), so
  it is never itself blocked by the cap.
- The **overflow digest** (`sendOverflowDigests`) runs second and **skips anyone
  who already received a cadence digest today** — it only sends standalone to
  agents who are not on `daily` cadence but whose cap deferred something.

So a `daily` agent gets exactly one digest (with overflow inside it); an
`immediate` agent with cap overflow gets one overflow digest; nobody gets both.

## Adding a new human-facing sender

1. Call `sendTeamEmail(...)` with a distinct `kind`. Do not call
   `sendGmailMessage` directly — `tests/email-cap.test.ts` enforces this across
   the sender modules (`send.ts`, `alerts.ts`, `unassigned-send.ts`, `digest.ts`).
2. Add a row to the table above.
3. If — and only if — it genuinely must ignore the cap, pass `bypassCap` with a
   written reason. It is logged as `outcome='bypassed'`. A bypass is never a
   default a new sender inherits.
