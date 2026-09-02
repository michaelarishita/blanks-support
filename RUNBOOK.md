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
curl -s https://support.blankssportsnutrition.com/api/version
# {"buildId":"a1b2c3d…"}
```

That is the commit sha the server is running. Compare it to the latest commit
on GitHub: a stale deploy and a broken feature look identical from the
outside, and this distinguishes them in one step.

The same value is stamped on every page as `data-dpl-id` on the `<html>`
element, which is how a browser tab knows whether it is out of date.

**3. Read the banner.** A red banner at the top of the dashboard names the
problem. It is accurate and it is not decoration. Two kinds:

- **Migration missing** → run the named `.sql` files from
  `supabase/migrations/` in Supabase → SQL Editor → New query.
- **Inbound email may be down** → see below.

Agents (non-admins) do not see these: every one of them names something only
an admin can do. They see a single calm line instead. If an agent reports "a
red message I don't understand", it is almost certainly the stale-tab screen
below, not a banner.

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

## "Server Action ... was not found on the server"

**This is a stale browser tab, not an outage.** Nobody needs to be paged and
nothing needs to be checked in the database.

It happens when a tab was opened before a new version shipped. The JavaScript
in that tab refers to server functions the new build no longer has, so the
next action — sending a reply, changing a status — fails. Everyone else, and
that same person in a fresh tab, is fine.

**The fix is to reload the page.** The app now says so itself: the error
screen reads "A new version was released — reload to continue", and a tab
that notices the change before anything fails shows a quiet "A new version
was released" bar with a Reload button.

**Nothing typed is lost.** Replies are saved to the browser as they are
typed, per ticket, and come back after the reload.

How to tell it apart from a real outage in one step:

```bash
curl -s https://support.blankssportsnutrition.com/api/version
```

If that answers, the server is up and this is a stale tab. If it does not,
you have a real problem — start at the top of this page.

---

## "Production is running old code"

The deploy failed and Vercel emailed about it, which is why you are reading
this instead: emailed alerts die in the noise, so the heartbeat raises a row.

**Go to vercel.com → blanks-support → Deployments, open the red one, and READ
THE BUILD LOG.** Everything below is a lookup table for what you find there —
it is not a diagnosis you can make from the outside.

### A failure in 4–6 seconds has three known causes

They look identical from here. Only the log tells them apart, and guessing has
already cost days.

| The log says | Cause | Fix |
|---|---|---|
| `npm ci` errors, or `EUSAGE` / lockfile out of sync | The lockfile was built with `--legacy-peer-deps`; Vercel runs strict `npm ci` | Regenerate the lockfile without that flag, or change the dependency. Never loosen the install. |
| Compiles, then `Error occurred prerendering page "/login"` and `@supabase/ssr: Your project's URL and API key are required` | A **build-time** dependency on a runtime secret — `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` missing or not scoped to Production | Restore the variable in Vercel → Settings → Environment Variables, scoped to **Production** |
| `The NEXT_DEPLOYMENT_ID environment variable value "dpl_…" does not match the provided deploymentId "…" in the config` | Something set `deploymentId` in `next.config.mjs`. Vercel sets its own and Next 16 refuses the mismatch | Remove it. Vercel's Skew Protection works from the environment with no config. |

### Reproducing it locally

The default `npm run build` will pass for all three, which is exactly how each
one shipped. To match the cloud:

```bash
rm -rf node_modules && npm ci && npm run build
```

That covers the first two — a clean tree has no `node_modules` and no
`.env.local`. The third only fires on a Vercel builder, so it needs both:

```bash
NOW_BUILDER=1 NEXT_DEPLOYMENT_ID=dpl_test npm run build
```

`NEXT_DEPLOYMENT_ID` alone is not enough: the check is gated on
`NOW_BUILDER`, and without it the build passes and proves nothing.

### What is actually being served

```bash
curl -s https://support.blankssportsnutrition.com/login | grep build-sha
```

Compare to the latest commit on GitHub.

Nothing is lost while this is broken — customers keep using the last good
build. What is lost is every fix since it.

---

## Facebook Messenger has stopped

Symptoms: DMs to the Blanks Page don't become tickets.

**The most likely cause is that Meta unsubscribed us**, and it tells nobody.
An app that fails to answer its webhook for an hour is dropped; the Page keeps
receiving messages and we simply never hear about them. From the inside it
looks exactly like a quiet week.

1. **Settings → Facebook Messenger** shows all four facts: subscription,
   token, last event received, and signature failures. Check it first — it
   asks Meta directly rather than reading our own records.
2. **If the subscription is gone**: developers.facebook.com → the app →
   Webhooks → Page → Subscribe, with `messages` and `message_echoes` ticked.
3. **If the token is invalid**: it is a System User token and does not expire,
   so an invalid one has been revoked. Regenerate in Business settings →
   System users → the Blanks user → Generate token, and update
   `META_PAGE_ACCESS_TOKEN` in Vercel.
4. **If signature failures are climbing**, compare `META_APP_SECRET` against
   the app's secret BEFORE assuming an attack. And check whether the failures
   are all on non-ASCII bodies — the log records `ascii=false` — which is a
   known Meta quirk about emoji, not a key problem. CLAUDE.md has the detail.
5. **Events queued but not processing**: the hourly heartbeat drains them. If
   the count is not falling, check Vercel logs for `[meta]`.

Nothing is lost while this is broken: the messages stay in the Page inbox, and
the daily reconciliation reports anything we never stored.

---

## "I attached a photo and you didn't get it"

First, check whether we ever saw it:

```sql
select original_name, issued_at, outcome, detail
from upload_grants
where issued_at > now() - interval '7 days'
order by issued_at desc;
```

| outcome | what happened | what to say |
|---|---|---|
| `stored` | it worked — look again in the thread | — |
| `missing` | we invited the upload; the bytes never arrived | ask them to resend |
| `rejected` | we got it and refused it; `detail` says why | usually too large, or a file type we don't take |
| `expired` | they picked a file and never submitted | — |
| null / unresolved | still in flight, or they abandoned the form | wait, then treat as expired |

The widget now blocks submit on a failed upload, so this should be rare. If a
customer removed a failed file and sent anyway, **the ticket body says so** —
look for a line in square brackets at the end of their message.

If the line says "a fault on our side", that is `storeAttachments` failing
after the ticket was created: the bytes reached us and we lost them. Check
Vercel logs for `[intake] attachment`.

The daily reconciliation reports these as counts. Rising `missing` means
browsers are failing to upload; rising `rejected` means customers are sending
things we refuse, and the `detail` will say which.

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
- **Meta webhook** — no renewal needed (the System User token does not
  expire), but the heartbeat checks hourly that the Page is still subscribed,
  because Meta drops a failing app without telling anyone.

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
