# Drop 7 — Shopify context, routing, and the front door

Phase 2 and notifications are done and live. This drop makes the daily work
fast (order context), automatic (routing), and public (the widget).

Store facts, confirmed from the live Shopify connection:
- Store: Blank's Sports Nutrition — `blankssportsnutrition.com`
- Plan: **Advanced** (no meaningful API constraints)
- Currency USD, United States
- **Store contact email is `support@blankssportsnutrition.com`** — see 7E

---

## 7A. Verification pass — do this BEFORE building (Michael, no code)

The system is live but several paths have never been exercised end to end.

1. **Notifications actually send.** Assign a ticket to yourself. An email
   should arrive from `hello@` within a minute. If not, the toast now
   reports why — read it rather than guessing.
2. **Escalation path.** Use Claude Code's clock-rewind SQL on a test
   ticket, hit `/api/cron/notifications?token=…`, confirm the breakout
   email arrives with the `[URGENT · 8h UNANSWERED]` subject and lands as
   a new conversation, not inside the assignment thread.
3. **Reminder buttons.** Click "remind me in 1 hour" from a real email,
   confirm the confirmation page appears (not an instant fire), confirm the
   reminder arrives threaded.
4. **Vercel env**: `CRON_SECRET` and `ALERT_EMAIL` set; confirm the
   10-minute cron is registered under the project's Cron Jobs tab.
5. **Every agent completes onboarding**: sign in → connect Gmail → set
   signature name and title → send one test reply → resolve one ticket.
   Until an agent connects Gmail, every reply they write silently queues.
   This is the single most likely "the system is broken" report you'll get.
6. **Inbound heartbeat**: confirm it's actually running and would alert.
   A lapsed Gmail watch stops customer email with no error.

Do not skip 5. Six people discovering the Gmail requirement individually,
mid-ticket, is a bad first impression of the tool.

---

## 7B. Shopify order context in the sidebar

The highest-value feature remaining. "Where is my order" is the most common
DTC ticket, and answering it currently means leaving the help desk.

**Connection**
- Shopify Dev Dashboard (dev.shopify.com) → Apps → create `Blanks Support`
  under the organisation that owns the store, then install it on the store.
  Custom apps can no longer be created in the Shopify admin, and a Dev
  Dashboard app issues no static `shpat_` token — only a client ID and
  secret. See "Access tokens" below.
- Admin API scopes, read-only: `read_orders`, `read_customers`,
  `read_fulfillments`, `read_products`.
- **Check `read_all_orders`.** Without it the Orders API only returns the
  last 60 days, which will quietly hide older orders — exactly the ones
  customers write in about. Request/enable it if the scope list allows;
  if it needs Shopify approval, note it and proceed with the 60-day
  limitation surfaced in the UI rather than hidden.
- Env is `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`.
  Server-side only, never `NEXT_PUBLIC_`.
- Use the GraphQL Admin API. Respect the cost-based rate limit: back off on
  `THROTTLED`, never fetch in a loop per ticket render.

**Access tokens** — [client credentials grant][ccg]

[ccg]: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant

- `POST https://{shop}/admin/oauth/access_token`, form-encoded, with
  `grant_type=client_credentials`, `client_id`, `client_secret`. Returns
  `access_token`, `scope`, `expires_in` (86399 — 24 hours).
- Available only for apps built by your own organisation and installed on a
  store you own. That is exactly our case; a public or distributed app would
  need a different grant.
- **The token must be persisted, not held in a module variable.** On
  serverless every cold start would begin with nothing and mint again, so a
  burst of invocations would hammer the token endpoint and get rate-limited.
  It lives in `oauth_tokens` (provider `shopify`, `agent_id` null, shop
  domain as `account_ref`), AES-256-GCM encrypted under
  `TOKEN_ENCRYPTION_KEY` — the same table and pattern as the Gmail tokens,
  so no new migration. Refreshed when under five minutes remain, a window
  wider than any single request that might carry the token.
- On a 401 from the Admin API, force one re-mint and retry once, then fail.
  A 403 is a scope problem — a new token has the same scopes, so it fails
  immediately rather than spending a mint.
- A failed cache write never fails the caller: two instances minting at once
  trips the unique index, and the loser still holds a good token.

**Sidebar behaviour**
- When a ticket's customer has an email, look them up in Shopify by email.
- Show: customer name, lifetime order count and spend, and their **3 most
  recent orders** — order number, date, status, fulfillment status,
  total, and a tracking link where one exists.
