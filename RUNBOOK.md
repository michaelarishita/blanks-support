# Blanks Support — runbook

What to do when something breaks. Written so someone who isn't Michael can
follow it.

---

## Where everything lives

| Thing | Where | Who has access |
|---|---|---|
| The app | vercel.com → `blanks-support` | Michael |
| Database | supabase.com → `blanks-support` | Michael |
| Code | github.com/michaelarishita/blanks-support | Michael |
| Email API + OAuth | console.cloud.google.com → `blanks-support` | Michael |
| Domain DNS | godaddy.com → blankssportsnutrition.com | Michael |
| Team accounts | admin.google.com | Michael |
| Support mailbox | hello@blankssportsnutrition.com (Google Workspace user) | Michael |

**Secrets that cannot be recovered if lost** — these must be in the password
manager, not only in Vercel:

- `TOKEN_ENCRYPTION_KEY` — if this changes, every connected Gmail account
  breaks and all agents must reconnect
- `CRON_SECRET`, `GMAIL_WEBHOOK_TOKEN`
- `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`
- `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN`
- The `hello@` mailbox password

---

## First response to "the help desk is broken"

**1. Is the site up?** Open support.blankssportsnutrition.com. If it errors,
check vercel.com → Deployments. A red deploy → open it, read the build log.

**2. What build is live?**

```bash
curl -s https://support.blankssportsnutrition.com/login | grep build-sha
```

Compare to the latest commit on GitHub. A stale deploy and a broken feature
look identical from the outside — this distinguishes them in one step.

**3. Read the banner.** A red banner at the top of the dashboard names the
problem. It is accurate and it is not decoration. Two kinds:

- **Migration missing** → run the named `.sql` files from
  `supabase/migrations/` in Supabase → SQL Editor → New query.
- **Inbound email may be down** → see below.

---

## Inbound email has stopped

Symptoms: mail sits in the `hello@` mailbox and never becomes a ticket.

**Do not reconnect the support mailbox as a first step.** Reconnecting moves
the sync cursor to "now" and makes any stuck mail unreachable. It is a
state-changing action, not a diagnostic.

In order:

1. **Settings → Support mailbox → Check mail now.** It reports what it did
   and, crucially, *why* messages were skipped. Read the reasons.
2. **Check the watch hasn't lapsed:**
   ```sql
   select account_ref, watch_expires_at, last_history_id
   from oauth_tokens where is_support_inbox;
   ```
   Expiry in the past → visit
   `/api/cron/renew-watch?token=YOUR_CRON_SECRET`
3. **Check migrations are applied** — the banner will say. Missing columns
   make the sync fail.
4. **Check Vercel runtime logs** for the webhook and cron routes.
5. **Reconciliation** — Settings shows when it last ran and what it found. A
   timestamp older than 48h means reconciliation itself is broken.

**While diagnosing:** open the `hello@` mailbox in Gmail directly and answer
anything urgent by hand. Tickets can catch up; customers can't.

**Recovery of missed mail** is a backfill, not a re-sync — the sync only
looks forward from its cursor. That needs Claude Code.

---

## Replies aren't sending

Almost always: **that agent hasn't connected their Gmail.** Settings →
Connect Gmail. A reply saves but never sends without it, and the thread
shows "Failed — retry".

Otherwise check the message's delivery status in the thread; failures now
carry a real reason.

---

## Someone new joins the team

1. Supabase → Authentication → Users → Add user → **Auto Confirm** on.
2. They sign in at support.blankssportsnutrition.com.
3. They **connect their Gmail** (mandatory) and set their signature name and
   title.
4. Settings → their notification toggles as they prefer.
5. Send them `TEAM-GUIDE.md`.

## Someone leaves

1. Supabase → Authentication → Users → delete their user.
2. Reassign their open tickets first — deleting orphans the assignment.
3. Remove them from any routing rule that assigns to them (Settings →
   Routing rules), or the rule silently stops assigning.

---

## Routine maintenance

- **Gmail watch** renews itself daily by cron. If the renewal cron stops,
  inbound dies 7 days later — the banner catches this.
- **Vendor spam** — use "Never ticket this sender again" on the ticket, or
  Settings → Ignored senders.
- **Migrations** — every `.sql` in `supabase/migrations/` must be run in
  order. The banner tracks which are outstanding and distinguishes "not run"
  from "couldn't check".

---

## Escalation

If it can't be resolved from this page: open Claude Code in the project and
describe the symptom plus what you've checked.

```bash
cd ~/Projects/blanks-support
claude
```

It reads `CLAUDE.md` automatically, which carries the architecture and every
gotcha this system has taught us.

---

## The failure mode to watch for

Nearly every incident this system has had took the same shape: **something
failed and reported success.** A sync that errored and said "no new mail". A
schema check that couldn't run and said "missing". An empty inbox list while
8 tickets existed.

If a number looks wrong, distrust the reassuring reading first. The
reconciliation job exists precisely because every other alarm watches a
mechanism, and each outage found a new mechanism to break.
