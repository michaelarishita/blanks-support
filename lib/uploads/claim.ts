import { createAdminClient } from "@/lib/supabase/admin";
import { verifyUploadGrant } from "./grant";
import { resolveGrant } from "./ledger";
import { MAX_FILES, validateUploads, type ValidationOutcome } from "./validate";

/**
 * Turns grants the customer hands back into verified, stripped bytes.
 *
 * Uploads no longer pass through our function, so this is the ONLY place the
 * server ever sees what was actually stored. Everything that used to happen at
 * the edge of the request happens here instead, and nothing has been dropped:
 * the signature proves we minted the path, the object's presence proves the
 * grant is unspent, the real byte length is checked against the declared one,
 * the content is sniffed, and the metadata is stripped or the file is refused.
 *
 * A client that skips the upload and posts a grant anyway gets nothing: there
 * is no object at that path, and the claim fails.
 */

export interface ClaimOutcome {
  result: ValidationOutcome;
  /** Temp paths seen, whether or not they validated. All are removed. */
  paths: string[];
}

/**
 * Downloads, consumes and validates each granted upload.
 *
 * The temp object is deleted whether or not the batch is accepted. On success
 * the bytes have already been read and are about to be rewritten to their
 * final path; on failure the customer is re-picking anyway, and leaving
 * rejected files in the bucket is how a public endpoint becomes free storage.
 *
 * Deleting also makes a grant single-use without any bookkeeping: replay it
 * and there is nothing to download.
 */
export async function claimUploads(grants: unknown): Promise<ClaimOutcome> {
  if (!Array.isArray(grants) || grants.length === 0) {
    return { result: { ok: true, files: [] }, paths: [] };
  }

  if (grants.length > MAX_FILES) {
    return {
      result: {
        ok: false,
        message: `Please attach at most ${MAX_FILES} files.`,
        rejections: [{ name: `${grants.length} files`, reason: "too many grants" }],
      },
      paths: [],
    };
  }

  const admin = createAdminClient();
  // `path` rides along so a verdict can be attributed to the grant it came
  // from; validateUploads ignores it.
  const incoming: { name: string; path: string; bytes: Uint8Array }[] = [];
  const rejections: { name: string; reason: string }[] = [];
  const paths: string[] = [];

  for (const grant of grants) {
    const verified = verifyUploadGrant(grant);
    if (!verified.ok) {
      // Forged, tampered with, or simply stale. Not echoed to the caller —
      // "invalid" versus "expired" is a probing oracle, and the customer's
      // action is the same either way.
      rejections.push({ name: "attachment", reason: `grant ${verified.reason}` });
      continue;
    }

    paths.push(verified.path);

    const { data, error } = await admin.storage
      .from("attachments")
      .download(verified.path);

    if (error || !data) {
      // Nothing there: the upload never completed, or this grant was already
      // spent. Both mean there is no file to attach.
      const reason = `upload missing (${error?.message ?? "no object"})`;
      // THE case this ledger was built for: we invited an upload and the
      // bytes never arrived. Previously this left no trace anywhere.
      await resolveGrant(verified.path, "missing", reason);
      rejections.push({ name: verified.originalName, reason });
      continue;
    }

    incoming.push({
      name: verified.originalName,
      path: verified.path,
      bytes: new Uint8Array(await data.arrayBuffer()),
    });
  }

  // Every protection that used to run on the request body runs here, on the
  // bytes that were actually stored: real size, content sniffing, EXIF
  // stripping, fail-closed on anything unparsed.
  const result = rejections.length
    ? {
        ok: false as const,
        message:
          "We couldn't accept your attachments. Please try adding them again.",
        rejections,
      }
    : validateUploads(incoming);

  // The verdict, per grant. A rejection here is a file we HAD and refused —
  // materially different from one that never arrived, and the ledger is where
  // that difference becomes countable.
  if (!result.ok) {
    for (const item of incoming) {
      const why = result.rejections.find((r) => r.name === item.name);
      await resolveGrant(item.path, "rejected", why?.reason ?? "rejected");
    }
  }

  return { result, paths };
}

/** Removes temp objects. Never throws — a stuck file is the sweep's problem. */
export async function discardTempUploads(paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    const admin = createAdminClient();
    const { error } = await admin.storage.from("attachments").remove(paths);
    if (error) console.error("[uploads] could not remove temp objects:", error);
  } catch (e) {
    console.error("[uploads] could not remove temp objects:", e);
  }
}
