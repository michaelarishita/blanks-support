# Drop 3 & 4 — spec

Two drops, run in order. Drop 3 is presentation (what customers and agents
see). Drop 4 finishes Phase 2 (inbound email). Neither changes the ticket
model, so they don't conflict.

---

# DROP 3 — Premium interface + branded email

Target quality bar: Linear / Front / Superhuman. The test is whether this
looks like software Blanks pays $400/mo for, not an internal tool.

## 3A. Design system foundation

Create `app/globals.css` design tokens + a small primitives layer. Do NOT
scatter one-off Tailwind values through components anymore.

**Tokens** (CSS custom properties, referenced via Tailwind config):
- Neutrals: a real 11-step gray ramp (50→950). Current UI mixes gray-50/100/
  200/400/500/900 arbitrarily — collapse to a scale with intent:
  `surface` (page), `panel` (cards), `border-subtle`, `border-strong`,
  `text-primary`, `text-secondary`, `text-tertiary`.
- Brand: amber (`#f5c518`-family) is the accent — used sparingly, for the
  active nav item, focus rings, and primary action only. Not decoration.
- Semantic: success / warning / danger / info, each with `-bg`, `-border`,
  `-text` variants so status chips stop hand-rolling colors.
- Radii: `sm 6px`, `md 8px`, `lg 12px`, `full`. Pick one per element class
  and never deviate.
- Shadows: 3 levels only — `sm` (resting card), `md` (dropdown/popover),
  `lg` (modal). Soft, low-opacity, no harsh borders + shadow together.
- Motion: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, durations 120ms
  (micro), 200ms (panel). Every interactive element gets a transition.

**Typography**: system stack stays (no next/font/google — see CLAUDE.md).
Define a scale: `display 24/1.2 -0.02em`, `title 18/1.3`, `body 14/1.5`,
`label 13/1.4 500`, `caption 12/1.4`, `mono 12.5`. Tabular numerals on
ticket numbers and timestamps (`font-variant-numeric: tabular-nums`).

**Primitives** in `components/ui/`: `Button` (primary/secondary/ghost/
danger × sm/md), `Badge`, `Avatar` (initials w/ deterministic color from
user id), `Select`, `Input`, `Textarea`, `Tooltip`, `Dropdown`, `Modal`,
`Toast`, `Skeleton`, `EmptyState`. Every one: visible focus ring
(`ring-2 ring-amber-400/60 ring-offset-2`), disabled state, keyboard
accessible. Refactor existing components onto these.

## 3B. Screen-level work

**Sidebar**
- Group header letter-spaced 11px uppercase tertiary — keep, but tighten.
- Nav rows: 32px height, 6px radius, icon + label + right-aligned count.
  Active = amber-tinted bg + medium weight + 2px amber left rail.
- Replace the emoji channel icons with a consistent inline SVG set (globe,
  envelope, instagram glyph, messenger glyph). Emoji render differently
  per platform and read as unfinished.
- Bottom: avatar + name + role, hover reveals a dropdown (Settings, Sign
  out) instead of a bare "Sign out" link.
- Unconnected-Gmail amber dot: keep, but as a proper `Badge` with tooltip.

**Inbox list**
- Denser, scannable rows: channel icon, subject (medium), customer name +
  topic chip (secondary), assignee avatar, status badge, relative time.
- Unread/new tickets: subject in semibold + a 6px amber dot at row start.
- Row hover: subtle panel-raise, not a gray wash. Selected row persists.
- Sticky column header with count ("Open · 12") and a sort/filter control.
- `EmptyState` per view with an icon, one line of copy, and a CTA where it
  makes sense — the current "No tickets here. 🎉" is a placeholder.
- Add loading `Skeleton` rows (dashboard currently pops in).

**Ticket thread** — biggest visual win available
- Header: subject as `title`, meta row beneath (`#1001 · Website ·
  Product questions`), status badge right-aligned, plus a compact action
  bar: Assign, Resolve, Snooze (stub), ⋯ overflow.
