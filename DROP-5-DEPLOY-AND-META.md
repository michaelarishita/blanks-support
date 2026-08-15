# Drop 5 — Go live, and open the Meta track

Two tracks in parallel. Track A gets the working product off Michael's
laptop and onto support.blankssportsnutrition.com so Melissa can use it.
Track B starts the Instagram/Messenger setup, which has external waiting
built into it.

---

# TRACK A — Deployment

## A0. Pre-flight (do these before touching Vercel)

1. **Migrate `middleware.ts` → the `proxy.ts` convention.**
   `npx @next/codemod@canary middleware-to-proxy .` — Next 16 deprecated
   the old convention, and this exact file is what crashed every previous
   Vercel deploy (`__dirname is not defined`). Verify the compiled output
   still contains no Supabase import. Run the build. Commit alone, so if
   anything regresses the blame is unambiguous.
2. **Confirm a strict install passes**: `rm -rf node_modules && npm ci`
   then `npm run build`. Vercel uses `npm ci`; a lockfile that only
   resolves with `--legacy-peer-deps` fails the cloud build in ~4 seconds.
   This has bitten us once already.
3. **`npm test`** — 142 assertions must be green.
4. **Tighten the widget CORS** in `app/api/tickets/intake/route.ts` from
   `*` to an allowlist: `https://blankssportsnutrition.com`,
   `https://www.blankssportsnutrition.com`, and the Shopify storefront
   domain if the site is served from one. Keep `http://localhost:3000` for
   dev via an env-driven list rather than hardcoding.

## A1. Vercel project

**Delete the existing `blanks-support` Vercel project first.** Its build
cache is poisoned from the Next 14 era; a fresh import starts clean. This
does not touch GitHub, Supabase, or DNS.

Then: Add New → Project → import `michaelarishita/blanks-support`.

**Environment variables** (all environments unless noted):

| Variable | Source / note |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same |
| `SUPABASE_SERVICE_ROLE_KEY` | same — server-only, never `NEXT_PUBLIC_` |
| `GOOGLE_CLIENT_ID` | Google Cloud → Credentials |
| `GOOGLE_CLIENT_SECRET` | same |
| `TOKEN_ENCRYPTION_KEY` | **COPY the local value verbatim. Do not regenerate.** Regenerating makes every stored Gmail token undecryptable and forces all agents (and the support mailbox) to reconnect. |
| `SUPPORT_EMAIL` | hello@blankssportsnutrition.com — NOT support@, which still routes to Melissa's existing setup during the parallel run |
| `NEXT_PUBLIC_SITE_URL` | `https://support.blankssportsnutrition.com` — pins OAuth redirect + the absolute logo URL in email |
| `NEXT_PUBLIC_MAIL_POLL_SECONDS` | unset in production (Pub/Sub takes over) |
| `CRON_SECRET` | new random value; guards the cron endpoints |
| `IGNORED_SENDER_EMAILS` | `support@blankssportsnutrition.com` — senders dropped rather than ticketed, for the Gorgias parallel run |
| `TRUSTED_FORWARD_ADDRESSES` | `support@blankssportsnutrition.com` — REQUIRED while support@ is a Google Group forwarding to hello@, or every forwarded customer email is discarded as bulk mail |
| `GMAIL_PUBSUB_TOPIC` | set in A3. NOTE: `GMAIL_`, not `GOOGLE_` — an earlier draft of this table had it wrong, and the wrong name fails silently as "GMAIL_PUBSUB_TOPIC is not set" from the watch-renewal cron |
| `GMAIL_WEBHOOK_TOKEN` | new random value. REQUIRED in production: the Pub/Sub endpoint accepts any caller when it is unset |
| `ALERT_EMAIL` | michael@blankssportsnutrition.com — where inbound-down alerts go |
| `WIDGET_ALLOWED_ORIGINS` | `https://blankssportsnutrition.com,https://www.blankssportsnutrition.com` plus the Shopify storefront domain if the site is served from one |

Deploy. Confirm green, then Settings → Domains → add
`support.blankssportsnutrition.com` (the GoDaddy CNAME already exists from
the earlier attempt — it should validate immediately).

## A2. Point the world at the new domain

- **Google Cloud → Credentials → the OAuth client**: add a second
  authorised redirect URI,
  `https://support.blankssportsnutrition.com/api/google/callback`. Keep
  the localhost one so local dev still works.
- **Supabase → Authentication → URL Configuration**: Site URL =
  `https://support.blankssportsnutrition.com`; add it to Redirect URLs.
- **Supabase → Authentication → Providers/Sign-in**: disable public
  signups. Accounts are admin-created only.
- Re-verify RLS is enabled on every table (`select tablename, rowsecurity
  from pg_tables where schemaname='public'`) — production is the moment
  this stops being theoretical.

## A3. Inbound email in production (Pub/Sub)

Local polling doesn't exist in production; Gmail pushes instead.

1. Google Cloud → Pub/Sub → create topic `gmail-support-inbound`.
2. Grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub
   Publisher** role on that topic. (Missing this is the #1 reason watches
   silently never deliver.)
3. Create a **push subscription** → endpoint
   `https://support.blankssportsnutrition.com/api/webhooks/gmail`.
4. Verify the handler authenticates the push (OIDC token from Google, or a
   shared secret in the URL) and still returns 200 on internal failure, per
   the existing design.
5. Call `users.watch` on the support mailbox with that topic; store
   `last_history_id`.

## A4. The cron jobs

