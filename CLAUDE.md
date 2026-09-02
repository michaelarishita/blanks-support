# Blanks Support — Claude Code briefing

Natively hosted help desk for Blanks Sports Nutrition. It replaced Gorgias and
is **live in production at support.blankssportsnutrition.com**, handling real
customer email every day. Built like the other Blanks apps (blanks-crm,
blanks-athletes-portal): Next.js 16 + React 19 + Supabase.

Nothing in this file is a rehearsal. Local development points at the
production database, and `main` deploys to the live site.

## Hard rules (non-negotiable)

**1. The gate is a single `&&` chain, and it ends in `git push`.**

```
npm run build && npm test && git commit ... && git push
```

Never `npm run build; npm test && git commit`. With `;` the build's exit
status is discarded and a failing typecheck commits anyway — that has already
happened once. The same applies to piping the build through `grep` to read its
output: `grep`'s exit status replaces the build's, so the chain succeeds even
when the build failed. If you need to filter build output, run the gate first
and inspect afterwards.

**2. The gate must include `npm ci` from an EMPTY node_modules.**

`npm run build` against a populated `node_modules` proves almost nothing about
the cloud build. Vercel starts from nothing, and so must the check:

```
rm -rf node_modules && npm ci && npm run build
```

`npm install` succeeds where `npm ci` fails, so it can never be used to
conclude the build is fine. And it is not only the lockfile: a clean tree has
no `.env.local`, which is how a build-time dependency on a runtime secret
stays invisible locally for months.

**A pushed commit is not a deployed commit.** Seven production builds failed
over four days and nobody was told; the only reason it surfaced was somebody
going to look. `curl -s <site>/login | grep build-sha` answers what is
actually being served, and the heartbeat now compares it against the head of
main — see the deploy check below.

**A change is not done until it is pushed.** Push by default once the gate
passes; only hold back if Michael says so. `main` deploys to production, so a
push is a release — which is a reason to run the gate, not a reason to sit on
finished work. "Committed, not pushed" has cost
three test cycles — Drop 7C, the dark widget, and the Safari upload fix — each
time because work that looked finished in the transcript was sitting in one
working copy where nobody on the team could reach it. A commit nobody can pull
is indistinguishable from no commit at all, and the person who finds that out
is whoever was waiting to test it.

