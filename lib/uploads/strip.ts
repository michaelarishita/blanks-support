import { readUint32, type UploadKind } from "./sniff";

/**
 * Metadata removal, in particular EXIF.
 *
 * A customer photographing a damaged tub is photographing it at home, and an
 * iPhone stamps that address into the file as GPS coordinates. That data then
 * sits in our storage bucket, gets handed to an agent, and would end up in the
 * Phase 5 training export. None of that is anything anyone asked for.
 *
 * Pure byte manipulation with no image library: `sharp` means native binaries,
 * and this project has already paid for one round of Vercel build archaeology.
 * Everything here only ever DELETES structure — no re-encoding, so the image a
 * customer sent is the image the agent sees, minus the metadata.
 *
 * FAIL CLOSED. Every function returns a reason instead of bytes when it does
 * not fully understand the file. A stripper that silently passes a file
 * through on a parse it didn't follow is worse than no stripper, because the
 * whole point is a guarantee.
 */

export type StripResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

/**
 * Joins byte ranges.
 *
 * Output is built as a list of slices rather than a number[] because the
 * obvious `out.push(...bytes.subarray(i))` blows the call stack somewhere
 * around a hundred thousand arguments — and the very first thing a JPEG
 * stripper copies wholesale is the scan data, which for a 10MB photo is
 * essentially the whole file.
 */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function stripMetadata(kind: UploadKind, bytes: Uint8Array): StripResult {
  switch (kind) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
    case "image/heic":
      return stripHeic(bytes);
    case "application/pdf":
      // PDFs carry an author/producer dictionary rather than GPS. Rewriting
      // the xref table to remove it is a different and much larger job, and
      // the risk here is location data from a phone camera, which a PDF does
      // not have. Left as-is deliberately.
      return { ok: true, bytes };
  }
}

// ---------------------------------------------------------------- JPEG

/** APP1 holds EXIF and XMP; APP13 holds Photoshop IRB; COM is a free comment. */
const JPEG_DROP_MARKERS = new Set([0xe1, 0xed, 0xfe]);

/** No length field follows these. */
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function stripJpeg(bytes: Uint8Array): StripResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { ok: false, reason: "not a JPEG" };
  }

  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return { ok: false, reason: "malformed JPEG segment" };

    // Fill bytes: any number of 0xFF may pad before a marker.
    let markerAt = i;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt++;
    if (markerAt >= bytes.length) return { ok: false, reason: "truncated JPEG" };

    const marker = bytes[markerAt];

    if (marker === 0xd9) {
      // EOI. Copy it and anything trailing, verbatim.
      out.push(bytes.subarray(i));
      return { ok: true, bytes: concat(out) };
    }

    if (JPEG_STANDALONE.has(marker)) {
      out.push(bytes.subarray(i, markerAt + 1));
      i = markerAt + 1;
      continue;
    }

    const lengthAt = markerAt + 1;
    if (lengthAt + 1 >= bytes.length) return { ok: false, reason: "truncated JPEG" };
    // Big-endian, and includes its own two bytes.
    const length = (bytes[lengthAt] << 8) + bytes[lengthAt + 1];
    if (length < 2) return { ok: false, reason: "bad JPEG segment length" };

    const segmentEnd = lengthAt + length;
    if (segmentEnd > bytes.length) return { ok: false, reason: "truncated JPEG" };

    if (marker === 0xda) {
      // Start of scan: entropy-coded data runs to EOI and is not segmented,
      // so everything from here is copied without further parsing.
      out.push(bytes.subarray(markerAt - 1));
      return { ok: true, bytes: concat(out) };
    }

    if (!JPEG_DROP_MARKERS.has(marker)) {
      // APP0 (JFIF) and APP2 (ICC colour profile) are kept: neither carries
      // location, and dropping ICC would visibly shift the colours.
      out.push(Uint8Array.of(0xff, marker), bytes.subarray(lengthAt, segmentEnd));
    }

    i = segmentEnd;
  }

  return { ok: false, reason: "JPEG ended without a scan" };
}

// ----------------------------------------------------------------- PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** eXIf is the EXIF chunk; the text chunks routinely carry camera software strings. */
const PNG_DROP_CHUNKS = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

