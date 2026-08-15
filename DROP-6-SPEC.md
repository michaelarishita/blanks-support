# Drop 6 — Brand, notifications, and chasing

Five workstreams. 6A is a correctness landmine, read it first.

---

## 6A. Remove `[BLK-n]` from the subject — WITHOUT losing routing

Michael wants the ticket token invisible to customers. Fine, but that token
is currently the **primary inbound routing key**, deliberately chosen
because it survives clients rewriting `Message-ID`. Deleting it naively
means customer replies stop threading and start opening duplicate tickets —
silently. So replace it with two stronger channels before removing it.

**New routing, in precedence order:**

1. **Plus-addressed Reply-To.** `Reply-To: hello+blk1003@blankssportsnutrition.com`
   (Google Workspace supports plus addressing natively; mail still lands in
   `hello@`). When the customer hits Reply, that address goes into their
   `To:` — so the ticket id rides back with the reply, invisibly, without
   the subject. Parse the `+` tag off the delivered-to/To/Cc headers.
2. **Custom header** `X-Blanks-Ticket: 1003` on outbound, checked on
   inbound. Free, and survives most clients that quote-reply.
3. `In-Reply-To` / `References` against stored `gmail_message_id`.
4. `gmail_thread_id`.
5. **Legacy subject token** — keep the matcher for tickets created before
   this change. Do not remove the parser, only stop emitting it.
6. Sender + subject recency heuristic (unchanged, still requires subject
   match).

**Verification before shipping:** send a reply from Gmail, Apple Mail, and
Outlook web to a ticket with no subject token, and confirm each threads by
plus-address. Log `match_path` on every inbound message — if `plus_address`
isn't the dominant path afterwards, something is stripping it and we need
the subject token back. Ship the removal only after that evidence exists.

Also: subject becomes `Re: <subject>` for replies and `<subject>` for a
first send. No token, no bracket.

---

## 6B. Email presentation

**From display name.** `From: "Blank's Sports Nutrition" <michael@blankssportsnutrition.com>`
— company name in the display slot, the agent's real address underneath so
the send is authenticated and lands in their Sent folder. (If Michael later
prefers "Michael at Blank's Sports Nutrition", that's a one-line change —
make the format a constant, not a literal.)

**Logo hidden behind Gmail's "see more".** Root cause: the logo sits at the
bottom of the signature, and Gmail's clipping collapses everything from the
signature/quote boundary down. Fix by moving the brand mark **above** the
fold rather than fighting the collapse:

- Put the logo in a **header band at the top of the email card** — small
  (max-height 40px), left-aligned, above the reply body, on white.
- The signature below stays text-only: name, title, company, website link.
- This also matches how the reply reads: brand first, message, sign-off.

Keep the logo `<img>` absolute-URL'd, with `alt`, explicit width/height,
and a text fallback. Re-test in Gmail desktop + iOS, Apple Mail, Outlook.

---

## 6C. Rebrand to blue

Primary: **`#0061ff`**. Aesthetic: white / black / blue (blue-raspberry).

Replace amber everywhere — dashboard tokens, focus rings, active nav rail,
primary buttons, badges, the email template accents, and the wordmark
square. There should be no amber left outside of the semantic warning color
(which stays amber precisely because it means something different).

Do this properly, not with find/replace on a hex:

- Generate a full 50→950 ramp from `#0061ff` and put it in the token layer.
  `#0061ff` is the 500/primary step.
- **Contrast-check before committing.** `#0061ff` on white is around 4.5:1 —
  fine for large text, buttons and UI chrome, marginal for small body text
  and links. Use a darker step (~`#0047c2`) for inline links and small text
  on white; keep `#0061ff` for fills, and white text on `#0061ff` for
  buttons. Assert the checks in the test suite so a future palette tweak
  can't quietly break legibility.
- Status colors keep their semantic hues (green/amber/red) — only the brand
  accent changes.

---

## 6D. Inbound freshness (interim, until Pub/Sub)

- Run a sync on dashboard load (debounced, max once per 60s per user) and
  on a light interval while a session is open.
- Keep the manual "Check mail now" button.
- Note: once A3's Pub/Sub push is live this becomes a safety net rather
  than the mechanism. Leave it in — it's what saves us if a watch lapses.

---

## 6E. Assignment notifications, reminders, and escalation

The big one. Sends from `hello@` to the assigned agent.

### Loop protection — non-negotiable

These are emails from `hello@` to internal addresses, and `hello@` is the
watched mailbox. Without guards, a reply or an out-of-office turns into a
ticket, and a notification about that ticket can cascade.

- Stamp every notification with `X-Blanks-Notification: 1` and
  `Auto-Submitted: auto-generated`.
