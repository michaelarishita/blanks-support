# Prompt 29 — Junk folder with a correction loop

Branch `afk/junk-folder`. **Do not merge.** Migrations **0025** (the `junk`
enum value, alone) and **0026** (the tables/columns that use it).

> Split in Prompt 30: Postgres cannot add an enum value and use it in the same
> transaction (55P04), and the Supabase SQL editor pastes a file as one
> transaction — so the `alter type` lives alone in 0025 and everything that
> references `junk` is in 0026. Both are idempotent; apply 0025, then 0026.

## The point

Guards used to DISCARD mail. A drop is a decision with the evidence thrown
away, and if one of those was a customer, it was gone silently. This replaces
dropping with **filing into Junk**: every reviewable guard-drop becomes a
ticket carrying the reason it was junked, out of every queue, purged after 30
days — and correctable both ways, with the correction recorded as the eval set
we never had.

## What ships

- **`junk` status** (0025 adds the enum value; 0026 adds `tickets.junked_at` /
  `tickets.junk_reason` and the partial index that uses it).
  A dedicated status means every view that filters by status excludes it for
  free; the two places that don't (Unassigned, All) exclude it explicitly.
- **Guards file, not drop** (`lib/inbound/junk.ts` `decideDisposition`, pure):
  - `bulk-mail` and `ignored-sender` → **Junk** (a real customer could hide
    here — bulk-mail is the exact rule that ate support@ group mail).
  - `own-address`, `automated`, `no-sender` → **still dropped**. These are
    provably not a customer with a question (our own outbound, auto-replies,
    bounces), and filing them would bury the reviewable drops under our own
    notification mail. Reconciliation still accounts for them.
  - A **spam override** files to Junk; a **not_spam override** forces the inbox
    even past a guard; the **classifier** files to Junk only at a deliberately
    high confidence.
- **The classifier bias is explicit** (`VENDOR_JUNK_THRESHOLD = 8`, with the
  asymmetry comment). Priority threshold is 4; junk threshold is 8; the gap is
  the uncertain zone that stays in the visible inbox. 8 is unreachable on
  phrasing alone — it needs structural marketing machinery a customer does not
  produce by accident. Missing spam costs 5 seconds; junking a customer costs
  the customer.
- **Corrections, both ways, undoable** (`lib/inbound/corrections.ts`,
  `app/actions.ts`). "Not spam" → inbox unassigned; "Mark as spam" → Junk. Both
  write a `spam_corrections` row snapshotting the message + the classifier's
  verdict/score at the time (so the corpus outlives the 30-day purge), and both
  set an immediate per-sender override so the next message from them is filed
  the same way. **No auto-retraining, no automatic threshold moves** — the
  failure mode of a drifting filter is discarding customers, silently.
- **Sender overrides** (`lib/senders/overrides.ts`). Address always; domain too
  — but never for a freemail provider (marking gmail.com spam would junk every
  Gmail customer). Undo removes the override it created.
- **Scoring harness** (`lib/inbound/harness.ts`). Runs the current classifier
  against every stored correction and reports precision/recall split into false
  positives (customers junked) and false negatives (spam let through).
  Surfaced in Settings → Spam classifier. Any future rule change must be
  measured against this corpus first.
- **Reconciliation** reports `junked` separately from `stored`; a junked
  message is accounted-for, not missing.
- **Retention**: `purgeExpiredJunk` on the daily auto-close cron deletes junk
  older than 30 days and reports the count. `spam_corrections` survive the
  purge (FK `on delete set null` + snapshot).
- **Backfill**: `/api/admin/backfill-junk` (CRON_SECRET, dry by default) files
  recent guard-drops into Junk so there is something to review from on day one.

## Day-one findings (read-only dry run over the last 60 days)

190 messages examined, 136 already stored. Of the 54 fresh guard-drops:

| Disposition | Count | What they are |
|---|---|---|
| → Junk (recoverable) | **40** | All `ignored-sender`: Subi/Judge.me/B2Bridge/beehiiv/HulkApps/TestFlight/Optyo/Gmail onboarding — genuine vendor noise from the curated ignore list |
| → still dropped | **14** | All `own-address`: agent replies from melissa@/harvey@ — our own outbound, correctly not customers |
| → would go to inbox | **0** | The classifier junked **nothing** on its own — the threshold-8 bias is confirmed conservative |

**No hidden customers in the recent guard-drops.** The recoverable 40 are all
on the human-curated ignore list (real vendor noise); none are `bulk-mail` (the
dangerous group-rewrite rule) and none are customers. The 14 that stay dropped
are our own agents' replies.

**Precision/recall against corrections is not yet measurable** — the corrections
corpus is empty until the team starts correcting, which is exactly the asset
this drop creates. The harness will surface the numbers the moment corrections
exist; Settings shows "No corrections yet" until then. The conservative signal
we *can* report: the classifier flagged 0/54 recent messages as junk on its
own, so it is nowhere near junking a customer at the current threshold.

## Deploy order (non-negotiable)

**Apply 0025 then 0026 before merging/deploying** (0025 first — 0026's index
uses the enum value 0025 adds). The junk-filing insert references the new enum
value and columns; ordinary customer mail does not (the junk columns are added
to the insert only when filing junk), so a pre-migration deploy keeps normal
inbound flowing while the schema banner flags 0025/0026. After applying:

1. Dry run: `GET /api/admin/backfill-junk?token=$CRON_SECRET&days=60`
2. File them: add `&apply=1`.
