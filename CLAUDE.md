# Blanks Support — Claude Code briefing

Natively hosted help desk for Blanks Sports Nutrition (replaces Gorgias).
Will live at support.blankssportsnutrition.com. Built like the other Blanks
apps (blanks-crm, blanks-athletes-portal): Next.js 16 + React 19 + Supabase.

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

**A change is not done until it is pushed.** Push by default once the gate
passes; only hold back if Michael says so. "Committed, not pushed" has cost
three test cycles — Drop 7C, the dark widget, and the Safari upload fix — each
time because work that looked finished in the transcript was sitting in one
working copy where nobody on the team could reach it. A commit nobody can pull
is indistinguishable from no commit at all, and the person who finds that out
is whoever was waiting to test it.

Two things this does NOT license: pushing work that hasn't passed the gate
(that's what the `&&` chain is for), and pushing straight to `main` when a
branch was asked for. And `git add -A` still sweeps up unrelated files —
stage explicit paths, because a push makes that mistake much harder to undo.

**2. Test globs must cover every extension the suite uses.**

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

## Current state (Phase 1 — DONE, working locally)

- Website intake widget at `/widget` with topic picker → public POST
  `/api/tickets/intake` (honeypot + naive rate limit, CORS open — tighten to
  blankssportsnutrition.com before production embed)
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

## Deployment status — IMPORTANT

NOT currently deployed. Local-only by choice, after a painful Vercel saga.
The plan when the owner wants to go live again:

1. DONE — `middleware.ts` is now `proxy.ts` (Next 16 convention). The
   compiled proxy chunk was verified to contain no Supabase import and no
   executable `__dirname`, which is what kept crashing Vercel before
   (`__dirname is not defined` / MIDDLEWARE_INVOCATION_FAILED).
2. Delete the old `blanks-support` Vercel project entirely (its build cache
   is poisoned) and re-import fresh from GitHub.
3. Env vars on Vercel — the authoritative list is the table in
   DROP-5-DEPLOY-AND-META.md A1; `.env.example` documents every one.
4. Domain support.blankssportsnutrition.com — GoDaddy CNAME already exists.
5. Supabase Auth → URL Configuration: set Site URL to the production domain.
6. Env vars added since Phase 2: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
   TOKEN_ENCRYPTION_KEY, SUPPORT_EMAIL, NEXT_PUBLIC_SITE_URL,
   GMAIL_WEBHOOK_TOKEN. Do NOT set NEXT_PUBLIC_MAIL_POLL_SECONDS in
   production — Pub/Sub replaces polling there.
   TOKEN_ENCRYPTION_KEY must be the SAME value as local, or every stored
   OAuth token becomes undecryptable and all agents must reconnect.
7. Add the production callback to the Google OAuth client:
   https://support.blankssportsnutrition.com/api/google/callback
8. Run migrations 0002–0018 against the production Supabase project. The
   dashboard shows a banner listing any that are missing — and, since 0017,
   a separate amber one when it could not check rather than one claiming
   they are absent.

### Turning on inbound push (production only)

Inbound works locally by polling. Push needs Google Cloud wiring:

1. Google Cloud console → Pub/Sub → Create topic, e.g. `gmail-inbound`.
2. Grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher**
   role on that topic — without it Gmail silently can't publish.
3. Create a **push** subscription targeting
   `https://support.blankssportsnutrition.com/api/webhooks/gmail?token=<GMAIL_WEBHOOK_TOKEN>`.
4. Set GMAIL_PUBSUB_TOPIC to `projects/<project>/topics/gmail-inbound`.
5. Call `users.watch` for the support mailbox (watchGmailMailbox in
   lib/google/gmail.ts) to start push delivery.
6. **The watch expires every 7 days.** Add a Vercel cron (daily) that renews
   it. If it lapses, inbound stops silently — the mailbox keeps receiving,
   nothing errors, tickets just stop appearing.

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

## Roadmap (build in order; schema already supports all of it)

### Phase 2 — Gmail (DONE, local only)
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
- Dev vs prod: locally the dashboard polls (NEXT_PUBLIC_MAIL_POLL_SECONDS) and
  Settings has "Check mail now". Production uses Pub/Sub push to
  `/api/webhooks/gmail`. Same sync either way.

**Still to do before inbound works in production** (see Deployment):
Google Cloud Pub/Sub topic + push subscription, calling users.watch, and a
daily cron to renew it.

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

### Phase 3 — Instagram + Messenger (9C/9D: webhook + Messenger inbound DONE)

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

### Phase 4 — Shopify sidebar + power features
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

**Rules engine (Drop 7C — DONE, local only).** DROP-7-SPEC said the `rules`
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

### Phase 5 — CSAT, reporting, Ike export
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