Two things this does NOT license: pushing work that hasn't passed the gate
(that's what the `&&` chain is for), and pushing straight to `main` when a
branch was asked for. And `git add -A` still sweeps up unrelated files —
stage explicit paths, because a push makes that mistake much harder to undo.

**3. Test globs must cover every extension the suite uses.**

`vitest.config.mts` `include` is `tests/**/*.test.{ts,tsx}`. It was
`*.test.ts`, which silently skipped a whole `.tsx` file — the run reported
green having executed none of it. A green run that executed zero of the new
tests is worse than a red one, because it is trusted.

When adding a file type, verify the glob picks it up before trusting the
count: note the test count before and after, and confirm it moved by the
number of tests actually added.

**Corollary for both:** a test that has never failed has not been shown to
work. When adding a regression test, reintroduce the bug, watch it fail, then
revert — as done for the orphaned-author hydration fix.

## Commands

- `npm run dev` — dev server on localhost:3000 (Turbopack)
- `npm run build` — production build; must pass before any commit is pushed
- `npm test` — vitest; must pass before any commit is pushed
- Node 22+ preferred (`nvm use 22`); Node 20 works but Supabase libs warn

## Current state — live, in daily use

The help desk has replaced Gorgias and is the team's actual inbox: 86 email
tickets and 23 from the website widget at the time of writing, five agents,
one admin (Michael). Every phase below marked live is being used by real
people on real customer conversations.

- Website intake widget at `/widget` with topic picker → public POST
  `/api/tickets/intake` (honeypot + rate limit). Framing is restricted by
  `WIDGET_ALLOWED_ORIGINS`; see the CSP note in next.config.mjs.
- Dashboard: inbox views (Open / Mine / Unassigned / All / Resolved,
  channel filters), ticket thread, public replies + internal notes,
  statuses, assignment/hand-off, tags, priorities, macros with
  `{{customer.first_name}}` variable, realtime via Supabase Realtime
- Auth: email + password only (Supabase Auth). Users are created manually
  in the Supabase dashboard (Authentication → Users → Add user). Every
  auth user gets an `agents` row via DB trigger; roles: admin | agent.
- Schema: `supabase/migrations/0001_init.sql` — 13 tables incl. columns
  already in place for later phases (gmail_thread_id, meta_conversation_id,
  oauth_tokens, exports). RLS on everything; `is_agent()` / `is_admin()`
  helpers.

## Deployment — LIVE IN PRODUCTION

**support.blankssportsnutrition.com is live and handling real customer email.**
Treat every instruction in this file as acting on a production system with real
customers in it.

| | |
|---|---|
| Host | Vercel, project `blanks-support` |
| Domain | support.blankssportsnutrition.com (GoDaddy CNAME) |
| Database | Supabase project `blanks-support` |
| Source | github.com/michaelarishita/blanks-support, deploys from `main` |
| Verify what's live | `curl -s https://support.blankssportsnutrition.com/login \| grep build-sha` |

`/api/version` returns the same sha as JSON and is the nicer check — but it
only works once the commit that excluded it from the proxy matcher is
deployed. Until then it redirects to `/login`, so use the meta tag.

**Production can be behind `main`.** At the time of writing it was running
`768db6f` while `main` was three commits ahead. A pushed commit is not a
deployed commit — check the build sha before concluding a fix is live or that
a bug still exists.

### Do not carry "run migration NNNN" forward without re-checking

It happened: 0021 was reported as outstanding after it had already been run.
The cause was not a false negative — the banner was correct throughout — it
was that the instruction was written when the migration was authored and then
repeated later as a standing to-do that nobody re-verified.

**A migration instruction is a claim about the database, and it goes stale the
moment somebody acts on it.** Writing "0021 needs running" in a commit message
is fine — that is a note about a moment. Repeating it in a later summary is a
fresh claim, and it needs a fresh check:

```
select count(*) from pg_class where relname = '<the table it creates>';
```

or, from the app, `checkSchema(true)` — which is the same thing the banner
does and takes one call.

Passing a test in `tests/schema-check.test.ts` is NOT that check. Those tests
compare the checker's list against the migrations directory; **none of them
touches the database**, and a green run says nothing about what has been
applied.

### Migrations are run BY HAND

Nothing applies them automatically. Every `.sql` in `supabase/migrations/` is
pasted into the Supabase SQL editor, in order, by a person — currently only
Michael. 0001–0021 exist.

**So a deploy can ship code that needs a migration nobody has run yet.** That
is the single most common way this app breaks, which is why the schema banner
exists and why it distinguishes "not run" from "couldn't check". When adding a
migration, say so in the commit message and in the hand-off.

### What is connected

- **Gmail (Phase 2, live).** `hello@blankssportsnutrition.com` is the watched
  support mailbox. Inbound arrives by Pub/Sub push to
  `/api/webhooks/gmail`; the watch is renewed daily by cron and expires in
  seven days if that stops. Agents connect their own Gmail for outbound —
  currently Michael and Jon have; Wes, Harvey and Melissa have not, so their
  replies fall back to the shared mailbox.
  **`support@` is a Google Group forwarding to `hello@` and must not be
  connected or watched by this app.**
- **Shopify (Phase 4, live).** Store `dd0cc7-2.myshopify.com`, read-only, via
  the client-credentials grant. The 24-hour token is cached encrypted in
  `oauth_tokens` (provider `shopify`).
- **Meta / Messenger (Drop 9, code shipped, NOT yet receiving).** Credentials
  are set in Vercel; the Page is not subscribed to the webhook yet, and no
  Meta event has ever arrived. Ticket counts by channel are the proof:
  86 email, 23 web_form, 0 messenger, 0 instagram.

### How inbound push is wired (reference, already done)

Not a to-do list — this is how the live system is put together, kept because
two of these are invisible when wrong:

1. Google Cloud → Pub/Sub topic, `GMAIL_PUBSUB_TOPIC` =
   `projects/<project>/topics/gmail-inbound`.
2. `gmail-api-push@system.gserviceaccount.com` holds **Pub/Sub Publisher** on
   that topic. **Without it Gmail cannot publish and says nothing** — inbound
   simply stops.
3. A **push** subscription targets
   `/api/webhooks/gmail?token=<GMAIL_WEBHOOK_TOKEN>`.
4. `users.watch` is called for `hello@` (`watchGmailMailbox` in
   lib/google/gmail.ts). **The watch expires every 7 days** and is renewed by
   the daily cron; if that lapses the mailbox keeps receiving and tickets just
   stop appearing.

The Meta webhook is the equivalent for Messenger and is **not yet wired** —
the Page has never been subscribed. Steps are in RUNBOOK.md.

### Cron jobs (vercel.json — that file is the source of truth)

| Schedule | Path | What breaks without it |
|---|---|---|
| `*/10 * * * *` | `/api/cron/notifications` | reminders, escalations, the daily unassigned digest |
| `0 * * * *` | `/api/cron/inbound-heartbeat` | nobody learns inbound has stopped; the Meta queue stops self-healing |
| `20 * * * *` | `/api/cron/retry-sends` | failed replies are never retried |
| `0 4 * * *` | `/api/cron/renew-watch` | the Gmail watch lapses and inbound dies silently after 7 days |
| `30 4 * * *` | `/api/cron/auto-close` | no auto-close, no upload sweep, no reconciliation |

All are authorised by `CRON_SECRET`.

### Environment

`.env.example` documents every variable and is the list to check against.
Two that carry teeth:

- **`TOKEN_ENCRYPTION_KEY` must never change.** Every stored OAuth token
  becomes undecryptable if it does, and every agent has to reconnect.
- **Do not set `NEXT_PUBLIC_MAIL_POLL_SECONDS` in production.** Pub/Sub push
  replaces polling there; setting it adds a redundant poll on every dashboard.

### LOCAL DEVELOPMENT USES THE PRODUCTION DATABASE

`.env.local` points at the same Supabase project as production. There is no
staging database and no seed data.

This is worth saying plainly because nothing on screen distinguishes them:
running the app locally reads and writes **real customer tickets**, a local
"Check mail now" consumes the **real Gmail cursor**, and a script that deletes
rows deletes them for everybody. When probing, create and remove your own
records rather than editing existing ones, and prefer read-only queries.

### If production is broken

`RUNBOOK.md` is the procedure — start there, not here. It is written for
whoever is on hand rather than for whoever wrote the code.

**Do not delete or re-create the Vercel project.** An earlier version of this
file recommended exactly that as a recovery step, from a time when the app was
not deployed. It would now destroy a live system's environment variables,
domain binding and cron schedule, and none of those are reproducible from this
repository alone.

### The build must not need a runtime secret

`/login` is statically prerendered, and it used to call `createClient()` in
the component body — which runs on the SERVER at build time. `@supabase/ssr`
throws without `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY`, so a missing env var
did not degrade the login page: **it failed the entire production build**,
compile succeeding and export dying on `/login` in about four seconds.

That coupling is backwards. A login page that renders and reports it cannot
reach Supabase is strictly better than a deploy that never lands and leaves
stale code serving customers. The client is now built inside the submit
handler, so it only ever runs in a browser, and `npm run build` succeeds with
no environment at all — verified from a clean clone with `.env.local` deleted.

**The general rule: nothing that runs at build time may require a secret.** If
a prerendered page needs a client, construct it lazily.

### Never set `deploymentId` in next.config.mjs

It cost four days of unshipped work. Vercel sets `NEXT_DEPLOYMENT_ID` to its
own `dpl_...` value; Next 16 compares that against a config `deploymentId` and
**throws before compiling anything**, which is a four-second build failure with
nothing useful on screen.

The trap is that it only fires on Vercel. The check is gated on
`hasNextSupport`, which is `!!process.env.NOW_BUILDER`, so every local build
passes and the config looks correct. Simulating it needs BOTH
`NOW_BUILDER=1` and `NEXT_DEPLOYMENT_ID=dpl_...` — the env var alone proves
nothing.

**The docs and the implementation disagree in 16.3.0.** The page says "if both
are set, the config value takes precedence over the environment variable";
`server/config.ts` throws on the mismatch and then runs
`result.deploymentId = process.env.NEXT_DEPLOYMENT_ID` unconditionally. So on
Vercel our value could never have been used even if it had been let through.
Read the code, not the page.

With no config value, Vercel's own id is picked up from the environment and
Skew Protection works as intended — verified in a built server:
`data-dpl-id="dpl_..."` on `<html>`.

**The app's build identity is deliberately separate.** The `build-sha` meta
tag, `/api/version` and `VersionWatcher` all source from
`VERCEL_GIT_COMMIT_SHA`, not from `deploymentId` — Vercel's `dpl_...` is a
different value with a different lifetime and is not what anyone means by
"which commit is live". A test asserts the config stays clean, because
re-adding it reads like an improvement and fails invisibly until production.

### Nothing was watching the thing that ships the app

Every subsystem here has a heartbeat except the deploy. `lib/deploy-health.ts`
compares the sha production is actually serving — read from the live site's
`build-sha` meta tag, not from Vercel's API, because what a CUSTOMER is being
given is the question — against the head of main, and alerts through the same
`system_alerts` row as the mailbox and Messenger checks.

Deliberately NOT Vercel's notification emails: an emailed alert dies in the
noise, which is why alerts became a row first and an email second.

- **`unknown` never collapses into `behind`.** An unreachable site or a
  GitHub rate limit says nothing about whether a deploy succeeded, and
  "production is stale" would send somebody to re-deploy a system that was
  fine — the schema banner's lesson, applied to the thing that ships the
  schema.
- **"They differ" is not the alarm; "they have differed for six hours" is.**
  A deploy takes minutes. The divergence clock is persisted and RESTARTS
  whenever the pair changes, so a new push cannot inherit the previous
  divergence's age and alarm instantly.
- Shas are compared by common prefix: the site serves 7 characters, GitHub
  returns 40, and a false "behind" from a formatting difference would be the
  most annoying possible version of this alarm.

## Hard-won gotchas (do not re-learn these)

- NEVER import @supabase/ssr (or anything Supabase) in middleware/proxy —
  it bundles code that references `__dirname` and crashes Vercel's edge
  runtime. Current proxy.ts does a cookie-presence check only; real
  auth verification lives in `app/(dashboard)/layout.tsx` via
  `supabase.auth.getUser()`.
- Keep the dependency tree resolvable WITHOUT --legacy-peer-deps. Vercel
  runs strict `npm ci`; a lockfile built with legacy peer deps fails the
  cloud build in ~4s. Test with: `rm -rf node_modules && npm ci`.
- Next 16 async request APIs: `cookies()`, `params`, `searchParams` are all
  Promises — always await.
- `lib/supabase/admin.ts` (service-role, bypasses RLS) is for API
  routes/webhooks only. Never import it into anything client-reachable.

### A Google Group rewrites `From`. This cost us an outage.

`support@` is a Google Group forwarding to `hello@`. Groups replaces the
**From** header with the group address for DMARC reasons —
`"'Jane Doe' via support" <support@blankssportsnutrition.com>` — and keeps the
author in `X-Original-Sender` / `X-Original-From` / `Reply-To`.

An earlier note here asserted Groups rewrites only `Sender` and `Return-Path`.
That was wrong, and because `support@` is in both our own-addresses set and
`IGNORED_SENDER_EMAILS`, **every message forwarded through the group was
discarded as our own mail** — silently, for as long as the group has existed,
while the mailbox merely looked quiet.

`effectiveSender()` substitutes the recorded author, and `resolveAuthor()`
files the ticket under them (otherwise every group customer collapses into one
`support@` record with one shared thread). The substitution is narrow on
purpose — only when `From` is an address already declared in
`TRUSTED_FORWARD_ADDRESSES` — because otherwise setting one header would be a
way past loop protection. The auto-reply guard still runs first, so our own
notifications are dropped whatever they claim about authorship.

A From rewrite is also now the strongest evidence for suppressing the
bulk-mail rule: only the list itself can perform it.

### Two silences that made it hard to see

**A store failure is not a skip.** A guard dropping a digest is the system
working; an insert failing is the system broken. They were both `countSkip`,
so a schema error read as "nothing new today". Failures are their own list,
they set `result.error`, and **the cursor is held back when any occur** —
advancing past a message we could not write is what turns a transient error
into permanent loss.

**"Check mail now" never renders a result line for a failed sync.** The error
used to raise a toast that vanished in four seconds, leaving "Checked 0 · 0 new
tickets" underneath — indistinguishable from a quiet morning.

**The heartbeat can now tell "no mail arrived" from "mail arrived and we
dropped all of it."** Those are identical in the tickets table and need
opposite fixes. The sync records what it discarded; the alert names it.

## A failure must never render as an absence

The house rule, learned four times now: **an empty state, a zero, or a 404 is
a CLAIM about the data. A failed query has not made one.** The two look
identical on screen and need opposite responses, and the wrong one always
looks like the calm one.

- Read the error. `const { data } = await supabase...` discards it, `null`
  becomes `[]` or a missing row, and the page says "Inbox zero" over eight
  live tickets. Destructure `error:` on every list and count query that
  renders something.
- Render the reason, do not throw it. A server-component throw arrives in
  production as a digest with the message stripped — the one useful part.
  `components/QueryError.tsx` is the shared block; the dashboard error
  boundary is the fallback, not the plan.
- Order matters: the error branch goes ABOVE the empty-state branch. Below
  it, it is unreachable for the exact case it exists to catch, because a
  failed query returns zero rows.
- `.single()` reports "no rows" as error `PGRST116`. That one IS a 404 and
  must still fall through to `notFound()`.
- Counts pass `null`, not `0`, when the query failed. The badge disappears
  instead of lying about the number.

`tests/query-error-honesty.test.ts` asserts all of this structurally, over
the source, because "a failure never renders as an absence" is a property of
the code's shape — calling a function that works cannot observe it.

### A poison message must not take the channel down with it

The cursor is held back when a message fails to store. That is right, and it
is what turned three unreadable messages into a 31-hour inbound outage.

**A Gmail 404 on `messages.get` is TERMINAL, not a failure to retry.** The
message does not exist; no number of attempts will make it appear. It is now
`countSkip`, never `result.failures`, so it can never hold the cursor —
`isGoneFromMailbox` in lib/google/inbound.ts.

Where they come from is worth knowing, because the volume is ours: **sending
through the Gmail API creates a draft, the draft gets a message id,
`messagesAdded` records it, and the draft is destroyed the instant it becomes
a sent message.** The id stays in the history page forever and 404s forever.
37 of the 89 ids in the backlog were these — almost all of them notification
mail we sent ourselves. More outbound meant more poison.

Two things made it invisible for as long as it lasted:

- **One `try` wrapped both the fetch and the store**, so a Gmail failure was
  reported as a database one. The alert read "3 failed to store", which sent
  someone looking for a missing column, a constraint violation and an RLS
  problem — none of which existed. Fetch and store are separate phases with
  opposite cursor behaviour and are now caught separately.
- **The failure was recorded as a bare `e.message`** — no phase, no message
  id, no Postgres code. `countFailure` records all three, and the alert now
  carries the first real cause instead of a count of them. A count is not a
  cause, and the alert is the only part of this anybody reads.

`countSkip(result, "could not create ticket")` was the same swallow as the
message insert, one level up: a failed ticket INSERT counted as a deliberate
drop. Both are failures now.

**Only ~25 ids are processed per run.** So the banner's "3" was three out of
the first slice, not three in total — a blocked cursor under-reports its own
backlog, because it never gets far enough to count it.

### Reconciliation: the one check that watches the OUTCOME

Every other alarm here watches a MECHANISM — the sync ran, the cursor moved,
the watch is alive, the schema is applied. Every outage so far found a new
mechanism instead: a guard that discarded group mail, a 404 that held the
cursor, a reconnect that skipped it forward. Each was invisible to the alarms
that existed, because each alarm had been built from the previous failure.

`lib/inbound/reconcile.ts` asks one question daily, and it is deliberately not
about any mechanism: **is there mail in the mailbox we have neither stored nor
deliberately dropped?** That question stays right regardless of what breaks
next, which is the entire point.

- **Verdicts are RE-DERIVED from the live guards**, via `backfillFromMailbox`'s
  dry run — never read from the skip counters the sync wrote. A recorded skip
  log is itself a mechanism; a reconciliation that trusts one is checking our
  record against our record.
- It must distinguish "we decided not to ticket this" from "we do not know
  about this". Stored, guard-dropped, quarantined and gone-from-Gmail are all
  fine. What is left is the alarm.
- **A one-hour grace period**, because the sync is not instant and
  reconciliation must not race it. Mail that landed a minute ago is not
  evidence of anything.
- **A clean run is RECORDED** (`inbound_last_reconcile` in settings, shown in
  Settings → Support mailbox) so its silence means "checked" rather than
  "possibly dead" — and monitoring treats a timestamp older than 48h as its
  own degraded reason. A safety net nobody verifies is a decoration.
- **A clean run does not EMAIL.** A daily all-clear is the hundred-FYIs problem
  in a new place; the record is the report.
- A run that could not complete records `at: null` and raises its own alarm. A
  broken reconciliation reading as a healthy mailbox is the exact inversion
  this job exists to prevent.
- `-in:sent -in:draft` excludes our own outbound (and the drafts that generate
  the poison ids); spam and trash are excluded because Gmail filed those, not
  us, and treating Gmail's spam calls as our misses would make this noise.
- No silent caps: a window that filled up says so, in the alert and on screen.

### The digest 0018 said would wait for evidence

The evidence arrived: eleven Normal tickets landed unassigned in one day and
nobody was told, because narrowing new-ticket mail left an ordinary unclaimed
ticket arriving in total silence.

`agents.watch_unassigned_digest` (0020, seeded for michael@/melissa@, governed
from Settings afterwards) — count of unassigned open tickets, the three that
have waited longest, and everything past its priority's `ESCALATE_AFTER_HOURS`
threshold.

- **Nothing is sent when the queue is empty.** A daily "0 unassigned" is the
  flood again.
- Age is measured from the customer's LAST MESSAGE, matching escalation: the
  number that matters is how long the person has been waiting.
- Overdue is ranked by how far PAST the threshold, not by raw age — a 9h Urgent
  needs attention before a 50h Low, and the ages say the opposite.
- It rides the ten-minute notifications cron and is gated on the LOCAL DATE
  rather than on a firing, so a missed tick catches up on the next one instead
  of skipping the day. A digest that silently stops arriving is the failure
  mode here, and "the cron fired" is not the same as "the mail went".
- The date is stamped only when a send actually succeeded, so a bad morning is
  retried rather than counted as done.
- Never the `[⚠️ BLANKS SYSTEM]` prefix. That filter only keeps working while
  nothing routine uses it, and a daily digest is as routine as mail gets.

### The cursor: two opposite ways to lose mail

A HELD cursor stalls the channel and is loud about it. A cursor MOVED past
unread mail is silent — the next sync truthfully reports nothing new and the
mailbox looks quiet. Both were live at once during the outage.

- **Reconnecting the mailbox used to anchor the cursor at "now",
  unconditionally.** Right on a first connect (otherwise the first sync turns
  years of archive into tickets), catastrophic on a reconnect. It is what
  consumed the 89-message backlog: somebody reconnected while trying to fix
  inbound, and the reconnect did the one thing that made the stuck mail
  unreachable. Guarded on `!connection.last_history_id` now, the way
  `renew-watch` always was.
- **`history.list`'s `historyId` is the MAILBOX's current id, not the end of
  the page you read.** The old code flattened the feed, sliced to 25, and then
  advanced to it — so any backlog over one run's worth lost everything past
  the first 25. Records are kept whole now, with their own `id`, and a
  truncated run resumes from the last record it actually consumed. A record
  with no id leaves the cursor alone: standing still is recoverable, skipping
  ahead is not.

### Quarantine, and the guard that makes it safe rather than dangerous

Holding the cursor for a failed message stays the DEFAULT. Quarantine
(`lib/inbound/quarantine.ts`, 0019) only decides when to stop retrying, so one
permanently-unstoreable message cannot take the channel down again.

**A plain attempt counter would be an automatic data-loss machine.** A missing
column, an RLS change, an expired key, Postgres down — these fail EVERY
message. A counter alone would quarantine the entire mailbox three runs later,
one batch at a time, running fastest exactly when something is most broken.

So quarantine needs positive evidence that the system works and this message
is the exception: **something else in the same run got through the same
phase.** Fetch and store are judged separately, because a Gmail outage says
nothing about whether Postgres accepts writes. With no such evidence nothing
is quarantined and the cursor stays held — blocked and loud is the safe
failure here; skipped and quiet is not.

- The evidence is `storedMessages`, NOT `created + appended`. Those count
  TICKETS, and the ticket insert happens before the message insert — so a run
  where every message failed still had a non-zero `created` and told the guard
  the database was healthy at the exact moment it was not. A test caught this.
- Three attempts, across DISTINCT syncs (a message is processed at most once
  per run), before giving up.
- Nothing is deleted. The mail is still in Gmail; the row records that we
  stopped, why, and how many times.
- A failed read of the quarantine list aborts the run rather than reading as
  "nothing is quarantined" — putting every poisoned id back in front of the
  cursor on the one run where the database is already unhappy is how the
  channel re-blocks itself.
- It raises a `system_alerts` row, not an email, for the same reason
  everything else does. Settings → Support mailbox lists them with **Try
  again**; without a way back, quarantine is a deletion with extra steps.
- A release resets `attempts` to 0: it is a judgement that the cause is fixed,
  so it deserves the full three chances again.

### A migration checker that cries wolf is worse than none

`columnExists` was `return !error`. Every failure — a 5xx, a blip, an expired
key, a stale cache — rendered as "this migration has not been run", and the
check ran fifteen sequential requests, so one bad second reported a contiguous
RANGE of migrations as missing. That is how 0013/0014/0015 were declared
unapplied while all three were in place, twice, and being sent to re-run
migrations that were already there is how a person stops reading the banner
that exists to catch the real gap.

It is the house rule again, in the module whose whole job is raising alarms:
**an "it's missing" is a CLAIM, and a failed probe has not made one.**

- **Three states, never two**: `applied` / `missing` / `unverified`. Only
  `missing` gets the red banner and the ordered list of files to run;
  `unverified` gets amber and says the check could not run.
- **pg_catalog, not PostgREST.** PostgREST answers from a CACHED schema that
  lags DDL by design — so the old probe was least reliable in the minutes
  after a migration ran, which is exactly when somebody is looking. 0017 adds
  `schema_inventory()`, read in ONE call: one error, one honest "could not
  check", instead of fifteen chances to accuse.
- **Indexes and enum values are probeable now**, and that is not cosmetic.
  0013 IS its indexes — a half-applied 0013 (column present, dedupe index
  absent) used to report as done, and that is the state in which Meta
  redelivery silently doubles every message. 0014's real risk is the enum
  value, which no column probe can see. 0007 stopped being "unprobeable": a
  function is a row in `pg_proc`, and reading it does not invoke it.
- **PGRST202 is two different facts, and time is the only way to tell them
  apart.** PostgREST answers it both for "no such function" and for "my schema
  cache has not caught up", with the same code and the same message — and
  `information_schema` is NOT reachable through PostgREST (PGRST106), so there
  is no second oracle. The bootstrap check was therefore the one place this
  module could still cry wolf, and it would do it in exactly the situation it
  was built for: the moments after somebody ran 0017. A first sighting now
  reports "could not check"; only a PGRST202 that outlasts a 60-second grace
  is called a missing migration. Anything that is not PGRST202 never starts
  that clock, because a network error says nothing about which migrations
  exist.
- Everything else is checked against **pg_catalog through the inventory
  function**, which is live and immune to cache lag. Only the discovery of the
  function itself goes through PostgREST's cache — which is precisely why that
  one check needed the grace and the other twenty did not.
- A migration with genuinely no evidence declares `unprobeableReason` and is
  reported applied. **Never write a probe that cannot fail** — one that always
  passes looks exactly like one that works, which is the more expensive
  mistake. That is why 0018 is declared rather than probed.
- Storage is a separate service: a failed `listBuckets()` is `null`, not an
  empty set, so it can never read as "the bucket is gone".

### An alarm must not look like the hundred FYIs

The heartbeat was never broken. It fired four times, delivered correctly, and
was buried: ~200 notification emails from hello@ in fourteen days, nearly all
unread. **Delivery was not the problem; distinguishability was.**

A system alert is now a ROW first (`system_alerts`) and an email second. That
inversion is the point — a row persists until a person acknowledges it, which
is the one thing email cannot do.

- Prefix `[⚠️ BLANKS SYSTEM]`, which nothing else sends. A test asserts the
  notification templates never use it, so filtering on it keeps working.
- **Never threaded.** Fresh Message-ID, never In-Reply-To or References. An
  alert threaded onto a notification inherits that thread's read state, so
  opening an unrelated FYI marks the alarm read.
- **Repeats escalate rather than repeat.** The subject numbers each occurrence
  (Gmail threads on subject too, so identical subjects would collapse), and
  after three unacknowledged occurrences severity goes critical.
- The row is written on EVERY degraded check; only the *email* is
  rate-limited. An alert that under-counts itself cannot escalate.
- The banner is **acknowledged, never dismissed**, and records who and when.
  "I saw this" and "make it go away" must be the same action.
- `ALERT_WEBHOOK_URL` is an optional generic JSON POST (`text` + `content` —
  Slack, Discord, ntfy, Pushover all accept it). Best-effort with a timeout:
  it can never delay or block the email.

### Vendor noise: two mechanisms, and the classifier that was fiction

`ignored_senders` (table) is unioned with `IGNORED_SENDER_EMAILS` (env), so
adding a sender is a click on the ticket instead of a deploy. Domains match
subdomains — outreach rotates the local part, not the sending domain.

`lib/vendor/outreach.ts` is the low-confidence "likely vendor outreach"
signal. It is deliberately **not part of `risk_score`**: risk decides nothing
and this decides the starting priority, so merging them would revoke that
guarantee for the signals that must keep it.

Its only action is Low priority, bounded three ways and all three conditions
IN the UPDATE (`priority = normal`, `assignee_id is null`, only ever to low),
so a human in the same second wins. Never hides, resolves or deletes.

**The first version passed every hand-written fixture and scored ZERO on all
25 real vendor emails.** The veto listed topic words ("ingredient",
"subscription", "flavour") vendors write constantly, and the phrase list was
a picture of what spam sounds like rather than what it says. Rebuilt from the
corpus; those excerpts are now the test. **When a classifier's input is real
text, invented fixtures prove nothing — measure against the database.**

Two short-circuits, both absolute rather than score reductions: customer
language, and sponsorship/wholesale/ambassador language. An athlete's
sponsorship pitch is structurally identical to an agency's, and there is a
live routing rule sending Sponsorship to Michael.

### PostgREST embeds must name their constraint

Adding a second foreign key to a table we embed breaks every existing embed
of it, and breaks the WHOLE query, not just the embed. Migration 0015 added
`tickets.risk_dismissed_by → agents(id)`; from that moment `assignee:agents(*)`
was ambiguous and PostgREST answered `PGRST201` for the entire inbox list.
The counts survived only because they embed nothing.

Always `assignee:agents!tickets_assignee_id_fkey(*)`. Before adding an FK,
grep for embeds of the target table. `messages → agents` is still bare
because messages has exactly one FK to agents — that is a fact with an
expiry date, and the test above catches it when it expires.

### A banner an agent cannot act on is how banners stop being read

An agent testing on a phone reported "that red message up top which not sure
what that's about". It was the inbound-down alert: a Pub/Sub diagnostic, in
the loudest colour the app has, addressed to somebody who cannot act on it.

Every system alert names an admin action — a Pub/Sub subscription, a
migration, a mailbox reconnect. So `SystemAlertBanner` and `SchemaBanner` are
now **admin-only**, and agents get `agentFacingNotice()`: one calm line about
the only consequence they can observe ("Some incoming email may be delayed"),
plus who has been told, read from the admin list rather than hardcoded.

- It is `role="status"`, not `role="alert"`, and not red. There is nothing for
  the reader to do; dressing that as an emergency is how the real ones stop
  being read.
- **Silence is the default for an unclassified kind.** A new alert does not
  opt itself onto an agent's screen; somebody decides what it means for them
  first. `inbound_reconciliation_failed` is deliberately NOT agent-facing — a
  gap in our monitoring is not a gap in the mail, and saying "your email may
  be delayed" when it is probably fine is the false alarm in the other
  direction.
- Acknowledgement stays outside the collapse. "I saw this" must not be behind
  "show me the detail".

### The mobile height budget, measured

"Message visibility is cut off" was not one bug. It was the chrome budget
being oversubscribed, with the banner as the dominant term. Measured in real
WebKit at iPhone 13 size (664px):

| | before | after |
|---|---|---|
| alert banner | 235px (35%) | 52px collapsed · 47px agent line |
| thread visible | **70px** | **251px** admin · 304px agent |

70px is roughly one line of one message, which is what the complaint was. The
diagnostic detail was pushing the conversation off the screen.

- The alert detail collapses to a tappable line **on a phone only** — from md
  up there is room, and hiding it there would just make the alarm easier to
  miss.
- `TicketHeader`'s status/assignee/resolve cluster is `hidden sm:flex`, not
  because it is unimportant but because it is DUPLICATED: MobileContextSheet
  already carries all three. Two copies in 390px pushed the cluster off the
  right edge and printed it over the ticket subject.
- Still the biggest remaining consumer: the composer at 257px (mode tabs 40 +
  editor 115 + assignee line 17 + send row 36) plus the context bar at 48.
  That is 46% of the viewport and the obvious next lever — left alone for now
  because the reported problem is fixed and shrinking the composer changes how
  writing feels.

**How to re-measure.** `safaridriver` still needs the manual toggle, but a real
WebKit is one `npm i playwright && npx playwright install webkit` away —
install it OUTSIDE this repo so the lockfile stays `npm ci`-clean. Drive the
real login form, then read `clientHeight`/`scrollHeight` off the thread
scroller. Screenshots caught the header overflow that the numbers alone did
not; look at them.

### A stale tab is not an outage

A tab open across a deploy holds client JavaScript referring to Server Action
ids the new build has never heard of. The next action fails with
`Server Action "…" was not found on the server`, the error boundary shows it,
and it reads as the app being broken. It is one stale tab; a reload fixes it.

- **Detection matches on `error.name === "UnrecognizedActionError"`, with the
  message as a fallback.** Next ships `unstable_isUnrecognizedActionError` for
  exactly this, but in 16.3.0 it is not re-exported from any public entry —
  reaching it means a deep path into `next/dist/client/components/`. `name`
  survives an error crossing a boundary; the message survives a class rename;
  `instanceof` would be the most precise and the most brittle, failing
  silently whenever two copies of the module exist.
- The stale-tab screen shows **no framework text and no "Try again"**. The
  message is true and useless to the reader, and `reset()` re-renders the same
  stale bundle, so it would fail again identically. Only a reload helps.
- **`deploymentId` is set in next.config** from VERCEL_GIT_COMMIT_SHA. Next
  uses it for version-skew protection: `?dpl=` on assets, and a mismatched
  client navigation becomes a hard reload. Undefined in local dev on purpose.

**React strips server-rendered attributes on hydration, silently.** The
obvious way to know which build a tab loaded — read the sha the server put on
`<html>` — does not work. `data-dpl-id` (from deploymentId) and `data-build`
(from app/layout.tsx) are both in the served HTML, which is what makes
`curl … | grep build-sha` work, and both are GONE by the time any effect can
read them, because the client render does not produce them. Verified in
WebKit: present before hydration, `null` after.

So `VersionWatcher` takes its baseline from the FIRST answer of `/api/version`
rather than from the DOM. It needs no agreement between the server and client
bundles, and a change between two answers is exactly the thing being detected.
A null answer is never stored as a baseline — "we could not tell you" is not a
version, and storing it would make the next real id look like a deploy.

`/api/version` is excluded from the proxy matcher for the manifest's reason:
it exists to be polled, and a 307 to an HTML login page is a 200 that is not
JSON.

**Drafts already survive this** — the composer writes to localStorage per
ticket and per mode on every keystroke, so the reload the screen asks for
costs nothing. Verified end to end in WebKit rather than assumed.

**The migration hint is now conditional.** The error page used to tell
everybody "if this mentions a missing table or column, a migration hasn't been
run" — on every error, whatever it was. That sent somebody to the Supabase
dashboard hunting a problem that did not exist. `looksLikeSchemaError` gates
it: Postgres codes first, then the phrasings PostgREST and Postgres actually
produce. A pointer that is sometimes right teaches you to distrust it when it
is right.

### A public reply resolves

Most replies are terminal answers. Parking every one in `pending` filled the
queue with tickets that were finished in every sense except the recorded one,
and nobody ever revisited them.

**This is only safe because of the other half, which was already true**: the
`on_message_insert` trigger reopens a resolved ticket the moment the customer
writes back. Being wrong therefore costs nothing — the customer's own reply
corrects it. Verified against the live database, not assumed: resolved →
inbound message → open, while our own outbound reply and an internal note
both leave it resolved.

- **Public replies only.** A note is the team talking to itself; resolving on
  one would resolve a ticket without answering anybody.
- **Status alone decides it**, so every channel behaves identically — a test
  asserts no channel name appears in the rule.
- **The escape hatch is the point.** A reply that ASKS the customer something
  is the case where resolving is wrong: the ticket leaves the queue and nobody
  returns to it. The send toast says "Reply sent · ticket resolved" and offers
  **Keep open** for 12s rather than the usual 8 — a decision needs longer than
  an undo. `keepTicketOpen` is conditional on the ticket still being resolved,
  because in those seconds the customer may already have replied and the
  trigger may already have moved it; writing `open` unconditionally would
  stamp over a state that had moved on.
- **Auto-close now runs from `resolved_at`, not `last_message_at`.** These
  diverge by days in real rows — one resolved on the 28th had a last message
  from the 23rd, which is two days of grace instead of seven. Latent before,
  load-bearing now that the reply's own timestamp is what usually makes them
  coincide. `on_ticket_update` is an UPDATE trigger, so a row INSERTed straight
  to resolved carries no stamp — hence the `last_message_at` fallback, without
  which such a row would never auto-close at all.
- **A reopened ticket restarts the escalation ladder.** The clock already
  measured from the customer's last message; the RUNG did not reset, and each
  repeat needs `threshold * nextCount`. A ticket chased three times, resolved,
  then reopened would have waited 192h for a Normal ticket before anyone was
  chased again — and gone straight to an admin. `escalationsSinceCustomerMessage`
  counts only the rungs of the current round. That was a pre-existing quirk;
  resolve-on-reply turned reopen from occasional into the normal end of every
  exchange, which is what made it matter.

**`pending` is now written by nothing.** It stays in the enum because live rows
hold it and every reader still handles it — the reopen trigger pulls it back,
escalation suppresses it, and a reply resolves it, so the rows drain through
the ordinary flow instead of needing a migration.

**DECIDED (2026-08-30), so nobody re-opens it as a tidy-up:**

- **No cleanup migration.** Rewriting those rows would have to claim something
  false about them — `resolved` says they were answered and finished,
  `open` says nobody replied. Leaving the value is the only honest option, and
  each row leaves on its own the next time anybody touches the ticket.
- **When the count reaches zero, DELETE the badge — do not reword it.** The
  tempting move is to point "Waiting on customer" at `resolved` and say
  something like "Answered — waiting to hear back". That is worse than
  nothing: it puts a passive badge on the state that now ends most tickets,
  which is the visual noise resolve-on-reply exists to remove. The Resolved
  badge already says everything true, and "we're waiting on them" is now the
  DEFAULT meaning of resolved rather than a condition worth marking.
- `isWaitingOnCustomer`, the badge, and the enum value go together in one
  migration, or not at all — a half-removal leaves a reader for a state
  nothing can produce.
- If the distinction is ever wanted back (answered-and-expecting-a-reply vs
  answered-and-done), it needs a signal an agent sets DELIBERATELY — a
  follow-up flag or a snooze — not a status the system infers. That is what
  `pending` was pretending to be and never was.

The check, when the fortnight is up:

```sql
select count(*) from tickets where status = 'pending';
-- 5 on 2026-08-30, and it can only fall
```

### The composer idles as one line

The last of the mobile height budget. Measured in WebKit at iPhone 13 size:

| | composer | thread visible |
|---|---|---|
| before | 257px | 251px |
| idle | **61px** | **500px** |
| focused | 232px | 329px |

Idle it is a tap target plus a send glyph; focus expands it to the real thing.
Desktop is untouched — there the 257px costs nobody anything, so the collapsed
bar is `sm:hidden` and the composer is `hidden sm:block`.

- **`expanded` is DERIVED, not a stored flag**:
  `openedByTap || !isEmptyHtml(body) || Boolean(error)`. A draft or an unread
  send error holds it open on its own, so it can never fold over text somebody
  wrote or a message they have not read.
- **Blur only collapses when empty, and only when focus actually left.**
  `relatedTarget` inside the container means the tap went to Macros, the mode
  tabs or Send — folding then would take away the control just reached for.
- **The editor is hidden, never unmounted.** It holds the draft, and the
  restore effect only re-runs when the ticket or mode changes, so unmounting
  would drop text mid-sentence and not bring it back. The per-ticket,
  per-mode `draftKey` is unchanged: a note draft reappearing as a public reply
  is the one way this could do harm.
- **Focus happens in an effect keyed on `expanded`**, not in the click
  handler: focusing a `display:none` element silently does nothing, and at
  click time the editor is still hidden.
- The keyboard inset stays on the sticky wrapper. iOS does not shrink the
  layout viewport for the keyboard, and the expanded composer is exactly what
  would sit behind it.

The collapsed bar shows the note placeholder and keeps the amber tint in note
mode. Whether the customer sees what you type is the one thing that must never
be ambiguous, collapsed or not.

### Two gestures, one direction, one boundary

Opening the nav drawer is a rightward swipe. So is swipe-to-claim on a list
row. Both listening to the same touch gives you a row sliding open behind a
drawer, or a ticket claimed by somebody reaching for the menu — and an
accidental claim is a real cost, not a cosmetic one.

`EDGE_ZONE_PX` in lib/swipe.ts is the single boundary, and `isEdgeSwipe()` is
used by BOTH sides: the drawer only listens inside the strip, `SwipeRow`
abandons the touch outright inside it (it never records a start point, so a
fast gesture cannot engage first). Neither may hardcode its own number — a
test asserts that, because two thresholds drifting apart is silent.

The chip bar stays on the list: switching view is one tap there and two
through a drawer, and triage switches constantly. What the chips could not do
is exist on the ticket screen, so changing view from an open conversation
meant navigating away from it first. That is what the drawer is for, and why
the button is on both screens.

### Safari / WebKit — a blind spot in the test suite

Every test we run is Node or Chrome. **No test in this repo can see a WebKit
bug**, and the customer widget is the one surface where that matters: it is
public, and half the people using it are on an iPhone.

**`The string did not match the expected pattern.`** is WebKit's `SyntaxError`
for a whole family of unrelated failures, with nothing in it to say which:

| It really means | Chrome would have said |
|---|---|
| `postMessage` with a malformed `targetOrigin` | "Invalid target origin" |
| `new URL()` on a relative or empty string | "Failed to construct 'URL'" |
| `response.json()` on a body that isn't JSON | "Unexpected token '<'…" |

Rules that follow, all of them enforced by tests/widget-errors.test.ts:

- **Never show a caught error's own `.message` to a customer.** `setError(err.message)`
  is how that WebKit string reached the widget's error box. Only strings the
  SERVER sent in its JSON `error` field are customer copy; everything else maps
  through `lib/widget-errors.ts`.
- **Never call `res.json()` on a customer-facing path.** Read `.text()` and
  `JSON.parse` inside a try, so a non-JSON body (a platform 413, an HTML error
  page, an empty response) becomes our copy rather than the browser's.
- **Validate a `targetOrigin` before `postMessage`.** It THROWS on a malformed
  value rather than ignoring it, and from inside a ResizeObserver callback that
  throw is invisible to any surrounding try/catch. Don't validate with
  `new URL()` — it throws the same WebKit message and reproduces the bug.

**Reproducing anything here needs a real Safari.** `safaridriver` is installed
but refuses to start a session until Safari → Settings → Advanced → "Show
Develop menu", then Develop → "Allow Remote Automation" is switched on. That is
a manual toggle; it cannot be enabled from a script.

### The proxy buffers request bodies, and truncates at 10MB

Anything `proxy.ts` matches has its body buffered, and past 10MB Next
**truncates it and runs the route anyway** — logging "Request body exceeded
10MB" where nobody is looking. The route then gets a multipart body cut off
mid-file, `request.formData()` throws, and the customer is told "Invalid
request" about a photo that was fine. Two ordinary iPhone photos cross that
line.

`api/tickets/intake` is therefore excluded from the matcher. It loses nothing:
it is public anyway, and does its own origin check, honeypot, rate limiting and
content validation. **Any future upload route needs the same exclusion** — the
symptom points at the parser, not at the proxy.

## Structure

- `app/(dashboard)/` — authed UI (inbox, tickets/[id]); layout does auth
- `app/widget/` + `public/widget.js` — public customer form + embed loader
- `app/api/tickets/intake/` — public ticket creation endpoint
- `app/actions.ts` — server actions (reply, note, assign, status, tags)
- `components/` — Sidebar, TicketList, Thread, ReplyBox, TicketSidePanel,
  RealtimeRefresher (subscribes to tickets/messages, router.refresh())
- `lib/types.ts` — shared types, TOPICS list, status/channel metadata

## Roadmap

Status per phase, because the sections below mix shipped work with plans:

| | |
|---|---|
| Phase 1 — ticketing, widget, dashboard | **live** |
| Phase 2 — Gmail in and out | **live** |
| Phase 3 — Messenger / Instagram | code shipped, **not receiving** — the Page is not subscribed |
| Phase 4 — Shopify sidebar, rules engine, shortcuts | **live** |
| Phase 4 — SLA timers, snooze, merge, search, collision | **not built** |
| Phase 5 — CSAT, reporting, Ike export | **not started** |

The schema anticipates all of it; the schema existing is not the feature
existing.

### Phase 2 — Gmail (LIVE)
Replies send as real email from the responding agent's own Gmail, and mail to
hello@blankssportsnutrition.com becomes tickets.

**The watched mailbox is hello@, not support@.** support@ still routes to
Melissa's existing setup for the duration of the parallel run and must not be
connected, watched, or otherwise touched by this app.

- Per-agent OAuth at Settings → Your Gmail. Refresh tokens are AES-256-GCM
  encrypted in `oauth_tokens` (admin-only under RLS; every read/write goes
  through the service-role client, so token material never reaches a browser).
- Outbound: multipart/alternative branded email, threaded via
  In-Reply-To/References plus a `[BLK-n]` subject token. delivery_status goes
  queued → sent | failed, and failures are retryable from the thread and from
  Settings. Below the reply and signature, the previous message is quoted in
  the standard `On <date>, <name> wrote:` + blockquote form (and with `>`
  prefixes in the plain-text part).

**From / Reply-To — deliberate, do not "fix" this:**

| Header | Value | Why |
|---|---|---|
| `From` | `"Blank's Sports Nutrition" <agent's own Gmail>` | The company name is the display name; the ADDRESS is still the replying agent's, so the send is authorised as them and lands in their Sent folder. The format is a constant — `FROM_NAME_FORMAT` in lib/email/template.ts, switchable to `agent-at-company` or `agent` in one line. |
| `Reply-To` | SUPPORT_EMAIL (hello@) | Without it, a customer's reply goes back to one agent's personal mailbox — which the inbound watch does not read — and would never become a ticket. |

The two must stay different. Setting the `From` ADDRESS to hello@ would lose
the per-agent authentication and the Sent-folder copy; dropping `Reply-To`
would silently break inbound threading, and it would break it only for
replies, which is the hardest kind of gap to notice.

Consequence worth knowing: because `From` is per-agent, a Gmail thread
belongs to whichever mailbox created it — hence `tickets.gmail_account_ref`
and the 404-retry fallback in `deliverMessage`.
**A part labelled text/plain is not necessarily plain.** Ticket #1040 arrived
as multipart/alternative where BOTH branches were HTML, so `bodyText` was
filled from the "plain" part, the `if (!bodyText)` guard meant the HTML→text
conversion never ran, and the customer's message rendered as literal `<p>` and
`<a href=...>` in the thread. The converter was never the problem. Whatever
text we end up with is now run through `looksLikeHtml` and converted if it is
markup, which makes it independent of whether the sender labelled their parts
honestly. Anchor destinations are kept inline — `text (url)` — because the
link is frequently the whole point of the message.

**Attachments: "inline" means the BODY references it, and nothing else.**
Apple Mail and iOS Mail stamp BOTH `Content-Disposition: inline` AND a
`Content-ID` on ordinary photo attachments, because they preview them while
composing. The original filter trusted either header, so every photo emailed
from an iPhone was classified as a signature logo and silently dropped — the
ticket arrived with the body and no attachment, and no error anywhere.
`isReferencedByBody` in lib/email/parse.ts is the honest test: an explicit
`attachment` disposition settles it, otherwise the HTML has to point at the
Content-ID with a `cid:` URL. Emailed attachments now get the same size cap,
content sniffing and EXIF stripping as widget uploads, and a bad one is
skipped by name rather than failing the whole message.

- Inbound: `lib/google/inbound.ts` syncs the support mailbox. Routing
  precedence is token → References → thread id → sender+subject+recency, and
  the matched path is recorded in ticket_events. Loop protection drops
  automated mail, anything from our own addresses (agents, SUPPORT_EMAIL, the
  connected mailbox), and any address listed in `IGNORED_SENDER_EMAILS`.
  Bulk/mailing-list headers are a SEPARATE rule, because support@ is a Google
  Group forwarding to hello@ and Groups stamps List-Id, List-Unsubscribe,
  Mailing-list and Precedence: list on ordinary customer mail. Any address in
  `TRUSTED_FORWARD_ADDRESSES` suppresses the bulk rule only — never the
  auto-reply or internal-sender rules. Sender comparisons read the parsed
  `From` alone; Groups rewrites `Sender` and `Return-Path` to the group
  address, so matching those would drop group mail a second way. The unique
  index on gmail_message_id absorbs Pub/Sub redelivery. Every skip is counted
  by named rule and shown by "Check mail now".
- Dev vs prod: production uses Pub/Sub push to `/api/webhooks/gmail`; locally
  the dashboard can poll (NEXT_PUBLIC_MAIL_POLL_SECONDS) and Settings has
  "Check mail now". Same sync either way — and because local points at the
  production database, a local "Check mail now" moves the real cursor.

**Inbound push is ON in production.** The Pub/Sub topic, the push
subscription and `users.watch` are all in place, and the watch is renewed by
the daily `renew-watch` cron. If that cron stops, inbound dies silently seven
days later — which is what the heartbeat exists to catch.

### Advisory risk flagging (Drop 11)

Inbound tickets are scored at creation and, above a threshold, carry a
"Review carefully" notice listing the reasons. `lib/risk/signals.ts` is pure;
`lib/risk/assess.ts` gathers the facts and writes three columns.

**It decides nothing.** No auto-reply, no auto-assign, no auto-resolve, no
blocking. A test asserts that nothing outside the risk modules and the UI ever
reads `risk_score` — if the score ever reaches an action, that is where it
shows up first.

**The wording is a requirement.** "Review carefully" with the reasons listed,
never "fraud" or "suspicious" — asserted against the source, comments
stripped. Legitimate customers trip these constantly, and an agent who reads
an accusation and repeats it to a real person has done more damage than the
heuristic could prevent. The notice says so on screen.

**Never leaves the dashboard.** Internal only; a test asserts no risk wording
reaches the outbound email template.

The signal that matters most is the one that must NOT fire: a Shopify lookup
that could not run stores `null`, not `false`. Treating "we could not check"
as "no such customer" would put the most alarming signals we have on every
ticket in the inbox for the length of an outage.

Score and reasons are stored together so precision can be measured with
evidence later. Dismissals are recorded rather than clearing the score —
"somebody looked and judged it fine" is exactly the data needed to tune a
signal, and it must stay distinguishable from "never flagged".

File-sharing links in customer messages are marked in the thread and are never
clickable — inbound bodies render as plain text, and an unknown file share is
the thing an agent opens by reflex.

### New-ticket notifications (Drop 10)

Every new ticket, on every channel, emails the watchers from hello@.

**Narrowed in 0018, because the broadcast was the firehose.** Every new
ticket to every watcher was ~200 emails in fourteen days, nearly all unread —
the same burial the system alert was rebuilt to escape. Two routes now, and
they answer different questions:

- **Unassigned High or Urgent** → everyone with `notifications_enabled`. No
  new toggle: nobody owns it, so no assignment email covers it, and the
  priority is the evidence that waiting for someone to notice is not enough.
- **`watch_new_tickets`** → every new ticket at any priority. Unchanged
  meaning, still in Settings, no longer the only route and no longer seeded
  on. It was all-or-nothing before: a firehose or silence, and most people
  want neither.

Normal and Low no longer broadcast to anyone who has not explicitly asked for
everything. **No digest** — that is a new cron and a new template for mail
nobody reads; the toggle already covers the person who wants volume, and a
digest waits for evidence somebody does.

- **Per-agent toggle**, `agents.watch_new_tickets`, off by default. 0014
  seeded it on for michael@/melissa@/harvey@ and 0018 clears that seed — they
  are the only rows it was ever true for, so leaving it set would have meant
  the narrowing changed nothing for the only people it affects. That seed is
  DATA, not configuration — the Settings toggle governs it from there, and the
  list has no home in code because the team changes.
- Deliberately a SEPARATE column from `notifications_enabled`: that one is
  about mail concerning YOUR tickets. Someone who wants their own assignments
  but not a firehose of everyone else's is reasonable, and conflating the two
  would leave them no way to say so except by muting both.
- **Runs after the routing rules**, always. If a rule assigned the ticket, the
  assignee is already in `notifications` and gets excluded — two emails about
  one ticket in the same minute is how people learn to ignore both. Other
  watchers still get theirs. The exclusion is keyed on "has a notification for
  this ticket" rather than "is the assignee", so it holds in any order and
  covers a manual assignment made moments earlier.
- Only for tickets that are actually NEW. A reply on an existing thread is not
  news, and mailing everyone about every customer response is the fastest way
  to get the feature turned off.
- The assigned/unassigned fact is read at send time, AFTER the routing rules,
  so a ticket a rule just claimed counts as assigned and stays quiet.
- Threads per (watcher, ticket) through the same root as every other
  notification, so a later assignment or escalation replies into the notice.
- Quiet hours apply except for Urgent, same policy as escalations.
- **No queue block.** The shared template's "your outstanding queue" section is
  optional now and omitted here: this mail is about somebody else's ticket, and
  appending your workload to it turns a short notice into an unrelated nag.
- Loop protection is the existing three guards — X-Blanks-Notification,
  Auto-Submitted, and the from-our-own-address rule — each of which drops it
  independently, asserted in tests/new-ticket-notification.test.ts.
- Volume did make it annoying, and 0018 is the answer rather than a digest.

### Phase 3 — Instagram + Messenger (code shipped; NOT yet receiving)

**One endpoint, `/api/webhooks/meta`, for both channels** — that is what 9A's
choice of Facebook Login for Business buys: one app, one token store, one
webhook, one set of send logic.

**Signature verification is the whole security of that endpoint.** It is a
public URL that creates tickets. `lib/meta/signature.ts` HMACs the RAW body
with the app secret; the route reads `request.text()` FIRST and parses only
after the check passes. Parsing first and re-serialising to verify produces
different bytes — key order, spacing, unicode escaping — so every check fails,
and the tempting conclusion is that signature checking "doesn't work" and gets
removed. It fails CLOSED when META_APP_SECRET is unset: "nothing to check" is
how an endpoint ships unauthenticated.

- **GET is the handshake** and must echo `hub.challenge` as PLAIN TEXT. JSON —
  even the right value in quotes — fails verification with no useful error.
- **POST always answers 200** once the signature passes. Meta retries hard on
  anything else and disables a persistently failing subscription, so an event
  we cannot process is counted and stepped over, never thrown.
- 403, not 200, for a bad signature. Retry behaviour is a reason to
  acknowledge events we understand; it is not a reason to accept unsigned ones.

**Echoes swap the parties.** On `is_echo` the PAGE is the sender, so the
customer is the RECIPIENT. Reading `sender.id` as the customer files our own
reply under a "customer" whose id is the page — a ticket from ourselves, with
our words attributed to them. Echoes are stored `outbound` and `is_automated`
so they do not stamp first_response_at, and rules do not run on them: routing
a ticket because of something WE said would be nonsense.

**Dedupe is the unique index**, `messages_meta_message_id_uniq` in 0013 — same
discipline as the Gmail path, so the ingest does not have to be transactional
to be correct. It is INERT until 0013 is applied: without the index a
redelivery inserts a second row silently.

**Media is downloaded on receipt**, never stored as a Meta URL. Their CDN links
are short-lived, so storing the URL works in testing and 404s in front of an
agent hours later. DM photos go through the same sniff + EXIF strip as widget
uploads — a customer photo is a customer photo.

Story replies are tagged rather than treated as support requests, unsends mark
`deleted_at` rather than removing the row (so the thread cannot lie about what
was said), and reactions become ticket_events — a heart is not a ticket.

**Instagram rides the same plumbing, and that is tested rather than assumed.**
One webhook, one normaliser, one ingest; `object: "instagram"` is the only
switch. The genuine differences are which id column identifies the customer
(`ig_user_id` vs `fb_psid`) and which profile fields the Graph call asks for.
tests/meta-inbound.test.ts drives both channels through processMetaEvents with
Supabase and the Graph API faked at the edges.

### Meta's five-second deadline drives the whole architecture

Meta requires a 200 within **five seconds**. It retries immediately on
failure, alerts after fifteen minutes, and **UNSUBSCRIBES THE APP after an
hour of them** — which is a silent inbound outage with no signal of its own:
the Page keeps receiving messages, we keep not hearing about them, and the
ticket table looks like a quiet week.

So the endpoint does exactly two things before answering: check the signature,
and write the row. `meta_webhook_events` (0021) is the landing pad;
`lib/meta/queue.ts` drains it from `after()` once the response has gone.
Profile fetches and media downloads are Graph API calls whose latency is not
ours, and none of them may sit between the request and the response any more.

- **The one case worth a non-200** is failing to write the row. We do not have
  the event, so a retry is genuinely useful, and the unique index on
  `meta_message_id` makes redelivery safe.
- **A refused signature is still recorded.** A run of them is either somebody
  probing the endpoint or our own secret being wrong, and those need opposite
  responses — a count nobody kept cannot tell them apart.
- **The drain also runs on the hourly heartbeat**, which is what makes it
  self-healing: an event whose `after()` never finished — function killed,
  deploy rolled — is picked up within the hour rather than sitting forever.
- Attempts are capped, like the inbound quarantine. Nothing blocks behind a
  bad event here (there is no cursor), so it is a cost control rather than an
  outage guard — but a row at the limit is counted and the heartbeat says so.

### The emoji gotcha, before you rotate the secret

Meta documents the X-Hub-Signature-256 as computed over the payload in its
**escaped-unicode form** with lowercase hex. Hashing raw UTF-8 bytes — what we
do, and what every sane library does — agrees for any pure-ASCII payload and
disagrees for anything carrying an emoji or non-Latin text.

DM traffic is mostly emoji. So the failure will not look random: every message
with a 👍 fails while the plain ones keep working, which reads exactly like an
intermittent key problem and is not one.

The refusal log records `ascii=true|false`. **If failures are all ascii=false,
that is this quirk** — fix it by hashing the escaped form, not by rotating the
secret and not by weakening the check.

### No email is a real state now, and it broke a routing rule

Every path in this codebase was written when a customer had an email. The
schema always allowed null; nothing exercised it until Messenger.

**The bug this found:** `email_domain` with `is_not` was vacuously TRUE for a
customer with no address, so every "domain is not X" rule fired on every
social ticket — silently, changing assignment and priority on tickets the rule
was never about. A comparison that cannot be made is not a match, in either
direction. Same call already made for a blank condition VALUE; this was the
other side missing.

Deliberately NOT changed: `topic` behaves the same way and is left alone. A
null topic is a fact about the ticket — it genuinely has no topic — where a
null email on Messenger is a field that does not exist on that channel.

Everything else degrades correctly, and `tests/no-email-customer.test.ts`
holds the line: `canEmail` is false on channel alone, `customerDisplayName`
falls back rather than printing null, macros substitute
`[NO ORDER — CHECK BEFORE SENDING]`, risk scores an impossible Shopify lookup
as UNKNOWN rather than "no such customer" (or the most alarming signal we have
would be on every social ticket forever), and resolve-on-reply never reads an
address at all.

### The token Business settings gives you is NOT a Page token

**Business settings → System users → Generate token produces a SYSTEM USER
token.** The calls that matter — `/{page-id}/subscribed_apps`, the Send API —
require a **Page** token, which is DERIVED from it.

This is the sharpest version of a lesson this codebase keeps relearning:
**"the token is valid" and "the token is the right kind" are different
questions, and every generic check answers only the first.** A system user
token passes `/debug_token`, passes `/me`, and passed our own health check,
which reported `valid for BlanksHelpdesk` — every word true, and BlanksHelpdesk
is the system user, not the Page. That was the clue, and it was incidental.

The error makes it worse rather than better:

```
code 190, error_subcode 2069032
"Invalid OAuth 2.0 Access Token"
error_user_msg: "A Page access token is required for this call for the new Pages experience."
```

**Code 190 reads as "invalid token" everywhere**, and the advice that follows
— regenerate it — produces another system user token and the identical
failure. The subcode is the only thing that distinguishes them, and
`error_user_msg` is the only field that explains it. We were discarding both.

`lib/meta/page-token.ts` holds the knowledge instead of a runbook:

- **Which kind is configured is decided by asking, not by inspecting.** `/me`
  on a Page token returns the Page; on a system user token it returns the
  user. Nothing in the token string distinguishes them, so a prefix check
  would be a guess that works until it doesn't.
- **Either kind is accepted.** Paste a real Page token later and it is used
  directly. The operator should not have to know the difference — that
  knowledge is exactly what tripped us up.
- The derived token is cached encrypted in `oauth_tokens` (provider `meta`,
  `account_ref` = page id), the same pattern as Gmail and Shopify.
- **Rejection re-derives once before reporting failure.** A Page token from a
  non-expiring system user token should not expire — but "should not" is not
  a guarantee, and the failure mode without the retry is a silently dead
  channel.

The panel now says both facts:
`system user token (BlanksHelpdesk) → derived Page token for Blank's Sports Nutrition, cached`

### "API access blocked" is Meta's message, not ours — and it means the APP

Both Settings rows showed it, which read as a token problem and is not one.
Run against production credentials, every call fails identically:

```
GET /{page-id}/subscribed_apps  -> 400 {"message":"API access blocked.","type":"OAuthException","code":200}
GET /debug_token                -> 400 same          (authenticated as the APP, not the page token)
GET /me                         -> 400 same
GET /{app-id}                   -> 400 same          (the app reading its OWN metadata)
```

The control settles it: a deliberately invalid token returns **code 190**
("Cannot parse access token"), ours returns **code 200**. Different errors, so
the token parses and is recognised — the block is on the app, not the
credential. `debug_token` failing is the decisive one: it authenticates with
`app_id|app_secret` and involves no page permission at all.

**Code 200 + "API access blocked." = an app-level restriction.** App Review,
access level, or business verification — not something a new token fixes.

`lib/meta/graph-errors.ts` classifies a Graph refusal into the four things it
can be, because they need different people to do different things:

| kind | tell from | what it means |
|---|---|---|
| `token_invalid` | code 190 (subcode 463 expired, 467 revoked) | regenerate the token |
| `missing_scope` | code 200/10/3 naming a permission | the token lacks a scope |
| `app_restricted` | "API access blocked", app disabled/restricted | Meta has blocked the app |
| `unreachable` | no HTTP status at all | we never reached Meta |

The hard pair is the middle two: **both are code 200**, and the discriminator
is whether the message names a capability or says the app cannot call the API
at all.

**The evidence is always printed** — HTTP status, code, subcode, type,
fbtrace_id — even when the summary is confident. The trace id is what Meta
support asks for and the code is what a search needs. The old panel printed
`error.message` alone: a verdict with the evidence thrown away, which is the
failure shape this codebase keeps finding.

Consequence: an app-level block now reports **broken**, not "could not
check". The old regex (`/token|expired|revoked|session|OAuth|permission/`)
did not match "API access blocked." and so rendered a hard outage as a grey
dot.

### Watching Messenger: three questions, all of them silent

- **Is the app still subscribed?** Checked on every heartbeat against
  `/{page-id}/subscribed_apps`, because Meta unsubscribing us is the failure
  with no other signal anywhere.
- **Is the token still valid?** A System User token that does not expire —
  so a validity CHECK, deliberately no refresh flow. It can still be revoked.
- **Are signatures failing?** Counted over 24h from our own log.

A failed Graph call reports `unknown`, never `broken`. Telling somebody the
subscription is gone when the API merely timed out sends them to re-subscribe
a Page that was fine.

`lib/meta/reconcile.ts` is the outcome-watching half, on the daily cron: list
the Page's conversations through the Graph API and report any message we
neither stored nor deliberately dropped. Built on the Graph API rather than
the webhook log ON PURPOSE — reconciling our record against our record would
find nothing.

### 9E — outbound, and the window that will bite

Both channels send through the same Send API endpoint with the Page token.
**The sender is the BRAND, not the agent** — unlike email there is no
per-person identity on Meta. Which agent wrote it is recorded on the message
and shown in the thread; the customer sees one voice.

**Meta's reply window** (`lib/meta/window.ts`, pure and clock-injectable
because every interesting case is a boundary):