- Messages: max-width 680px column. Inbound = white panel, left. Outbound
  = deep neutral, right — keep, but soften radius (14px, tail corner 4px)
  and lighten the black to `gray-900` at 96% with proper text contrast.
- Internal notes: amber-tinted panel, dashed left border, lock icon,
  clearly *inside* the flow but visually "off the record".
- Avatars beside each message (customer initial vs agent photo/initial).
- Delivery status: replace the shouty `QUEUED`/`SENT` caps with a small
  icon + label at 12px tertiary — clock "Sending", check "Sent",
  double-check "Delivered" (future), triangle "Failed — retry" (clickable).
- Day dividers ("Today", "Aug 12") between message groups.
- Consecutive messages from the same author within 5 min: collapse the
  header, tighten spacing.

**Composer**
- Rich text (bold, italic, link, bullet list) — see 3C. Keep ⌘↵ to send.
- Reply / Internal note as a proper segmented control; the whole composer
  tints amber in note mode so nobody sends a note to a customer by mistake.
- Right side: macro picker (searchable dropdown, not a bare `<select>`),
  attachment button (stub OK), and a live "Sending as michael@… " line so
  the agent always knows which Gmail it leaves from.
- Signature preview collapsed by default: "Signature will be appended ▾".

**Side panel**
- Customer block: avatar, name, email w/ copy-on-click, channel identity
  chips, "3 previous tickets" link (stub if not built).
- Sections in collapsible groups with 11px uppercase headers.
- Status: 4 segmented buttons is fine, but make Resolve the obvious
  primary action in the header action bar, not buried in a grid.
- Tags: current chip cloud is good — add a search/filter input once >12
  tags, and dim non-applied tags less aggressively.

**Global**
- `Toast` on every mutation (reply sent, status changed, assigned) —
  bottom-right, auto-dismiss 4s, with Undo where cheap.
- Keyboard shortcuts: `j/k` move, `Enter` open, `r` reply, `n` note,
  `e` resolve, `a` assign, `/` search, `?` shortcut sheet. Show the `?`
  overlay listing them — a signature "premium tool" touch.
- Respect `prefers-reduced-motion`.

## 3C. Rich-text replies + branded HTML email

**Composer editor**: bold, italic, underline, link, bullet/numbered list,
and paste-as-plain-text. Keep it minimal — no font pickers. Store both
`body_html` and a plain-text fallback in `messages` (columns exist).

**Outbound email template** — this is what makes it feel gold-tier. Build
`lib/email/template.ts` rendering a table-based, inline-styled HTML email
(email clients require tables + inline CSS; no flexbox, no external
stylesheet, no webfonts):

```
┌─────────────────────────────────────┐
│  [reply body — 15px/1.6, #1a1a1a]   │
│                                      │
│  ──────────────────────────────────  │  1px #e5e5e5 rule
│  Michael Arishita                    │  15px 600
│  Founder/CEO                         │  14px #666
│  Blank's Sports Nutrition            │  14px #666
│  blankssportsnutrition.com           │  14px, amber link
│                                      │
│  [ BLANK'S SPORTS NUTRITION logo ]   │  max-width 240px, block
└─────────────────────────────────────┘
```

Requirements:
- 600px max width, centered, white background, 24px padding.
- Multipart/alternative: text/plain part generated from the HTML (strip
  tags, keep link URLs in parens) — plain-text-only clients must read fine.
- Logo hosted at a stable public URL (`/public/email/blanks-logo.png`,
  referenced absolute via `NEXT_PUBLIC_SITE_URL`); include `alt` text and
  explicit width/height so it doesn't jump before images load. Do NOT use
  CID attachments or data: URIs — Gmail strips or bloats them.
