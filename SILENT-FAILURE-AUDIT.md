# Silent-failure audit

**Date:** 2026-09-08 · **Branch:** `afk/silent-failure-audit` · **Commit audited:** `c72209d`

A sweep for one defect shape: **something fails and reports success.**

Nothing here is fixed. This document is the only change on this branch.

The known instances — a sync that errored and said "no new mail"; `return !error`
treating "couldn't check" as "missing"; EXIF stripping tested and never called; a
vitest glob that skipped `.test.tsx`; an alert counting 37 poison messages as 3; a
widget dropping failed uploads before the server saw them; `raiseSystemAlert`
emailing unless a caller opted out — are all the same move: **a failure converted
into a confident, reassuring value.**

Ranked by blast radius.

---

## 1. A failed count silences the entire inbound heartbeat — CRITICAL

**Where:** `lib/monitoring.ts:203-215`, `lib/monitoring.ts:129`

```ts
const { count: emailTicketCount } = await admin        // error discarded
  .from("tickets").select("id", { count: "exact", head: true }).eq("channel", "email");
...
everReceived: (emailTicketCount ?? 0) > 0
```

and then, in the pure evaluator:

```ts
if (!input.everReceived) {
  return { status: "unknown", reasons: [], historyChangedAt };   // early return
}
```

**Mechanism.** The count query's error is discarded. On failure `count` is
`undefined`, `?? 0` makes it `0`, `everReceived` becomes `false`, and
`evaluateInboundHealth` returns early with **no reasons and no alert**. The flag
exists to stop crying wolf before the first email ever arrives; a failed query is
indistinguishable from a system that has never received mail.

**What an agent sees.** Nothing. The hourly heartbeat reports `unknown`, raises no
alert, sends no email, writes no banner. Inbound email can stop for days in exactly
the way it did for 31 hours in August, and the alarm built to catch that is the
thing that is broken. There are 86 email tickets, so `everReceived` can only be
false through failure.

**Fix.** Read the error and pass a tri-state. `everReceived` should be
`true | false | null`, and `null` must not take the early return — an unmeasurable
baseline is not a reason to go quiet. Roughly ten lines, plus a test that a failed
count does not suppress the alarm.

---

## 2. The `[BLK-n]` routing token silently falls through — HIGH

**Where:** `lib/google/inbound.ts:430-436`

```ts
// 1. Routing token in the subject.
const { data } = await admin.from("tickets").select("id").eq("number", ticketNumber).maybeSingle();
if (data) return { ticketId: data.id, path: "token" };
// falls through on error
```

Strategies **2 and 3, immediately below, get this right** — and say so:

```ts
// A failed routing lookup would fall through to "create a new ticket",
// silently splitting a conversation in two. Fail loudly instead.
if (error) throw new Error(`Routing lookup failed: ${error.message}`);
```

**Mechanism.** The most authoritative signal — the token we put in the subject for
precisely this purpose — is the one strategy that discards its error. A failed
lookup falls through to the weaker heuristics and, if they miss, to creating a new
ticket. The hazard was understood and documented two lines away.

**What a customer/agent sees.** The customer replies to `Re: … [BLK-1042]`. A
second ticket appears with no history. The agent answers without the context, or
answers twice. Nothing is logged.

**Fix.** Destructure `error` and throw, matching strategies 2 and 3. Two lines.
Strategy 4 (`:471`, `:478`) has the same shape at lower stakes — see §6.

---

## 3. The Meta page-token retry path is unreachable — HIGH (latent)

**Where:** `lib/meta/graph.ts:44` (`withPageToken`), `lib/meta/page-token.ts:290`
(`isWrongTokenKind`)

**Proof by reachability, not reading:**

```
$ grep -rn "withPageToken\|isWrongTokenKind" lib app components --include=*.ts --include=*.tsx
lib/meta/graph.ts:44:export async function withPageToken<T>(     # definition only
(no other production reference)
```

Both were written to satisfy "refresh on rejection". Neither has a caller. Every
Meta call uses `getPageAccessToken()`, which resolves and caches but **never
retries on rejection**.

**What an agent sees.** Nothing today — Meta is unreachable anyway. The day a
cached page token is rejected, every Messenger send and the whole health panel
fail, and the recovery mechanism that exists in the file does not run.

This is the EXIF shape exactly: written, commented, believed to work, never wired.
It was introduced two prompts ago by me.