`vercel.json` crons, each guarded by `CRON_SECRET`:

- **Daily — renew the Gmail watch.** It expires every 7 days. Renew daily
  so a single failed run isn't fatal.
- **Hourly — inbound heartbeat.** THE critical one. A lapsed watch stops
  inbound mail *with no error*: silence is indistinguishable from a quiet
  day. The check: if `now - max(messages.created_at where direction=
  'inbound' and channel='email')` exceeds 24h, OR the stored watch
  expiry is <48h away, OR `last_history_id` hasn't moved in 24h → alert.
  Alert = email to michael@ (send through the support mailbox connection)
  plus a persistent banner in the dashboard header. A monitoring system
  nobody sees is not monitoring.
- **Daily — auto-close.** Resolved tickets untouched for 7 days → closed.
  The schematic specified it; nothing implements it yet.
- **Optional — retry failed sends** with backoff, rather than relying on
  an admin noticing the Settings flush button.

## A5. Production smoke test (run in order, in production)

1. Sign in at the real domain.
2. Submit through `/widget` → ticket appears.
3. Reply → branded email arrives; check desktop + mobile.
4. Email hello@ from a personal address → ticket appears **without**
   clicking anything (this proves Pub/Sub, not polling).
5. Customer replies → threads into the same ticket.
6. Reconnect each agent's Gmail on the production domain (tokens are
   per-OAuth-client and the redirect differs; expect to reconnect once).
7. Force the heartbeat to fire and confirm the alert actually arrives.
8. Confirm the widget embed loads on a page from
   blankssportsnutrition.com (CORS allowlist working).

## A6. Then, and only then

Add the embed to the website:
`<script src="https://support.blankssportsnutrition.com/widget.js" defer></script>`

Create accounts for Melissa, Jon, Harvey (Supabase → Auth → Add user,
Auto Confirm on), have each connect their Gmail, set titles in Settings →
Signature. Run Gorgias and this side by side for a week before cancelling.

---

# TRACK B — Instagram + Messenger groundwork

## B0. The finding that changes this phase

The original schematic assumed a full Meta App Review with a multi-week
wait. Per Meta's current Instagram Platform documentation, **Standard
Access is sufficient when the app only serves professional accounts you
own or manage** — Advanced Access (and therefore App Review) is required
for serving accounts you *don't* own. Blanks owns the Blanks Instagram
account and the Facebook Page. Business verification is likewise scoped to
apps serving users without a role on the app or its business portfolio;
Michael, Melissa, Jon and Harvey can all be given roles.

**So: build against Standard Access first and find out empirically whether
App Review is needed at all.** If it works, Phase 3 has no external wait
and could ship in days. If a call fails on access level, we submit for
review then — with a working product to screencast, which is the strongest
possible submission anyway.

This is a lead to verify, not a guarantee — Meta changes these rules and
the docs are ambiguous in places. Verify in the App Dashboard before
planning around it. Do NOT let it delay Track A either way.

## B1. Setup Michael can do now (~20 min, no code)

1. Confirm the Blanks Instagram account is a **Professional** account and
   is linked to the Blanks **Facebook Page** (Instagram app → Settings →
   Account type; Page → Linked accounts). Messaging API access depends on
   this link and nothing else works without it.
2. In the Facebook Page's settings, ensure **Instagram messages are
   accessible in the Page inbox** (Page Settings → Privacy → Messaging;
   also Instagram → Settings → Privacy → Messages → "Allow access to
   messages"). This toggle gates API access to IG DMs entirely.
3. developers.facebook.com → **Create App** → business type → attach it to
   the Blanks **Business portfolio**. Name it `Blanks Support`.
4. Add the **Messenger** and **Instagram** products to the app.
5. Add Michael (and later the team) as app roles — Administrator or
   Developer. Roles matter for Standard Access.
6. Note the App ID and App Secret; Claude Code will need them plus a
   webhook verify token.

## B2. Build notes for Claude Code (Phase 3 proper)

Everything in CLAUDE.md's Phase 3 section stands. Additions:

- Prefer building against Standard Access with the Blanks-owned accounts
  and log the exact error if any call is rejected for access level — that
  error is what tells us whether App Review is genuinely required.
- Local development needs a public webhook URL for Meta's verification
  handshake. Once Track A is live, point the Meta webhook at the
  **production** deployment and develop against a Vercel preview or a
  tunnel; don't stall on it.
- The 24-hour messaging window applies to both channels: free-form replies
  only within 24h of the customer's last message; beyond that, the
  `HUMAN_AGENT` tag extends to 7 days. Show a live countdown on social
  tickets and apply the tag automatically past the window — a reply that
  silently fails to send is the worst outcome here, so surface window
  state in the composer the same way the Gmail-not-connected guard does.
- Echo webhooks: capture replies sent from the native Instagram/Facebook
  apps so a DM answered on someone's phone still lands in the ticket
  thread. Without this the thread lies.
- Dedupe by Meta message id; Meta redelivers. Verify
  `X-Hub-Signature-256` on every request.

---

# Punch list carried forward (not in this drop)

- Inbox list+detail split pane (deferred pending real usage by Melissa)
- Sanitized HTML rendering for inbound customer email (currently text-only
  by design; inline `cid:` images skipped)
- "Delivered" status is wired but unset — needs read receipts to mean
  anything
- Phase 4: Shopify sidebar, rules engine, SLA timers, snooze (button is
  stubbed and disabled), merge, search, collision detection
- Phase 5: CSAT, analytics, Ike export with PII scrubbing