function stripPng(bytes: Uint8Array): StripResult {
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    return { ok: false, reason: "not a PNG" };
  }

  const out: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  let i = PNG_SIGNATURE.length;

  while (i + 8 <= bytes.length) {
    const length = readUint32(bytes, i);
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    // length + type + data + CRC
    const chunkEnd = i + 8 + length + 4;
    if (chunkEnd > bytes.length) return { ok: false, reason: "truncated PNG chunk" };

    // Whole chunks are removed, so no CRC anywhere needs recomputing.
    if (!PNG_DROP_CHUNKS.has(type)) {
      out.push(bytes.subarray(i, chunkEnd));
    }

    i = chunkEnd;
    if (type === "IEND") return { ok: true, bytes: concat(out) };
  }

  return { ok: false, reason: "PNG ended without IEND" };
}

// ---------------------------------------------------------------- WebP

function readUint32LE(bytes: Uint8Array, offset: number): number {
  if (bytes.length < offset + 4) return 0;
  return (
    bytes[offset] +
    (bytes[offset + 1] << 8) +
    (bytes[offset + 2] << 16) +
    ((bytes[offset + 3] << 24) >>> 0)
  );
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function stripWebp(bytes: Uint8Array): StripResult {
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") {
    return { ok: false, reason: "not a WebP" };
  }

  const out: Uint8Array[] = [bytes.subarray(0, 12)];
  let i = 12;

  while (i + 8 <= bytes.length) {
    const type = tag(i);
    const size = readUint32LE(bytes, i + 4);
    // Chunks are padded to an even length; the pad byte is not counted in size.
    const padded = size + (size % 2);
    const chunkEnd = i + 8 + padded;
    if (chunkEnd > bytes.length) return { ok: false, reason: "truncated WebP chunk" };

    if (type !== "EXIF" && type !== "XMP ") {
      if (type === "VP8X" && size >= 1) {
        // VP8X advertises which optional chunks follow. Removing EXIF/XMP
        // without clearing their flags leaves a file claiming metadata it no
        // longer has, which some decoders treat as corrupt. Copied first so
        // the caller's buffer is never modified.
        const chunk = Uint8Array.from(bytes.subarray(i, chunkEnd));
        chunk[8] = chunk[8] & ~0x08 & ~0x04; // EXIF, XMP
        out.push(chunk);
      } else {
        out.push(bytes.subarray(i, chunkEnd));
      }
    }

    i = chunkEnd;
  }

  // The loop condition stops 8 bytes early, so a truncated file simply ran
  // out mid-chunk rather than parsing cleanly. Without this, a WebP cut short
  // by an interrupted upload came back "ok" as a bare 12-byte RIFF header
  // containing no image at all — the emptiest possible way to fail closed
  // being skipped entirely.
  if (i !== bytes.length) {
    return { ok: false, reason: "truncated WebP chunk" };
  }
  if (out.length < 2) {
    return { ok: false, reason: "WebP has no chunks" };
  }

  const joined = concat(out);
  // The RIFF size counts everything after the size field itself.
  writeUint32LE(joined, 4, joined.length - 8);
  return { ok: true, bytes: joined };
}

// ---------------------------------------------------------------- HEIC

/**
 * HEIC is the awkward one, and worth explaining.
 *
 * There is no segment to drop: EXIF is an *item* whose bytes live in `mdat`,
 * located through the `meta` box's `iinf` (which item is the Exif one) and
 * `iloc` (where its bytes are). Rewriting the container to remove it would
 * mean rewriting every other item's offsets, which is exactly the kind of
 * surgery that produces a file that opens on your laptop and not on the
 * customer's phone.
 *
 * So the payload is ZEROED IN PLACE instead. The item stays in the index, its
 * bytes become nothing, every other offset in the file is untouched, and
 * decoders skip an unreadable Exif item without complaint.
 *
 * Two gates before writing: the located range has to be inside the file, and
 * the bytes there have to actually look like an Exif payload. If either fails
 * the file is rejected rather than stored — the alternative is either zeroing
 * image data or storing GPS.
 */