**Fix.** Route the Send API and health calls through `withPageToken`, and use
`isWrongTokenKind` for its rejection test. Perhaps thirty lines, plus a test that a
rejected call re-derives once.

---

## 4. `nextStatusAfterAgentReply` is tested but never called — MEDIUM-HIGH

**Where:** `lib/ticket-status.ts:64`, versus `app/actions.ts:155-157`

The live reply path reimplements the rule inline:

```ts
.update({ status: "resolved" }).in("status", STATUSES_A_REPLY_RESOLVES)
```

`nextStatusAfterAgentReply()` has **three test files** asserting its behaviour and
**zero production callers**.

**Mechanism.** Two copies of one rule. The tests prove the copy the product does
not use. Change the function and the product does not change; change
`app/actions.ts` and the tests stay green either way.

**What an agent sees.** Nothing until the two drift. Then resolve-on-reply behaves
differently from every test and document describing it.

**Fix.** Call the function from `app/actions.ts` and derive the status from its
return value. About five lines. `nextStatusAfterCustomerMessage` is a deliberate
mirror of the DB trigger with a test asserting they agree — that one is fine, and
is listed under "checked and clean".

---

## 5. Monitoring swallows its own failures — MEDIUM

**Where:** `lib/monitoring.ts:248`, `lib/monitoring.ts:280`

```ts
} catch {
  // Monitoring must never be the thing that breaks.
}
```

**Mechanism.** Two `catch {}` blocks around settings-blob reads. If the first
fails, `recentlyDropped` stays null and the heartbeat loses the ability to say
"mail arrived and we discarded all of it" — the distinction CLAUDE.md says the
heartbeat exists to make. If the second fails, the reconciliation-staleness check
silently does not run, so "nothing is checking for mail that went missing" is never
said. The watchdog's watchdog fails quietly.

**What an agent sees.** A heartbeat that reads "No inbound email for 31h" when the
truth is "mail arrived and every message was dropped" — opposite fixes, identical
text. Or a reconciliation that has not run for a week with nothing saying so.

**Fix.** Keep the catch — the intent is right — but record the failure as a reason
rather than discarding it: "the sync's own record could not be read". Six lines.

---

## 6. Routing strategy 4 discards two errors — MEDIUM

**Where:** `lib/google/inbound.ts:471`, `:478`

Customer lookup and recent-ticket lookup both drop their errors; a failure falls
through to creating a new ticket. Same shape as §2, lower stakes because this
strategy is a heuristic of last resort — but the outcome (a split conversation) is
identical.

**Fix.** Destructure and throw, or at minimum record it in the sync result's
failure list so the cursor holds.

---

## 7. `currentReplyWindow` decides the 24-hour window from a failed query — MEDIUM (latent)

**Where:** `lib/meta/outbound.ts:48-57`

```ts
const { data } = await admin.from("messages")...   // error discarded
return replyWindow((data?.created_at as string | undefined) ?? null);
```

**Mechanism.** A failed query is indistinguishable from "this customer has never
messaged us". The window is then computed from `null`, which is the same input as a
ticket with no inbound message — and this is the value that decides whether a reply
is free-form, needs the `HUMAN_AGENT` tag, or is blocked outright.

**What an agent sees.** Either a reply blocked with "the window has closed" when it
has not, or a send attempted that Meta refuses. Both on a transient database error.

**Fix.** Return a `ReplyWindow` that carries "unknown", and have the composer treat
unknown as "allow, but warn" rather than as expired. Ten lines. Worth doing as part
of Drop 9E rather than separately.

---

## 8. Notification queue and thread lookups default to empty — MEDIUM-LOW

**Where:** `lib/notifications/send.ts:76` (`gatherQueue`), `:112` (`threadRoot`)

`gatherQueue` discards its error and `data ?? []` produces an empty queue: the
assignment email then tells an agent they have **no outstanding tickets** when they
may have twenty. `threadRoot` failing means a fresh email thread instead of
threading onto the existing one.

**What an agent sees.** A "your queue" block that says zero, which is worse than
omitting the block. Or escalations that stop threading and look like new alerts.

**Fix.** Pass `null` rather than an empty breakdown, and omit the queue block
entirely when it could not be measured — the same rule already applied to the
sidebar counts.

---

## 9. Risk counts treat a failed query as zero — LOW

**Where:** `lib/risk/assess.ts:55`, `:70`, `:80`

`priorTicketCount = prior ?? 0` and `recentTicketCount = recent ?? 0`. A failed
count reads as "no prior contact", suppressing the repeat-contact signal.