- Inbound drops anything carrying either header, plus anything from an
  address in `agents` (already true), plus `IGNORED_SENDER_EMAILS`.
- Set `Reply-To` on notifications to a non-monitored address (or the
  agent's own), never to plain `hello@`.
- Add an inbound test asserting a notification email fed back in produces
  no ticket.

### Trigger

On `tickets.assignee_id` changing to a non-null agent (and on escalation /
reminder fire). Not on self-assignment? — send anyway; Michael assigning
himself still wants the record. Skip only if the agent has notifications
disabled.

### Threading

**One thread per (agent, ticket).** The first assignment email starts it;
every reminder and escalation for that ticket to that agent replies into
it. Store the root `Message-ID` on a new row so later sends can set
`In-Reply-To`/`References`. Subject stays byte-identical across the thread
(`New Customer Service Ticket Assigned to You`) — Gmail needs both the
header chain and a stable subject to group reliably.

### Content

**Subject:** `New Customer Service Ticket Assigned to You`

**Part 1 — this ticket**
- Priority (visually weighted — urgent reads urgent), topic/tags
- Customer name and channel
- Ticket number and subject line
- A brief summary: first ~200 chars of the customer's latest message,
  whitespace-collapsed, HTML-stripped, ending on a word boundary. (A real
  AI summary is an Ike job later — leave a seam, don't build it now.)
- Age of the ticket

**Part 2 — your outstanding queue**
- Count of open (non-resolved/closed) tickets assigned to this agent,
  broken down by priority: Urgent / High / Normal / Low
- Timestamp + date of their oldest outstanding ticket, with its age
- Keep it scannable — a small table, not prose

**Actions**
- Primary button → deep link to that ticket on
  `support.blankssportsnutrition.com`
- Secondary → link to their "My tickets" view

**Remind me later:** buttons for **1 hour / 4 hours / 8 hours / 24 hours**.

### Reminder links — the prefetch trap

Email clients (Gmail, Outlook, security scanners) **prefetch GET links**.
A bare `GET /remind?...` would schedule reminders nobody clicked, and worse,
could be triggered by a scanner the instant the mail arrives.

Required design:
- Link is signed (HMAC over agent id + ticket id + delay + expiry) and
  **lands on a confirmation page** that performs the action via an explicit
  POST from that page — never as a side effect of the GET.
- Signed token is single-use and expires (24h).
- The action is idempotent: clicking twice reschedules, it doesn't stack.
- Page renders a clear confirmation ("Reminder set for 4:30 PM") and a
  cancel option.
- No session required to use it — the signature is the authorization. Do
  not leak ticket contents on that page; show the number only.

### Escalation (automatic, no clicking)

Unanswered assigned tickets get chased on this schedule, measured from
last customer message (not from assignment):

| Priority | Escalate after |
|---|---|
| Urgent | 8 hours |
| High | 24 hours |
| Normal | 48 hours |
| Low | 72 hours |

- Fires into the same (agent, ticket) thread, subject unchanged.
- Escalation copy should be firmer each time it repeats; cap repeats at 3
  per ticket per agent then notify admins (`ALERT_EMAIL`) instead of
  continuing to shout into the void.
- Suppress if status is resolved/closed, if the ticket is pending on the
  customer, or if a reminder the agent set is still in the future.
- **Quiet hours**: don't send between 9pm and 7am America/Phoenix; queue to
  the next window. Nobody needs a 3am ticket nag, and it trains people to
  ignore the emails.

### Data

New table `notifications`:
`id, agent_id, ticket_id, kind (assignment|reminder|escalation), thread_message_id,
scheduled_for, sent_at, escalation_count, created_at`, indexed on
`(scheduled_for) where sent_at is null`.

Plus `agents.notifications_enabled boolean default true` and a Settings
toggle — someone will want to mute this, and they'll resent it if they
can't.

### Cron

Every 10 minutes (`CRON_SECRET` guarded): send due reminders, evaluate
escalations, respect quiet hours. Idempotent — a double-run must not
double-send.

### Test coverage

Assignment fires once and only once per assignment change; reminder link
signature verification (valid, tampered, expired, replayed); escalation
thresholds at boundary values; quiet-hours deferral; suppression when
resolved; notification email fed back through inbound creates no ticket;
threading headers present and stable across a 3-message chain.

---

## Sequencing

1. 6C (blue) — visible, self-contained, low risk.
2. 6B (from name, logo placement) — small, testable in a live send.
3. 6D (sync on load) — small.
4. 6E (notifications) — the real build. Ship assignment email first,
   verify threading and loop safety live, then add reminders, then
   escalation.
5. 6A (subject token) — LAST, and only after the plus-address routing has
   been proven with real replies from three clients. This is the one that
   breaks customer conversations if it's wrong.