| Since the customer's last message | What happens |
|---|---|
| under 24h | free-form reply |
| 24h – 7 days | allowed, but the send must carry `HUMAN_AGENT` |
| past 7 days | nothing can be sent until they write again |

- The tag is DERIVED from the window, never a flag anyone can set — it is only
  legitimate for a human answering a question, and applying it to an automated
  send would be a policy violation rather than a bug.
- **A send that cannot succeed is refused BEFORE the message is stored**, the
  same guard as "connect your Gmail". A reply sitting in the thread looking
  sent, which the customer never received, is the worst available outcome.
- The window is **re-read at send time**, not trusted from the page that
  rendered the composer: a ticket left open for an hour has a stale countdown,
  and the send is where being wrong costs something.
- The Send API's own "window closed" error (code 10 / subcode 2018278) is
  named specifically, because "permission denied" would send someone to the
  app settings for a problem that is purely about time.
- Internal notes are never blocked. The team can still talk about a ticket
  they cannot answer.
- `meta_message_id` is stored from the send response, so the echo Meta returns
  for our own reply dedupes instead of appearing in the thread twice.

`mark_seen` fires when an agent opens a social ticket, fire-and-forget — a
read receipt is a courtesy and must not delay the thread rendering.

The countdown (`ReplyWindowNotice`) recomputes from the timestamp on a timer
rather than decrementing a stored number; a laptop that slept for two hours
would otherwise show a confidently wrong figure.