Notably, the *same file* gets this exactly right for Shopify: a lookup that could
not run stores `null`, not `false`, with a comment explaining why. The care was not
extended to the counts beside it.

**What an agent sees.** A ticket that should carry "Review carefully" does not.
Advisory only, so the blast radius is small — but it is the signal-suppression
direction, which is the quiet one.

**Fix.** Make the counts `number | null` and let `assessRisk` skip the signal on
null, as it already does for `shopifyCustomerFound`.

---

## 10. `isIgnoredSender` is an unused duplicate — LOW

**Where:** `lib/senders/ignored.ts:47`

**Proof by execution.** The live guard works — I ran it:

```
ignored address -> {"rule":"ignored-sender","detail":"spam@vendor.example"}
ignored domain  -> {"rule":"ignored-sender","detail":"@blocked.example (a@blocked.example)"}
ordinary sender -> null
```

`evaluateInboundGuards` implements the matching inline. `isIgnoredSender` has a
test and no production caller. No behavioural gap **today**; the risk is drift —
someone fixes a matching bug in one copy and the other keeps the old behaviour,
with tests green on the copy nobody runs.

**Fix.** Either call it from `evaluateInboundGuards` or delete it. Deleting is
honest; keeping an untested-in-situ duplicate is not.

---

# Checked and clean

Ruled out, with what was checked:

**Safe-by-default flags (c).** `backfillFromMailbox` uses `options.apply === true`
and `dryRun = true` — forgetting means "do nothing", which is the right direction.
`notifications_enabled === false` means an undefined column still notifies, which
fails toward telling people. `shopifyCustomerFound === false` correctly
distinguishes `null` from `false` in both `lib/risk/signals.ts` and
`lib/vendor/outreach.ts`.

**`raiseSystemAlert`.** Fixed in `c72209d`; the rate limit now lives in the
function rather than in each caller. Verified all seven call sites are covered
regardless of whether they pass `notify`.

**The schema checker.** No `!error` shape remains. `readInventory` returns
`{unavailable}` or `{absent}` and never a half-populated inventory; `PGRST202`
gets a 60-second grace before being called missing.

**The upload path.** `claimUploads` and `validateUploads` fail closed on every
branch; a rejection returns 400 with no ticket. `storeAttachments` now returns
`{stored, failed}` and writes the loss into the ticket body.

**Quarantine and the Meta queue.** `loadQuarantinedIds` returns `null` on a failed
read and the caller aborts the run rather than treating it as "nothing
quarantined". `drainWebhookEvents` reports `queueError` rather than an empty queue.

**Inbound cursor handling.** Advances only to a consumed record boundary; a record
with no id leaves the cursor alone. A Gmail 404 is a skip, not a failure.

**Deploy and version checks.** `compareDeploy` returns `unknown` for either side
being unreadable and never `behind`; `VersionWatcher` never treats a null build id
as a change.

**Reconciliation (mailbox, Messenger, uploads).** All three report `error` rather
than a clean run, and a failed run records `at: null` rather than stamping a
success.

**`app/(dashboard)/` query-error honesty.** `tests/query-error-honesty.test.ts`
asserts structurally that list and count queries destructure `error:`, that the
error branch precedes the empty-state branch, and that counts pass `null` rather
than `0`. Still passing.

**Test-only exports.** `signMetaBody`, `resetSchemaCheckCache`,
`nextStatusAfterCustomerMessage` (a deliberate mirror of the DB trigger, with a
test asserting the SQL agrees), `planFolderSweep`, `identifyToken` and the various
exported constants are all either used in-file or intentionally exposed for tests.
Not dead in the sense that matters.

---

# Method, and what this audit cannot tell you

- **(a)** 118 `catch` blocks read; the ones listed are those where the caller goes
  on to report success. Most of the rest are deliberate and documented.
- **(b)** Grepped every `!error`, `error ?`, and `const { data } =` without an
  error binding; each hit inspected in context.
- **(d)** Reachability established by counting production references excluding the
  defining file, then excluding same-file self-use, then **executing** the
  survivors where behaviour was in doubt (§10). Reading was not accepted as proof.
- **(e)/(f)** Every `count: "exact"` and every `?? 0` / `?? []` on a query result.

**Not covered:** React component internals, the SQL migrations themselves, and
anything requiring a live Meta or production Vercel session. Two findings (§3, §7)
are latent because Meta is unreachable — they cannot be triggered today and are
ranked on what they will do when it is.
