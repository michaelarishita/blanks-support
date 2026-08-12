# Blanks Support — Claude Code briefing

Natively hosted help desk for Blanks Sports Nutrition (replaces Gorgias).
Will live at support.blankssportsnutrition.com. Built like the other Blanks
apps (blanks-crm, blanks-athletes-portal): Next.js 16 + React 19 + Supabase.

## Commands

- `npm run dev` — dev server on localhost:3000 (Turbopack)
- `npm run build` — production build; must pass before any commit is pushed
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

1. Migrate `middleware.ts` → the new `proxy.ts` convention first
   (`npx @next/codemod@canary middleware-to-proxy .`) — Next 16 deprecated
   middleware.ts, and the middleware bundle is exactly what kept crashing
   on Vercel (`__dirname is not defined` / MIDDLEWARE_INVOCATION_FAILED).
2. Delete the old `blanks-support` Vercel project entirely (its build cache
   is poisoned) and re-import fresh from GitHub.
3. Env vars on Vercel: NEXT_PUBLIC_SUPABASE_URL,
   NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
4. Domain support.blankssportsnutrition.com — GoDaddy CNAME already exists.
5. Supabase Auth → URL Configuration: set Site URL to the production domain.

## Hard-won gotchas (do not re-learn these)

- NEVER import @supabase/ssr (or anything Supabase) in middleware/proxy —
  it bundles code that references `__dirname` and crashes Vercel's edge
  runtime. Current middleware.ts does a cookie-presence check only; real
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

### Phase 2 — Gmail (NEXT UP)
Goal: replies actually send as email from the responding agent's own Gmail,
and emails to support@blankssportsnutrition.com become tickets.

- Per-agent Google OAuth (scope: gmail.send). Store refresh tokens
  encrypted in `oauth_tokens` (provider='google'). Settings page for agents
  to connect their Gmail; flip `agents.gmail_connected`.
- Sending: on public reply to an email-channel ticket (or web_form ticket
  with customer email), build RFC 2822 message, thread with
  In-Reply-To/References using messages.gmail_message_id, send via Gmail
  API as the agent, update messages.delivery_status queued→sent|failed.
  Subject: `Re: <ticket.subject> [BLK-<number>]` — the [BLK-n] token routes
  replies back to the ticket.
- Receiving: support@ account watch via users.watch → Google Cloud Pub/Sub
  → `/api/webhooks/gmail`. history.list to fetch new messages; create
  ticket (or append via References/[BLK-n]); store gmail ids. Daily cron to
  renew the watch (expires every 7 days) — use Vercel cron once deployed.
- Web_form confirmation email can also send via support@'s connection.
- Google Cloud project needed: Gmail API enabled, OAuth consent screen
  internal to blankssportsnutrition.com, Pub/Sub topic + push subscription.

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