function stripHeic(bytes: Uint8Array): StripResult {
  const meta = findBox(bytes, 0, bytes.length, "meta");
  if (!meta) return { ok: false, reason: "no metadata box" };

  // meta is a FullBox: 4 bytes of version+flags before its children.
  const childStart = meta.contentStart + 4;
  const iinf = findBox(bytes, childStart, meta.end, "iinf");
  const iloc = findBox(bytes, childStart, meta.end, "iloc");
  if (!iinf || !iloc) {
    // No item index at all means no Exif item to find. Nothing to strip, and
    // nothing we failed to understand.
    return { ok: true, bytes };
  }

  const exifItemIds = exifItemIdsFrom(bytes, iinf.contentStart, iinf.end);
  if (!exifItemIds.size) return { ok: true, bytes };

  const extents = exifExtentsFrom(bytes, iloc.contentStart, iloc.end, exifItemIds);
  if (extents === null) {
    return { ok: false, reason: "could not read the HEIC item locations" };
  }
  if (!extents.length) return { ok: true, bytes };

  const out = Uint8Array.from(bytes);
  for (const { offset, length } of extents) {
    if (offset <= 0 || length <= 0 || offset + length > bytes.length) {
      return { ok: false, reason: "HEIC metadata sits outside the file" };
    }
    if (!looksLikeExifPayload(bytes, offset, length)) {
      // We found something, but not what we expected to find. Zeroing it
      // could be zeroing the picture.
      return { ok: false, reason: "unrecognised HEIC metadata layout" };
    }
    out.fill(0, offset, offset + length);
  }

  return { ok: true, bytes: out };
}

interface Box {
  type: string;
  /** First byte of the box's content, after size/type (and any largesize). */
  contentStart: number;
  /** One past the box's last byte. */
  end: number;
}

/** First child box of `type` between two offsets. Bounded and non-recursive. */
function findBox(
  bytes: Uint8Array,
  start: number,
  limit: number,
  type: string
): Box | null {
  let offset = start;
  // A malformed size of 0 would spin forever; the guard is the step check.
  while (offset + 8 <= limit) {
    const size = readUint32(bytes, offset);
    const boxType = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let contentStart = offset + 8;
    let boxEnd: number;

    if (size === 1) {
      // 64-bit largesize. Anything needing the high word is far larger than
      // our 10MB cap, so the high word is required to be zero.
      if (offset + 16 > limit) return null;
      if (readUint32(bytes, offset + 8) !== 0) return null;
      boxEnd = offset + readUint32(bytes, offset + 12);
      contentStart = offset + 16;
    } else if (size === 0) {
      boxEnd = limit;
    } else {
      boxEnd = offset + size;
    }

    if (boxEnd <= offset || boxEnd > limit) return null;
    if (boxType === type) return { type: boxType, contentStart, end: boxEnd };
    offset = boxEnd;
  }
  return null;
}

/** Item IDs whose item_type is 'Exif', read from the `iinf` entries. */
function exifItemIdsFrom(bytes: Uint8Array, start: number, limit: number): Set<number> {
  const ids = new Set<number>();
  if (start + 4 > limit) return ids;

  const version = bytes[start];
  // FullBox header, then a 16- or 32-bit entry count.
  let offset = start + 4 + (version === 0 ? 2 : 4);

  while (offset + 8 <= limit) {
    const size = readUint32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const end = size > 0 ? offset + size : limit;
    if (end <= offset || end > limit) break;

    if (type === "infe" && offset + 12 <= limit) {
      const infeVersion = bytes[offset + 8];
      const fieldsAt = offset + 12;
      // v2 uses a 16-bit item ID, v3 a 32-bit one. Earlier versions have no
      // item_type at all, so there is nothing to match.
      if (infeVersion === 2 && fieldsAt + 8 <= limit) {
        const itemId = (bytes[fieldsAt] << 8) + bytes[fieldsAt + 1];
        const itemType = String.fromCharCode(...bytes.subarray(fieldsAt + 4, fieldsAt + 8));
        if (itemType === "Exif") ids.add(itemId);
      } else if (infeVersion === 3 && fieldsAt + 10 <= limit) {
        const itemId = readUint32(bytes, fieldsAt);
        const itemType = String.fromCharCode(...bytes.subarray(fieldsAt + 6, fieldsAt + 10));
        if (itemType === "Exif") ids.add(itemId);
      }
    }

    offset = end;
  }

  return ids;
}

interface Extent {
  offset: number;
  length: number;
}

/**
 * Where the Exif items' bytes live, from `iloc`.
 *
 * Returns null when the box cannot be parsed — which the caller turns into a
 * rejection, not a pass.
 */