Still to build: outbound image attachments, and App Review if Standard Access
turns out to be insufficient (9A: read the actual error, do not speculate).

### Serving attachments — the guard that makes accepting any type safe

Email accepts ANY file type on purpose: a wholesale CSV or a signed PDF is a
legitimate thing for a customer to send. That is only safe because of how the
files are served.

**Inline rendering is a server-side allowlist of three raster image types**
(`lib/attachments.ts`). `?inline=1` is a REQUEST, not an instruction — it used
to be honoured unconditionally, which meant an HTML or SVG attachment could be
served with its own content type from the storage origin and execute there,
against whichever agent opened the ticket. SVG, HTML and PDF are excluded by
name, each with the reason, because a quietly-growing allowlist is how this
erodes. The thread UI imports the same list rather than keeping its own.

Anything not identified by content sniffing is STORED as
`application/octet-stream`, so even a signed URL fetched directly has nothing
to render. The database row keeps the declared type for display; the bucket
does not.

### Storage does not cascade

Deleting a ticket removes its `attachments` rows and leaves the objects. They
are customer photographs, so that is a retention problem before it is a
billing one — and it happens however the ticket went, including a hand-written
DELETE in the SQL editor.

`sweepDeletedTicketFolders` (daily, on the auto-close cron) removes per-ticket
folders whose ticket no longer exists. The signal is deliberately NOT age:
intake creates the ticket row BEFORE uploading under it, so a folder with no
ticket can never be an upload in flight. It **fails safe** — a failed ticket
lookup makes every folder look orphaned, so nothing is deleted unless we
positively know which tickets exist. Folders that are not ticket ids are left
alone and reported.

