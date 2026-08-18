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
8. Run migrations 0002–0011 against the production Supabase project. The
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

Still to build: 9E outbound + the 24h window, Instagram on the same plumbing,
the countdown UI.

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