function exifExtentsFrom(
  bytes: Uint8Array,
  start: number,
  limit: number,
  wanted: Set<number>
): Extent[] | null {
  if (start + 8 > limit) return null;

  const version = bytes[start];
  let offset = start + 4;

  const offsetSize = bytes[offset] >> 4;
  const lengthSize = bytes[offset] & 0x0f;
  const baseOffsetSize = bytes[offset + 1] >> 4;
  const indexSize = version === 1 || version === 2 ? bytes[offset + 1] & 0x0f : 0;
  offset += 2;

  const readSized = (at: number, size: number): number | null => {
    if (size === 0) return 0;
    // 8-byte fields would exceed the safe integer range for no benefit: our
    // files are capped at 10MB.
    if (size !== 4 && size !== 8) return null;
    if (size === 8) {
      if (readUint32(bytes, at) !== 0) return null;
      return readUint32(bytes, at + 4);
    }
    return readUint32(bytes, at);
  };

  let itemCount: number;
  if (version < 2) {
    itemCount = (bytes[offset] << 8) + bytes[offset + 1];
    offset += 2;
  } else {
    itemCount = readUint32(bytes, offset);
    offset += 4;
  }
  // Sanity bound: a real HEIC has a handful of items, not thousands.
  if (itemCount < 0 || itemCount > 4096) return null;

  const extents: Extent[] = [];

  for (let item = 0; item < itemCount; item++) {
    if (offset + 2 > limit) return null;

    let itemId: number;
    if (version < 2) {
      itemId = (bytes[offset] << 8) + bytes[offset + 1];
      offset += 2;
    } else {
      itemId = readUint32(bytes, offset);
      offset += 4;
    }

    if (version === 1 || version === 2) {
      // reserved(12 bits) + construction_method(4 bits)
      if (offset + 2 > limit) return null;
      const constructionMethod = bytes[offset + 1] & 0x0f;
      offset += 2;
      // Only method 0 (file offset) is a plain range we can zero. Anything
      // else points into another item and is not ours to rewrite.
      if (constructionMethod !== 0 && wanted.has(itemId)) return null;
    }

    offset += 2; // data_reference_index
    const baseOffset = readSized(offset, baseOffsetSize);
    if (baseOffset === null) return null;
    offset += baseOffsetSize;

    if (offset + 2 > limit) return null;
    const extentCount = (bytes[offset] << 8) + bytes[offset + 1];
    offset += 2;
    if (extentCount > 1024) return null;

    for (let e = 0; e < extentCount; e++) {
      if ((version === 1 || version === 2) && indexSize > 0) offset += indexSize;

      const extentOffset = readSized(offset, offsetSize);
      if (extentOffset === null) return null;
      offset += offsetSize;

      const extentLength = readSized(offset, lengthSize);
      if (extentLength === null) return null;
      offset += lengthSize;

      if (offset > limit) return null;
      if (wanted.has(itemId)) {
        extents.push({ offset: baseOffset + extentOffset, length: extentLength });
      }
    }
  }

  return extents;
}

/**
 * Does this range actually hold an Exif payload?
 *
 * HEIF stores it as a 4-byte offset to the TIFF header, then usually the
 * "Exif\0\0" marker, then TIFF ("II*\0" little-endian or "MM\0*" big-endian).
 * Both shapes are accepted; anything else means we located the wrong bytes.
 */
function looksLikeExifPayload(bytes: Uint8Array, offset: number, length: number): boolean {
  if (length < 8) return false;

  // The marker has to be exactly where the format puts it, not merely
  // somewhere nearby. Scanning a window for "Exif" looked equivalent and was
  // not: an extent offset pointing a few bytes short of the real payload
  // still found the marker further down the window and was accepted, so a
  // misread location passed the very check meant to catch it.
  const marker = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (marker === "Exif") return true;

  // Some writers omit the marker and go straight to the TIFF header.
  //
  // Compared as BYTES rather than as a string. The magic is 49 49 2A 00 or
  // 4D 4D 00 2A, and writing those as string literals puts a real NUL in the
  // source file -- which survives round-trips badly and is invisible in a
  // diff, so the comparison silently becomes something nobody can read.
  const tiffAt = offset + readUint32(bytes, offset) + 4;
  if (tiffAt + 4 > offset + length) return false;

  const m = bytes.subarray(tiffAt, tiffAt + 4);
  const littleEndian = m[0] === 0x49 && m[1] === 0x49 && m[2] === 0x2a && m[3] === 0x00;
  const bigEndian = m[0] === 0x4d && m[1] === 0x4d && m[2] === 0x00 && m[3] === 0x2a;
  return littleEndian || bigEndian;
}