`/api/admin/backfill-attachments` re-fetches attachments Gmail still holds for
mail that arrived before the inline fix. Dry by default; `apply=1` writes.

#### Original plan
One Meta app; webhooks → `/api/webhooks/meta` (verify X-Hub-Signature-256,
dedupe by message id). DM conversation ↔ ticket via meta_conversation_id.
Reply + mark-seen via Send API using the stored page token. Enforce the
24-hour window; apply HUMAN_AGENT tag outside it. Capture echo messages.
Permissions (App Review): pages_messaging, instagram_manage_messages,
instagram_basic, pages_manage_metadata, Human Agent.

### Phase 4 — Shopify sidebar (LIVE) + power features (mostly NOT built)

**Built and live:** the Shopify sidebar, `{{order.*}}` macro variables, the
routing rules engine, and keyboard shortcuts.

**Not built**, despite being listed below and in places stubbed in the UI:
SLA timers, snooze (the button exists and is deliberately disabled), merge,
full-text search, and collision detection. Do not read the paragraph below as
a description of what exists — it is the plan.

Read-only Shopify Admin API app, created in the **Dev Dashboard** — custom
apps can no longer be made in the Shopify admin and there is no static
`shpat_` token. Env is SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID /
SHOPIFY_CLIENT_SECRET; `lib/shopify/token.ts` exchanges those for a 24-hour
token via the client credentials grant and caches it encrypted in
`oauth_tokens` (provider `shopify`). Do not reintroduce a static token, and
do not cache it in a module variable — see DROP-7-SPEC.md "Access tokens".
Customer 360 in TicketSidePanel:
recent orders + status + tracking, lifetime spend, order lookup by email /
order number. Macro variables {{order.*}}. Then: SLA timers, snooze, merge,
full-text search (Postgres FTS), collision detection (Supabase Presence),
keyboard shortcuts.