- Dark-mode safe: explicit background + text colors on every cell.
- No tracking pixels.
- Keep `[BLK-n]` in the subject and `Reply-To: support@` — unchanged.
- **Subject rule (carry-over item): for `web_form` tickets whose first
  outbound email starts a new email thread, the subject must NOT be
  prefixed `Re:`.** Use `<subject> [BLK-n]` on the first send and `Re:` on
  subsequent ones. Ticket #1001 showed `Re: Product questions — Ike
  [BLK-1001]` replying to nothing.

**Signature builder** — Settings → Signature
- Per-agent fields: display name, title, phone (optional), plus a live
  preview rendering the exact email template.
- Company block (logo, company name, website, brand color) is admin-only
  and shared — store in a new `settings` table (single row, jsonb) so it's
  editable without a deploy. Agents can't break brand consistency.
- Admin uploads the logo via Supabase Storage (public bucket `brand`),
  with an initial seeded value pointing at a committed default asset.
- Toggle: "Append signature to outbound emails" (default on).
- Signature is appended at send time, not stored in `messages.body_html` —
  so the in-app thread stays clean and signature edits apply retroactively
  to the reader's view of *future* mail only.

## 3D. Also in this drop

- Move the 20 MIME-builder assertions into the repo. Add `vitest`,
  `npm test` script, and wire the email template + signature rendering into
  the same suite (snapshot the generated HTML, assert no unescaped user
  input reaches the template — the signature fields are user-controlled and
  land in HTML, so escape them).
- Rate-limit/guard: signature fields max lengths, strip `<script>`, and
  render links with `rel="noopener noreferrer"`.

---

# DROP 4 — Piece 3: inbound email (finishes Phase 2)

Per CLAUDE.md. Notes from planning:

- **Routing precedence**: `[BLK-n]` subject token first (it survives
  clients rewriting Message-ID), then `In-Reply-To`/`References` against
  stored `gmail_message_id`, then `gmail_thread_id`, then sender-email +
  recency heuristic. Log which path matched — we want data on whether the
  token is doing the work.
- **New vs reply**: unmatched mail creates a ticket, `channel='email'`,
  status `new`, customer upserted by email address. Matched mail appends
  an inbound message and reopens `pending`/`resolved` tickets (the DB
  trigger already does the reopen).
- **Loop protection, non-negotiable**: ignore mail with
  `Auto-Submitted: auto-*`, `X-Autoreply`, `Precedence: bulk/list/junk`,
  or a `List-Unsubscribe` header. Ignore mail whose sender is any
  `agents.email` or `SUPPORT_EMAIL` (our own sends echo into the mailbox).
  Dedupe by `gmail_message_id` before insert — Pub/Sub redelivers.
  Without these, an out-of-office auto-reply will ping-pong forever.
- **Dev vs prod**: poll `users.history.list` on an interval locally (a
  manual "Check mail now" button in Settings is also useful for testing);
  Pub/Sub push at `/api/webhooks/gmail` in production. Same handler, two
  triggers. Store `last_history_id` so polling is incremental.
- **Watch renewal**: Gmail watch expires every 7 days. Vercel cron daily
  once deployed; note it in the deploy checklist.
- **Body extraction**: prefer `text/plain` part; fall back to stripping
  `text/html`. Trim quoted history (`On <date>, <person> wrote:`, `>`
  prefixes, `-----Original Message-----`) into a collapsed "show quoted
  text" block rather than dumping it in the thread.
- **Attachments**: download to Supabase Storage, row in `attachments`,
  render as chips under the message. Cap at ~10MB/file, skip inline
  images referenced by CID for now (note it).
- **Support mailbox connection**: connect `support@blankssportsnutrition.com`
  as a distinct `oauth_tokens` row (`is_support_inbox = true`) with the
  read scope, separate from personal agent connections.
- **Test path**: send an email from a personal address to support@, confirm
  a ticket appears; reply from the dashboard; reply again from the customer
  side and confirm it threads into the same ticket rather than opening a
  second one.

---

## Suggested commit sequence

Drop 3: tokens+primitives → sidebar/list → thread → composer+side panel →
rich text → email template → signature builder → tests.
Drop 4: support mailbox connect → fetch+parse → routing+loop guards →
attachments → polling/webhook + Settings "Check mail now".

Build passes before every commit. Screenshot-worthy checkpoints after the
thread redesign and after the first branded email lands.