- Each order expands to show line items.
- Deep link to the order in Shopify admin (agents will need it for
  refunds).
- If the ticket has an `order_number` from the widget, surface that order
  first regardless of recency.
- **No match** is a normal state, not an error: "No Shopify customer found
  for this email" plus a manual lookup box (search by order number or a
  different email — plenty of people write in from a different address
  than they ordered with).
- **Cache** per ticket view for ~60s and load asynchronously — the sidebar
  must never block the thread from rendering, and Shopify being slow or
  down must degrade to a message, not a broken page.

**Macro variables** — wire the real data into the existing macro system:
`{{order.number}}`, `{{order.status}}`, `{{order.tracking_url}}`,
`{{order.tracking_number}}`, `{{order.date}}`, `{{order.total}}`.
Rendering a macro with no order present must leave an obvious placeholder,
never an empty string — "Your order  has shipped" going to a customer is
worse than the macro failing loudly.

**Explicitly out of scope this drop:** refunds, cancellations, order edits.
Read-only until the team trusts the integration.

---

## 7C. Rules engine — automatic routing

Michael's stated first rule: order changes → Harvey, notified immediately.

**Model** (`rules` table already exists): trigger (ticket created / message
received), ordered conditions (channel, topic, tag, subject keyword, body
keyword, customer email domain), actions (assign, add tag, set priority,
send auto-reply).

**Requirements**
- Rules are ordered and evaluated top-down; first assignment wins, other
  actions can stack. Show the order in the UI and let it be reordered.
- Admin-editable in Settings — no code deploy to add a rule, and no SQL.
- Every rule firing writes a `ticket_events` row naming the rule, so
  "why did this get assigned to Harvey" is answerable.
- A dry-run mode: show which of the last 50 tickets a new rule *would*
  have matched, before enabling it. Cheap to build, prevents a bad rule
  silently misrouting a week of tickets.
- Auto-assignment fires the existing notification path — Harvey gets the
  same email he'd get from a manual assignment, priority-prefixed.
- A rule must never reassign a ticket that already has an owner.

**Seed rules to ship with** (all disabled by default, Michael enables):
- Topic `Order questions` or subject matching order-change keywords
  (cancel, change address, wrong item, modify order) → assign Harvey
- Topic `Wholesale / retailer` → tag and route
- Topic `Sponsorship inquiry` / `Ambassador / athlete` → assign Michael
- Subject/body matching refund keywords → priority High

Do not invent more rules than that. Melissa's triage behaviour over the
next couple of weeks is better data than our guesses, and the point of the
dry-run is to build rules from evidence.

---

## 7D. The website widget

`WIDGET_ALLOWED_ORIGINS` is already set for the storefront.

- Add to the Shopify theme (theme.liquid, before `</body>`), or via Google
  Tag Manager:
  `<script src="https://support.blankssportsnutrition.com/widget.js" defer></script>`
- Before shipping it live: restyle the widget to the blue brand, verify it
  on mobile (thumb-reachable, keyboard doesn't cover the field, panel fits
  small screens), confirm it doesn't collide with any existing chat or
  cookie banner, and confirm the honeypot + rate limit hold under a real
  URL.
- Add a "Contact us" page link to the same form for people who don't
  notice a floating button.
- Ship this LAST in the drop — it's the only change that exposes the
  system to the public, and it's much easier to fix routing and order
  context before volume arrives than during.

---

## 7E. Shopify's contact email — decide deliberately

Shopify's store contact address is `support@blankssportsnutrition.com`,
which means order confirmations, shipping notifications and account emails
all carry it as the reply address. Every customer who replies "where is my
order" to a shipping notification is replying to `support@`.

Today `support@` is a Google Group that fans out to the team and to
`hello@`. After the planned cutover — `support@` as an alias on the
`hello@` mailbox — those replies become tickets automatically, which is
exactly what you want, and is a strong argument for doing that cutover
sooner rather than later.

Two things to check when you do:
- The `bulk-mail` guard exception (`TRUSTED_FORWARD_ADDRESSES`) stops
  mattering once it's an alias rather than a group — but leave it in place.
- Shopify's own notification emails must not become tickets. They're sent
  *to* customers, not to us, so they shouldn't — but verify after cutover
  that no ticket is created from a Shopify notification bounce or
  auto-reply.

---

## Sequencing

7A verification → 7B Shopify sidebar → 7C rules engine → 7D widget last.

Pause after the sidebar so Michael can look before routing is layered on
top of it.