**Rules engine (Drop 7C — live).** DROP-7-SPEC said the `rules`
table already existed. It did not; `0011_rules.sql` creates it, along with
`messages.is_automated`.

- `lib/rules/` splits three ways on purpose: `types.ts` (shapes + the single
  validator), `evaluate.ts` (pure matching, no I/O), `engine.ts` (the DB side).
  The dry-run calls the same `ruleMatches` the live path calls, so "would have
  matched" and "did match" cannot disagree.
- Admin UI at Settings → Routing rules (`/settings/rules`). Reorderable,
  testable against the last 50 tickets before enabling, seeded with the four
  rules in the spec — all disabled.
- Triggers fire from the intake route and from `ingestMessage` in
  `lib/google/inbound.ts`. `runRulesSafely` never throws: a broken rule must not
  turn a received customer message into a 500 or abandon a mail batch.
- Semantics that are deliberate, not accidents:
  - **Facts are snapshotted before the run.** A tag added by rule 1 is invisible
    to rule 3. Cascading would make outcomes depend on ordering nobody can see,
    and the dry-run could not model it.
  - **First assignment wins, and a ticket with an owner is never reassigned.**
    The UPDATE is conditional on `assignee_id is null`, so a human claiming it in
    the same second beats the rule instead of being silently overwritten.
  - **The assignment email is sent once, after every rule has run**, so the
    priority prefix in Harvey's subject reflects a priority a later rule raised.
  - **A rule with zero conditions matches nothing.** `every` over an empty array
    is true, which would have auto-assigned the entire inbox to one person.
  - **A blank condition value is false for negative operators too.** Vacuous
    truth would make a half-finished "subject contains none of" match everything.
  - **An auto-reply may only use `{{customer.first_name}}`.** `{{order.*}}` is
    refused at save time: nothing reviews an automatic send, so an order variable
    would mail `[NO ORDER — CHECK BEFORE SENDING]` to the customer, which is the
    exact outcome that placeholder exists to prevent. It sends at most once per
    ticket and never once a human has replied.
  - `is_automated` keeps an auto-reply from stamping `first_response_at` — the
    trigger in 0011 replaces 0001's — so Phase 5 doesn't report a two-second
    human response time. The thread labels it "Automatic reply".
