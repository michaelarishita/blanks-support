# Email surface — every email a human can receive

The one place the whole outbound-email surface is named. We have had three
separate email floods from three different senders; the point of this file is
that the next one is found here rather than in someone's inbox.

**Rule (see CLAUDE.md):** any code that can email a human is not finished until
its **maximum rate** and its **off switch** are written down. Add the sender to
this table in the same change that introduces it.

Last audited: 2026-09-27 (Prompt 34).

## Agent / admin-facing

| Email | Trigger | Max rate | Silenced by |
|---|---|---|---|
| **Assignment** | ticket assigned to the agent (rule or manual) | 1 per assignment; unbounded across reassignments | cadence: sent only on `immediate`, or on `daily` when the ticket is **urgent and assigned directly** (carve-out); folded into the daily digest otherwise; `off` = never |
| **Reassignment ("your ticket moved")** | the agent's ticket reassigned on someone's reply | 1 per reassignment | cadence: `immediate` only; suppressed on `daily`/`off` |
| **Reminder** | agent clicks a reminder link | 1 per click (agent-driven) | cadence: fires on `immediate` and `daily` (it was explicitly requested); `off` = never |
| **Escalation** | assigned ticket unanswered past its chase window | widening intervals, up to 3 to the agent, then → admin | cadence: agent email on `immediate` only; on `daily`/`off` the rung is still recorded (ladder advances, hand-off still fires) but no per-escalation email |
| **Escalation hand-off** | escalation count > 3 | 1 per hand-off | `alert_mutes` kind `escalation_handoff` (mute without a deploy) |
| **New-ticket** | new ticket, after routing rules | 1 per watcher per ticket | `watch_new_tickets`; unowned High/Urgent falls back to `notifications_enabled`; cadence: `immediate` watchers only (`daily` gets it in the digest's unassigned section) |
| **Unassigned digest** | daily at 8am AZ, if the queue is non-empty | 1/day | `watch_unassigned_digest`; skipped for `daily`/`off` agents (folded into their personal digest) |
| **Daily digest** (Prompt 34) | daily at the agent's `digest_hour`, only if there is something to report | 1/day, and **nothing when empty** | `notification_frequency = 'daily'`; `off`/`immediate` do not receive it |
| **System alert** (inbound-down, meta-down, deploy-behind, reconciliation, quarantine) | hourly heartbeat / cron detects a condition | 1st occurrence + ≤1/day/kind, escalates at 3 | `alert_mutes` (per kind) |

## Customer-facing (not governed by agent preferences)

| Email | Trigger | Max rate | Notes |
|---|---|---|---|
| **Reply** | agent sends a public reply | per send + hourly retry on failure | the actual support conversation |

## The cadence model (0028)

One per-agent setting, `notification_frequency`, three values:

- **immediate** — every event emails as it happens (what everyone had before).
- **daily** — events fold into one digest at `digest_hour`; nothing else emails
  **except** an urgent ticket assigned directly to the agent.
- **off** — no notification email; the escalation ladder still ends at an admin.

`notification_frequency` is authoritative. The legacy `notifications_enabled`
boolean is kept in sync (off ⇔ false) and used only as a fallback in the window
between this code deploying and 0028 being applied by hand.

Read it with `loadNotificationMode` (resilient to the column being absent); the
urgent carve-out lives once in `shouldEmailNow`.
