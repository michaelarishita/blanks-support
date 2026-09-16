import { createAdminClient } from "@/lib/supabase/admin";
import { claimUploads, discardTempUploads } from "./claim";
import { resolveGrant, linkGrantToAttachment } from "./ledger";
import { safeStoredName } from "./sniff";
import { MAX_OUTBOUND_FILES } from "./limits";

/**
 * Puts an agent's outbound-reply attachments into the ticket, from two sources:
 *
 *   grants  — files the agent just uploaded (browser → Supabase). Claimed
 *             exactly like intake: grant verified, object present (single-use),
 *             real size checked, content sniffed, EXIF stripped, fail-closed.
 *   reuse   — attachments already on a ticket (send a customer's photo back, or
 *             forward one across tickets). Copied by bytes into this message's
 *             own folder so it is self-contained — the folder sweep reasons
 *             per-ticket, and a cross-ticket reference would 404 if the source
 *             ticket were deleted. Already stripped at their original ingest.
 *
 * Both land under `<ticketId>/<messageId>/…`, the same layout inbound uses, so
 * `deliverMessage` and the thread render them identically. Never throws — a
 * failed attachment is reported, not allowed to abort the reply.
 */

export interface OutboundStoreResult {
  stored: number;
  failed: { name: string; reason: string }[];
}

type Admin = ReturnType<typeof createAdminClient>;

async function storeOne(
  admin: Admin,
  ticketId: string,
  messageId: string,
  index: number,
  file: { filename: string; mimeType: string; bytes: Uint8Array }
): Promise<{ id: string } | { error: string }> {
  const path = `${ticketId}/${messageId}/${index}-${file.filename}`;
  const { error: uploadError } = await admin.storage
    .from("attachments")
    .upload(path, file.bytes, { contentType: file.mimeType, upsert: false });
  if (uploadError) return { error: uploadError.message };

  const { data, error: rowError } = await admin
    .from("attachments")
    .insert({
      message_id: messageId,
      filename: file.filename,
      mime_type: file.mimeType,
      size_bytes: file.bytes.length,
      storage_path: path,
    })
    .select("id")
    .single();
  if (rowError || !data) {
    // Row failed after the object landed — remove the orphan so the folder
    // sweep is not left something it can't attribute.
    await admin.storage.from("attachments").remove([path]);
    return { error: rowError?.message ?? "row insert failed" };
  }
  return { id: data.id as string };
}

export async function storeOutboundAttachments(
  ticketId: string,
  messageId: string,
  opts: { grants?: unknown; reuseAttachmentIds?: string[] }
): Promise<OutboundStoreResult> {
  const admin = createAdminClient();
  const result: OutboundStoreResult = { stored: 0, failed: [] };
  let index = 0;

  // --- New uploads (grants) ---
  const grants = Array.isArray(opts.grants) ? opts.grants : [];
  if (grants.length) {
    const { result: claimed, paths } = await claimUploads(grants, MAX_OUTBOUND_FILES);
    try {
      if (!claimed.ok) {
        for (const r of claimed.rejections) result.failed.push({ name: r.name, reason: r.reason });
      } else {
        for (const file of claimed.files) {
          const stored = await storeOne(admin, ticketId, messageId, index++, {
            filename: file.filename,
            mimeType: file.kind,
            bytes: file.bytes,
          });
          if ("error" in stored) {
            result.failed.push({ name: file.filename, reason: stored.error });
            if (file.sourcePath) await resolveGrant(file.sourcePath, "rejected", stored.error);
          } else {
            result.stored++;
            if (file.sourcePath) {
              await resolveGrant(file.sourcePath, "stored");
              await linkGrantToAttachment(file.sourcePath, stored.id);
            }
          }
        }
      }
    } finally {
      // Temp objects go whether or not they validated — same as intake.
      await discardTempUploads(paths);
    }
  }

  // --- Reused ticket attachments (copied by bytes) ---
  for (const id of opts.reuseAttachmentIds ?? []) {
    const { data: source, error } = await admin
      .from("attachments")
      .select("filename, mime_type, storage_path")
      .eq("id", id)
      .maybeSingle();
    if (error || !source) {
      result.failed.push({ name: "attachment", reason: "source not found" });
      continue;
    }
    const { data: blob, error: dlError } = await admin.storage
      .from("attachments")
      .download(source.storage_path as string);
    if (dlError || !blob) {
      result.failed.push({ name: source.filename as string, reason: "could not read source" });
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Re-sanitise the name; the stored bytes were already stripped at ingest.
    const filename = safeStoredName(
      source.filename as string,
      ((source.filename as string).split(".").pop() ?? "").toLowerCase()
    );
    const stored = await storeOne(admin, ticketId, messageId, index++, {
      filename: (source.filename as string) || filename,
      mimeType: (source.mime_type as string) ?? "application/octet-stream",
      bytes,
    });
    if ("error" in stored) result.failed.push({ name: source.filename as string, reason: stored.error });
    else result.stored++;
  }

  return result;
}