- Every firing writes a `ticket_events` row naming the rule AND its skips. A
  rule that matched and then did nothing is otherwise indistinguishable from a
  rule that never ran.

**Live routing (0012).** 0011's placeholders are deleted and replaced with the
real thing, ENABLED: Product/Wholesale/Events → Jon (Normal), Orders/Shipping
→ Harvey (High), Sponsorship → Michael, and refund keywords → High. The refund
rule is LAST on purpose — priority actions stack and the last write wins, so a
refund mention on a Product question ends at High instead of being reset to
Normal. A rule ships enabled only if its assignee's account resolves; a missing
account leaves it off, where the editor says "choose who this assigns to"
rather than firing at nobody.

### Topics — three homes, no foreign key

`TOPICS` in lib/types.ts (the picker), `tags.name` (what intake looks up BY
NAME), and `rules.conditions` (what routing matches on). Nothing in the
database ties them together, so a rename breaks two of them silently: a topic
with no tag row files untagged tickets, and a rule naming a retired topic reads
as live routing while being unreachable. `tests/topics.test.ts` reconstructs
the post-migration state from the SQL and asserts both directions.

Deprecating a topic means removing it from TOPICS and LEAVING THE TAG ROW —
deleting the row cascades through ticket_tags and rewrites history. That is
what happened to "Ambassador / athlete" in 0012.

