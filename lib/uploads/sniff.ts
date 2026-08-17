/**
 * What kind of file is this, actually?
 *
 * Determined from the CONTENT, never from the extension or the browser's
 * Content-Type. Both of those are supplied by whoever is uploading, and this
 * is a public endpoint — the whole point of an allowlist is defeated if the
 * uploader also gets to say which entry they match.
 *
 * Pure, so every branch is testable from a byte array.
 */

export type UploadKind =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic"
  | "application/pdf";

export interface SniffedType {
  kind: UploadKind;
  /** Canonical extension, used to build the stored filename. */
  extension: string;
  /** True for the kinds the thread renders as a thumbnail. */
  isImage: boolean;
}

const TYPES: Record<UploadKind, { extension: string; isImage: boolean }> = {
  "image/jpeg": { extension: "jpg", isImage: true },
  "image/png": { extension: "png", isImage: true },
  "image/webp": { extension: "webp", isImage: true },
  "image/heic": { extension: "heic", isImage: true },
  "application/pdf": { extension: "pdf", isImage: false },
};

export const ALLOWED_KINDS = Object.keys(TYPES) as UploadKind[];

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

/**
 * HEIC major brands.
 *
 * `mif1` is the generic ISO image brand and is shared with AVIF, so it is not
 * accepted on its own — the compatible-brands list has to name a real HEIF
 * brand too. Accepting bare `mif1` would let AVIF through an allowlist that
 * does not include it.
 */
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
]);

function isHeic(bytes: Uint8Array): boolean {
  // ISO-BMFF: [4-byte box size][4-byte type 'ftyp'][4-byte major brand]
  //           [4-byte minor version][compatible brands…]
  if (ascii(bytes, 4, 4) !== "ftyp") return false;

  const major = ascii(bytes, 8, 4);
  if (HEIC_BRANDS.has(major)) return true;
  if (major !== "mif1" && major !== "msf1") return false;

  const boxSize = readUint32(bytes, 0);
  // Bounded: a malformed size must not walk the whole buffer.
  const end = Math.min(boxSize > 0 ? boxSize : 0, bytes.length, 512);
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (HEIC_BRANDS.has(ascii(bytes, offset, 4))) return true;
  }
  return false;
}

export function readUint32(bytes: Uint8Array, offset: number): number {
  if (bytes.length < offset + 4) return 0;
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

/** The type, or null if it isn't one of the five we accept. */
export function sniffFileType(bytes: Uint8Array): SniffedType | null {
  const kind = detectKind(bytes);
  if (!kind) return null;
  return { kind, ...TYPES[kind] };
}

function detectKind(bytes: Uint8Array): UploadKind | null {
  // JPEG: SOI marker.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG: the 8-byte signature, including the CR/LF pair that detects
  // text-mode transfer corruption.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  // WebP: RIFF container with a WEBP form type.
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }

  if (isHeic(bytes)) return "image/heic";

  // PDF. The spec allows junk before the header, but accepting that would
  // also accept a polyglot whose first bytes are something else entirely.
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";

  return null;
}

/** Filename for storage: our extension, never the uploader's. */
export function safeStoredName(original: string, extension: string): string {
  const base = (original.split(/[/\\]/).pop() ?? "file")
    // Strip the original extension; the sniffed one replaces it.
    .replace(/\.[^.]{1,10}$/, "")
    .replace(/[^\w.\- ]+/g, "_")
    .trim()
    .slice(0, 80);
  return `${base || "attachment"}.${extension}`;
}
