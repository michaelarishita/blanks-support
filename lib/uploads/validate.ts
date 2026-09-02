import { ACCEPTED_DESCRIPTION, MAX_FILES, MAX_FILE_BYTES } from "./limits";
import { safeStoredName, sniffFileType, type UploadKind } from "./sniff";
import { stripMetadata } from "./strip";

/**
 * The gate every customer upload passes through.
 *
 * Kept separate from the route so the rules can be tested directly, and run
 * BEFORE anything is written: a rejected file must not leave a half-created
 * ticket behind, so nothing is persisted until every file has passed.
 */

// Re-exported so server code has one import for the whole upload contract,
// while the client can take limits.ts alone and skip the strippers.
export {
  ACCEPTED_DESCRIPTION,
  MAX_FILES,
  MAX_FILE_BYTES,
} from "./limits";

export interface IncomingFile {
  /** Present when the bytes arrived via a signed upload grant. */
  path?: string;
  name: string;
  bytes: Uint8Array;
}

export interface AcceptedFile {
  /** Sanitised, with the extension we determined rather than the one supplied. */
  filename: string;
  kind: UploadKind;
  isImage: boolean;
  /** Post-strip. This is what gets stored. */
  bytes: Uint8Array;
  /**
   * The intake/ path this came from, when it came through a grant.
   *
   * Carried so the ledger can be closed against the right row. Absent for the
   * inbound-email path, which never mints a grant.
   */
  sourcePath?: string;
}

export interface Rejection {
  /** The name as supplied — logged, never echoed into a storage path. */
  name: string;
  reason: string;
}

export type ValidationOutcome =
  | { ok: true; files: AcceptedFile[] }
  | { ok: false; message: string; rejections: Rejection[] };

/**
 * Validates a batch, all-or-nothing.
 *
 * Partial acceptance was tempting and is wrong: a customer who attaches three
 * photos and gets a ticket containing two has been told nothing, and will
 * usually not notice until an agent asks about the missing one.
 */
export function validateUploads(incoming: IncomingFile[]): ValidationOutcome {
  if (incoming.length > MAX_FILES) {
    return {
      ok: false,
      message: `Please attach at most ${MAX_FILES} files.`,
      rejections: [{ name: `${incoming.length} files`, reason: "too many files" }],
    };
  }

  const accepted: AcceptedFile[] = [];
  const rejections: Rejection[] = [];

  for (const file of incoming) {
    if (file.bytes.length === 0) {
      rejections.push({ name: file.name, reason: "empty file" });
      continue;
    }
    if (file.bytes.length > MAX_FILE_BYTES) {
      rejections.push({ name: file.name, reason: `over ${MAX_FILE_BYTES} bytes` });
      continue;
    }

    // From the CONTENT. The name and the browser's Content-Type are both
    // chosen by whoever is uploading, so neither is evidence of anything.
    const sniffed = sniffFileType(file.bytes);
    if (!sniffed) {
      rejections.push({ name: file.name, reason: "type not on the allowlist" });
      continue;
    }

    const stripped = stripMetadata(sniffed.kind, file.bytes);
    if (!stripped.ok) {
      // A file we could not fully parse is refused rather than stored as-is.
      // "We couldn't read it" is a better outcome than quietly keeping the
      // GPS coordinates we promised to remove.
      rejections.push({ name: file.name, reason: `metadata: ${stripped.reason}` });
      continue;
    }

    accepted.push({
      filename: safeStoredName(file.name, sniffed.extension),
      kind: sniffed.kind,
      isImage: sniffed.isImage,
      bytes: stripped.bytes,
      sourcePath: file.path,
    });
  }

  if (rejections.length) {
    return { ok: false, message: customerMessage(rejections), rejections };
  }
  return { ok: true, files: accepted };
}

/**
 * One sentence the customer can act on.
 *
 * The internal reason is NOT echoed back — "metadata: unrecognised HEIC
 * layout" tells a customer nothing and tells someone probing the endpoint
 * exactly which parser they just reached. The detail goes to the log instead.
 */
function customerMessage(rejections: Rejection[]): string {
  const names = rejections.map((r) => r.name).filter(Boolean);
  const subject =
    names.length === 1 ? `“${names[0]}”` : `${rejections.length} of your files`;

  if (rejections.every((r) => r.reason.startsWith("over "))) {
    return `${subject} is too large — each file must be under 10MB.`;
  }
  if (rejections.every((r) => r.reason === "empty file")) {
    return `${subject} appears to be empty.`;
  }
  return `We couldn't accept ${subject}. Please attach ${ACCEPTED_DESCRIPTION} files under 10MB.`;
}
