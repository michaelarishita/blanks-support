# Prompt 32 — Attachments on outbound email replies

Branch `afk/outbound-attachments`. **Do not merge.** **No migration** — the
`attachments` table already keys on `message_id` (works for outbound rows),
`upload_grants` is storage-path-generic, delivery status lives on `messages`.
`0027` stays free; `npm run migrations:pending` is clean.

## What ships

- **Direct-to-storage upload, reused from Drop 8A.** The composer requests a
  signed URL from a new *authenticated* endpoint `POST /api/replies/upload-url`
  (mints under an `outbound/` temp prefix), the browser PUTs straight to
  Supabase, and the send receives grants only — bytes never cross a Vercel
  function (the 4.5MB limit that broke the widget applies here too).
- **Verify on send = the intake claim, reused.** `storeOutboundAttachments`
  (`lib/uploads/outbound.ts`) claims each grant: signature valid, object present
  (single-use), real size, content sniffed to an allowed type, **EXIF stripped,
  fail-closed** — then writes under `<ticketId>/<messageId>/…`.
- **Two silent retries then a visible failure** (`useComposerAttachments`),
  mirroring the widget; uploads start on pick, Send is disabled while any upload
  is in flight, failed, or over the size cap.
- **Attach from the ticket.** Existing attachments are offered for re-sending
  (a customer's photo back to them, or forwarded across tickets); copied by
  bytes into the new message's folder so each is self-contained.
- **MIME** (`lib/email/mime.ts`, rebuilt as a nested builder): inline images →
  `multipart/related` embedded at the end of the body via `cid:`; non-images →
  `multipart/mixed` attachments. With no attachments the output is byte-identical
  to before, so notification and plain-reply mail is unchanged.
- **Size cap before the agent writes** — `MAX_OUTBOUND_TOTAL_BYTES` = 25MB raw
  (base64 ≈ 33MB, under Gmail's ~35MB). Enforced in the composer and re-checked
  in `deliverMessage` as a backstop; a failure records a real reason.
- **Thread display** is unchanged — outbound attachments render through the same
  `Attachments` component + lightbox as inbound.

## The Content-ID trap — why it's defused

The prompt warned about Content-ID confusion between photos and the signature
logo. Two facts settle it:

1. **The signature logo is an absolute `https://` URL, not a `cid:`.** So new
   inline-photo Content-IDs cannot collide with it. The signature still renders
   (its table row is untouched; inline images are injected in a separate row
   before it — verified by the template tests).
2. **Photo Content-IDs are uuid-namespaced** (`blkatt-<attachmentId>@…`). When a
   customer replies quoting our message, our `cid:` references can never match a
   Content-ID on *their* photo, so the inbound "inline image" drop
   (`isReferencedByBody`) cannot misfile a customer's new attachment.
   `tests/outbound-attachments.test.ts` asserts this both ways.

## Overlap with parked `afk/meta-outbound` — none

`afk/meta-outbound` touches only `lib/meta/{outbound,send,window}.ts` and its own
test. It does not touch `lib/google/outbound.ts`, `lib/email/mime.ts`,
`app/actions.ts`, `components/ReplyBox.tsx`, `lib/attachments.ts`, or the uploads
machinery. Both only *read* the shared `isInlineSafe()` allowlist. The Gmail MIME
path and the Meta Send API path are independent — these branches merge without
conflict, in either order.

## Reused, generalized (backward-compatible)

- `verifyUploadGrant` now accepts any `TEMP_UPLOAD_PREFIXES` member (`intake/`
  **or** `outbound/`); the HMAC still binds the exact path.
- `claimUploads` / `validateUploads` take an optional `maxFiles` (intake still 3;
  outbound 5).
- `requestUploadUrls(files, endpoint?)` — the widget keeps the default endpoint.
- The orphan sweep now covers both temp prefixes; abandoned outbound uploads are
  swept after 24h like intake.