### A failed upload must cost the customer a decision, not a photo

A customer attached a JPEG, the ticket arrived without it, and they were told
it worked. The upload failed in the browser; the widget filtered the file out
of `readyGrants` (which has always selected `status === "done"`); the server
never learned a file was meant to exist. Nothing rejected it, nothing logged
it server-side, and nothing could count it — the only record was a
`console.error` in the customer's own browser.

The intake route was innocent. A bad grant returns **400 with no ticket** and
logs the reason. The silent drop was in the widget.

- **Two automatic retries with backoff first.** The likeliest trigger is a
  moment of bad mobile data, and most of those clear on the next attempt.
- **Then the file blocks submit until it is retried or removed.** Not a hard
  block on the form: somebody on a bad connection who cannot file a ticket at
  all is worse off than somebody whose photo went missing — they came here
  with a problem. Removing the file is one tap and re-enables submit. The
  choice stays theirs; it just cannot be made by accident, which is what was
  happening.
- **A removed-because-failed file puts a line in the ticket body.** Counted
  only when the file had actually FAILED — removing one they changed their
  mind about is not a lost photo and must not say so.

### The upload ledger, because the rate was not merely unknown

When the report came in, "was an upload URL even issued?" had no answer. The
temp object is deleted on claim and swept after 24h; nothing recorded the
middle step. The rate at which uploads were being lost was **unknowable**, not
just unmeasured.

`upload_grants` (0022) is a row per minted URL, resolved at claim with the
reason: `stored`, `rejected`, `missing` (claimed, no object) or `expired`
(swept unclaimed). The sweep closes the ledger too — without that an
unresolved grant looks identical to a submission still being typed.

Reconciliation reports it daily as counts with reasons, alongside the mailbox
and Messenger checks. Same argument as those: **watch the outcome, not the
mechanism.**

Grants under two hours old are ignored: a submission genuinely in flight has
an unresolved row for as long as the customer is still typing.

### storeAttachments had the identical shape

It runs after the ticket exists, and on failure it logged, continued, and let
the response report success — a photo the customer believes they sent, a
ticket that does not mention it, an agent with no idea to ask. Not what
happened this time; the same bug one door down.

It now returns what it lost, the ticket body says so, and the orphaned object
is removed — the folder sweep only collects folders whose TICKET is gone, so
a failed row on a live ticket would have left bytes nothing ever tidied.

It still does not fail the request. The customer's message is saved, and
losing the whole ticket because one photo did not upload is the worse outcome.

**What the text search found, before the fix:** 25 widget submissions, 1 with
an attachment, and **zero** of the other 24 mentioning a photo. That is weak
evidence of absence rather than evidence of health — somebody who picks a file
in a widget that shows them a file row has no reason to also write "see
attached". The ledger exists because the text never could answer this.

### Customer file uploads (Drop 8A: direct to storage)

**The bytes never pass through a Vercel function, and they cannot.** A
serverless function rejects request bodies over **4.5MB** at the platform
level, before any of our code runs. Three iPhone photos exceed that. The
original design POSTed the files inline, so uploads were refused by
infrastructure and we mapped the resulting 413 to our own "too large" copy —
blaming the customer for a ceiling they could not see and we could not raise.
Raising our own limit does nothing. **Any future upload feature must go direct
to storage too.**

The flow:

1. Widget POSTs names and sizes to `/api/tickets/intake/upload-url` — a few
   hundred bytes of JSON.
2. That route mints a Supabase **signed upload URL** per file under
   `intake/<uuid>`, plus a **signed grant** (`lib/uploads/grant.ts`) proving we
   minted that path. Rate-limited per IP.
3. The browser PUTs each file straight to Supabase, with XHR so there is real
   per-file progress. Uploads start on PICK, not on submit, so the bar runs
   while the customer types. Submit is disabled while bytes are in flight.
4. The form submits **grants, not files**. `/api/tickets/intake` is JSON-only.
5. `lib/uploads/claim.ts` downloads what was actually stored and runs every
   original protection on it — real byte length, content sniffing, EXIF
   stripping, fail-closed — plus two the inline path never needed: the
   signature proves we minted the path, and the object's presence proves the
   grant is unspent. **A grant is single-use because the object is deleted when
   claimed**, not because anything is written down.
6. Stripped bytes are written to `<ticketId>/<messageId>/…`; the temp object is
   deleted, never moved — the customer's original still has its EXIF.
7. Unclaimed uploads are swept after 24h by `lib/uploads/sweep.ts`, piggybacked
   on the daily auto-close cron so it needs no new Vercel cron entry. It only
   ever touches `intake/`, which is the only prefix a grant can name.

`accept` is `image/*,application/pdf` on purpose: naming HEIC makes iOS hand
over the raw HEIC, while a generic `image/*` makes it transcode to JPEG. We
want the JPEG.

Verified end to end against real Supabase: 4130 bytes in with GPS EXIF, 216
stored, GPS gone, image data intact, temp object consumed, replayed grant
refused, forged grant refused.

#### The protections themselves (unchanged since Drop 7)

- **Type comes from the CONTENT** (`lib/uploads/sniff.ts`), never the
  extension or the browser's Content-Type: a caller who picks both the file
  and the header otherwise nominates which allowlist entry they match. JPEG,
  PNG, WebP, HEIC, PDF. `mif1` alone is not HEIC — it's shared with AVIF.
- **EXIF is stripped** (`lib/uploads/strip.ts`), because a photo of a damaged
  tub is a photo taken at the customer's address. Pure byte manipulation, no
  image library — `sharp` means native binaries and this project has already
  paid for one round of Vercel build archaeology. JPEG drops APP1/APP13/COM
  and keeps APP0/APP2 (dropping ICC would shift the colours); PNG drops the
  text and eXIf chunks; WebP drops EXIF/XMP, clears the VP8X flags and
  rewrites the RIFF size. HEIC has no segment to drop — EXIF is an *item* in
  `mdat` located via `meta`/`iinf`/`iloc` — so its payload is ZEROED IN PLACE,
  which leaves every other offset in the file untouched.
- **FAIL CLOSED.** Anything not fully parsed is refused, not stored. The
  alternative is keeping the GPS we promised to remove.
- Validation runs BEFORE anything is written, and is all-or-nothing: a
  half-accepted batch leaves a customer thinking three photos arrived.
- The customer gets an actionable sentence; the parser reason goes to the log
  only. Narrating "unrecognised HEIC layout" to a public caller tells them
  which code path they reached.
- Uploads carry their own rate limit (3 per 10 min/IP) on top of the
  submission limit (5/min) — five text posts a minute is noise, five 10MB
  posts is 50MB of storage a minute.
- Thread rendering: images thumbnail via `/api/attachments/[id]?inline=1`
  (the default still sets a download disposition). **HEIC is not
  thumbnailed** — Chrome and Firefox can't decode it, so an `<img>` would show
  a broken-image icon.

### Phase 5 — CSAT, reporting, Ike export (NOT started)

Nothing in this section exists. The `exports` table is in the schema from
0001 and has never been written to.

CSAT email on resolve (1–5 one-tap). Analytics dashboard (volume by
channel/topic, first-response & resolution times, per-agent, CSAT trend).
Admin-only "Export for Ike": resolved tickets → PII-scrubbed JSONL Q&A
pairs (quality filter: CSAT ≥ 4 or agent-flagged), plus weekly scheduled
export. `exports` table exists.

## Design conventions

Light UI, Tailwind, amber-500 accent on gray-900, system font stack (do NOT
use next/font/google). Status colors in lib/types.ts STATUS_META. Keep the
customer-facing widget minimal and fast.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
