# Blanks Support — Claude Code briefing

Natively hosted help desk for Blanks Sports Nutrition (replaces Gorgias).
Will live at support.blankssportsnutrition.com. Built like the other Blanks
apps (blanks-crm, blanks-athletes-portal): Next.js 16 + React 19 + Supabase.

## Hard rules (non-negotiable)

**1. The pre-commit gate is a single `&&` chain.**

```
npm run build && npm test && git commit ...
```

Never `npm run build; npm test && git commit`. With `;` the build's exit
status is discarded and a failing typecheck commits anyway — that has already
happened once. The same applies to piping the build through `grep` to read its
output: `grep`'s exit status replaces the build's, so the chain succeeds even
when the build failed. If you need to filter build output, run the gate first
and inspect afterwards.

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
8. Run migrations 0002–0006 against the production Supabase project. The
   dashboard shows a banner listing any that are missing.

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
| `From` | the replying agent's own Gmail | The customer gets a reply from a person, not a shared alias. It also means the send is authorised as that agent, so it lands in their Sent folder. |
| `Reply-To` | SUPPORT_EMAIL (hello@) | Without it, a customer's reply goes back to one agent's personal mailbox — which the inbound watch does not read — and would never become a ticket. |

The two must stay different. Setting `From` to hello@ would lose the personal
sender; dropping `Reply-To` would silently break inbound threading, and it
would break it only for replies, which is the hardest kind of gap to notice.

Consequence worth knowing: because `From` is per-agent, a Gmail thread
belongs to whichever mailbox created it — hence `tickets.gmail_account_ref`
and the 404-retry fallback in `deliverMessage`.
- Inbound: `lib/google/inbound.ts` syncs the support mailbox. Routing
  precedence is token → References → thread id → sender+subject+recency, and
  the matched path is recorded in ticket_events. Loop protection drops
  automated mail, anything from our own addresses (agents, SUPPORT_EMAIL, the
  connected mailbox), and any address listed in `IGNORED_SENDER_EMAILS`
  (comma-separated, case-insensitive — seeded with support@ for the Gorgias
  parallel run). The unique index on gmail_message_id absorbs Pub/Sub
  redelivery. Every skip is counted and shown by "Check mail now".
- Dev vs prod: locally the dashboard polls (NEXT_PUBLIC_MAIL_POLL_SECONDS) and
  Settings has "Check mail now". Production uses Pub/Sub push to
  `/api/webhooks/gmail`. Same sync either way.

**Still to do before inbound works in production** (see Deployment):
Google Cloud Pub/Sub topic + push subscription, calling users.watch, and a
daily cron to renew it.

### Phase 3 — Instagram + Messenger
One Meta app; webhooks → `/api/webhooks/meta` (verify X-Hub-Signature-256,
dedupe by message id). DM conversation ↔ ticket via meta_conversation_id.
Reply + mark-seen via Send API using the stored page token. Enforce the
24-hour window; apply HUMAN_AGENT tag outside it. Capture echo messages.
Permissions (App Review): pages_messaging, instagram_manage_messages,
instagram_basic, pages_manage_metadata, Human Agent.

### Phase 4 — Shopify sidebar + power features
Read-only Shopify Admin API custom app. Customer 360 in TicketSidePanel:
recent orders + status + tracking, lifetime spend, order lookup by email /
order number. Macro variables {{order.*}}. Then: rules engine (auto-tag/
assign/reply), SLA timers, snooze, merge, full-text search (Postgres FTS),
collision detection (Supabase Presence), keyboard shortcuts.

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
