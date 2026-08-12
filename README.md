# Blanks Support

Natively hosted help desk for Blanks Sports Nutrition — replaces Gorgias.
Lives at **support.blankssportsnutrition.com**.

Built with Next.js 14 (App Router) + Supabase, same stack as the CRM and athlete portal.

## What's in Phase 1 (this repo, working today)

- Website support widget with topic picker (order questions, product questions, sponsorship, retailer, events, …)
- Public intake API with honeypot + rate limiting
- Team dashboard: inbox views (Open / My tickets / Unassigned / All / Resolved, per-channel filters)
- Ticket thread view with replies and 🔒 internal notes
- Statuses (new → open → pending → resolved → closed) with auto-reopen on customer reply
- Assignment & hand-off between Melissa / Michael / Jon / Harvey
- Tags (auto-applied from widget topic), priorities, macros with `{{customer.first_name}}` variables
- Live updates via Supabase Realtime
- Full audit trail (`ticket_events`)

Phases 2–5 (Gmail in/out, Instagram + Messenger, Shopify sidebar, CSAT/reporting/Ike export) build on this schema — the tables are already in place.

## Setup (~15 minutes)

### 1. Create the Supabase project (~3 min)

1. Go to [supabase.com](https://supabase.com) → **New project** (in the same org as the CRM, but a **separate project**).
2. Name it `blanks-support`, pick a strong DB password, choose the same region as the CRM.
3. Once created: **SQL Editor** → paste the entire contents of `supabase/migrations/0001_init.sql` → **Run**.
   You should see "Success". This creates all tables, security policies, and seeds the topic tags + starter macros.

### 2. Configure environment (~2 min)

1. Copy `.env.example` to `.env.local`.
2. In Supabase: **Project Settings → API** — copy the **URL**, **anon public** key, and **service_role** key into `.env.local`.

### 3. Enable Google sign-in (~5 min, optional but recommended)

Magic-link email login works out of the box with zero config. For one-click Google sign-in:

1. Supabase → **Authentication → Providers → Google** → follow the guided setup (it walks you through creating the OAuth client in Google Cloud).
2. Add `https://support.blankssportsnutrition.com` (and `http://localhost:3000` for dev) to **Authentication → URL Configuration → Redirect URLs**.

> Anyone who signs in gets an `agent` row automatically. To restrict access to the team, turn off public signups: **Authentication → Sign In / Up → disable "Allow new users to sign up"**, then invite melissa@, michael@, jon@, harvey@ via **Authentication → Users → Invite**.
> To make yourself admin, run in SQL Editor:
> ```sql
> update agents set role = 'admin' where email = 'michael@blankssportsnutrition.com';
> ```

### 4. Run locally

```bash
npm install
npm run dev
```

- Dashboard: http://localhost:3000 (redirects to /login)
- Customer form: http://localhost:3000/widget
- Submit a test ticket through the widget and watch it appear in the inbox live.

### 5. Deploy to Vercel (~5 min)

1. Push this repo to GitHub, then **vercel.com → New Project → import** it.
2. Add the three env vars from `.env.local` in Vercel's project settings.
3. **Settings → Domains** → add `support.blankssportsnutrition.com`, then add the CNAME record Vercel shows you at your DNS provider (same flow as the CRM).

### 6. Put the widget on the website

Add one line to blankssportsnutrition.com (in the theme's layout or via Google Tag Manager):

```html
<script src="https://support.blankssportsnutrition.com/widget.js" defer></script>
```

That renders the floating **💬 Support** button. Or link directly to `https://support.blankssportsnutrition.com/widget` from a "Contact us" page.

## Project layout

```
app/
  (dashboard)/
    inbox/page.tsx        # ticket list with filter views
    tickets/[id]/page.tsx # thread view + side panel
    layout.tsx            # auth guard + sidebar
  api/tickets/intake/     # public widget intake endpoint
  widget/page.tsx         # customer-facing form
  login/ auth/            # Supabase auth
  actions.ts              # server actions: reply, assign, status, tags
components/               # Sidebar, TicketList, Thread, ReplyBox, side panel
lib/
  supabase/               # server / client / admin (service-role) clients
  types.ts                # shared types + topic list
supabase/migrations/      # 0001_init.sql — full schema, RLS, seeds
public/widget.js          # embeddable loader for the marketing site
```

## Roadmap (from the schematic)

- **Phase 2 — Gmail:** per-agent OAuth, replies sent from the agent's own Gmail, support@ inbox watch (Pub/Sub) → tickets. `delivery_status` on messages is already `queued` for public replies, ready for the send worker.
- **Phase 3 — Instagram + Messenger:** Meta app webhooks → tickets, reply + mark-as-read, 24h window handling. `meta_conversation_id` / `meta_message_id` columns are in place.
- **Phase 4 — Shopify sidebar:** order history + macro variables (`{{order.tracking_url}}`). The side panel has a placeholder slot.
- **Phase 5 — CSAT, reporting, Ike export:** `csat_surveys`-style additions, analytics, JSONL export with PII scrubbing (`exports` table exists).
