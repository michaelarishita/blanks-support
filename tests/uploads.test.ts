import { describe, expect, it } from "vitest";
import { safeStoredName, sniffFileType } from "@/lib/uploads/sniff";
import { stripMetadata } from "@/lib/uploads/strip";

/**
 * The upload path is the most abusable surface in the product: an
 * unauthenticated endpoint that accepts bytes and stores them. Two properties
 * matter enough to build fixtures by hand for.
 *
 *  1. The TYPE comes from the content. A caller who picks both the file and
 *     the Content-Type header can otherwise nominate which allowlist entry
 *     they match, which is the same as having no allowlist.
 *  2. EXIF really leaves. A customer photographing a damaged tub at home is
 *     photographing it at their address, and the phone writes that in as GPS.
 */

// ---------------------------------------------------------------- helpers

const bytes = (...values: number[]) => Uint8Array.from(values);

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32be(value: number): Uint8Array {
  return bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32le(value: number): Uint8Array {
  return bytes(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function u16be(value: number): Uint8Array {
  return bytes((value >>> 8) & 0xff, value & 0xff);
}

/** A recognisable run of "GPS data" — if it survives, the test can say so. */
const SECRET = ascii("GPSLatitude33.4484GPSLongitude-112.0740");

// ------------------------------------------------------------------ JPEG

/** APP1 carries EXIF. Length is big-endian and counts its own two bytes. */
function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  return concat([bytes(0xff, marker), u16be(payload.length + 2), payload]);
}

function makeJpeg({ withExif = true } = {}): Uint8Array {
  const parts: Uint8Array[] = [bytes(0xff, 0xd8)];
  // APP0/JFIF — kept by the stripper.
  parts.push(jpegSegment(0xe0, concat([ascii("JFIF"), bytes(0), bytes(1, 1, 0, 0, 1, 0, 1, 0, 0)])));
  if (withExif) {
    parts.push(jpegSegment(0xe1, concat([ascii("Exif"), bytes(0, 0), ascii("II"), bytes(0x2a, 0), SECRET])));
    // A comment segment, also dropped.
    parts.push(jpegSegment(0xfe, ascii("shot on a phone")));
  }
  // APP2/ICC — kept, because dropping it shifts the colours.
  parts.push(jpegSegment(0xe2, concat([ascii("ICC_PROFILE"), bytes(0, 1, 1), ascii("profile")])));
  parts.push(jpegSegment(0xdb, bytes(0, ...new Array(64).fill(16)))); // DQT
  parts.push(jpegSegment(0xda, bytes(1, 1, 0, 0, 63, 0))); // SOS header
  parts.push(ascii("SCANDATA-SCANDATA")); // entropy-coded data
  parts.push(bytes(0xff, 0xd9)); // EOI
  return concat(parts);
}

// ------------------------------------------------------------------- PNG

const PNG_SIG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  // CRC is not recomputed anywhere — whole chunks are removed, never edited —
  // so a placeholder is honest here.
  return concat([u32be(data.length), ascii(type), data, u32be(0)]);
}

function makePng({ withExif = true } = {}): Uint8Array {
  const parts = [PNG_SIG, pngChunk("IHDR", concat([u32be(1), u32be(1), bytes(8, 2, 0, 0, 0)]))];
  if (withExif) {
    parts.push(pngChunk("eXIf", concat([ascii("II"), bytes(0x2a, 0), SECRET])));
    parts.push(pngChunk("tEXt", ascii("Software\0a phone")));
  }
  parts.push(pngChunk("IDAT", ascii("PIXELS")));
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

// ------------------------------------------------------------------ WebP

function webpChunk(type: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? bytes(0) : new Uint8Array(0);
  return concat([ascii(type), u32le(data.length), data, pad]);
}

function makeWebp({ withExif = true } = {}): Uint8Array {
  const chunks: Uint8Array[] = [
    // VP8X flags byte with the EXIF (0x08) and XMP (0x04) bits set.
    webpChunk("VP8X", concat([bytes(0x0c, 0, 0, 0), bytes(0, 0, 0), bytes(0, 0, 0)])),
    webpChunk("VP8 ", ascii("PIXELS")),
  ];
  if (withExif) {
    chunks.push(webpChunk("EXIF", concat([ascii("II"), bytes(0x2a, 0), SECRET])));
    chunks.push(webpChunk("XMP ", ascii("<x:xmpmeta/>")));
  }
  const body = concat([ascii("WEBP"), ...chunks]);
  return concat([ascii("RIFF"), u32le(body.length), body]);
}

// ------------------------------------------------------------------ HEIC

function isoBox(type: string, payload: Uint8Array): Uint8Array {
  return concat([u32be(payload.length + 8), ascii(type), payload]);
}

function isoFullBox(type: string, version: number, payload: Uint8Array): Uint8Array {
  return isoBox(type, concat([bytes(version, 0, 0, 0), payload]));
}

const OFFSET_PLACEHOLDER = 0xffffffff;

/**
 * A minimal but structurally real HEIC: ftyp + meta(iinf, iloc) + mdat, where
 * iloc points at an Exif payload sitting inside mdat.
 *
 * The extent offset is absolute, so it can only be known once the boxes before
 * mdat are sized — hence the placeholder patched in afterwards.
 */
function makeHeic({ brand = "heic", exifLength = -1 } = {}): Uint8Array {
  const exifPayload = concat([
    u32be(6), // offset from here to the TIFF header
    ascii("Exif"),
    bytes(0, 0),
    ascii("II"),
    bytes(0x2a, 0),
    SECRET,
  ]);

  const infe = isoFullBox("infe", 2, concat([u16be(1), u16be(0), ascii("Exif")]));
  const iinf = isoFullBox("iinf", 0, concat([u16be(1), infe]));

  const iloc = isoFullBox(
    "iloc",
    0,
    concat([
      bytes(0x44, 0x00), // offset_size 4, length_size 4, base_offset_size 0
      u16be(1), // item_count
      u16be(1), // item_ID
      u16be(0), // data_reference_index
      u16be(1), // extent_count
      u32be(OFFSET_PLACEHOLDER),
      u32be(exifLength >= 0 ? exifLength : exifPayload.length),
    ])
  );

  const ftyp = isoBox("ftyp", concat([ascii(brand), u32be(0), ascii("heic")]));
  const meta = isoFullBox("meta", 0, concat([iinf, iloc]));
  const mdat = isoBox("mdat", concat([ascii("PIXELS"), exifPayload]));

  const file = concat([ftyp, meta, mdat]);

  // Patch the placeholder with the payload's real absolute offset.
  const exifAt = ftyp.length + meta.length + 8 + ascii("PIXELS").length;
  const marker = u32be(OFFSET_PLACEHOLDER);
  for (let i = 0; i + 4 <= file.length; i++) {
    if (marker.every((byte, k) => file[i + k] === byte)) {
      file.set(u32be(exifAt), i);
      break;
    }
  }
  return file;
}

/** Does the buffer still contain the marker we planted? */
function containsSecret(buffer: Uint8Array): boolean {
  const text = Buffer.from(buffer).toString("latin1");
  return text.includes(Buffer.from(SECRET).toString("latin1"));
}

// ------------------------------------------------------------------ tests

describe("sniffFileType", () => {
  it.each([
    ["JPEG", () => makeJpeg(), "image/jpeg", "jpg", true],
    ["PNG", () => makePng(), "image/png", "png", true],
    ["WebP", () => makeWebp(), "image/webp", "webp", true],
    ["HEIC", () => makeHeic(), "image/heic", "heic", true],
    ["PDF", () => ascii("%PDF-1.7\nbody"), "application/pdf", "pdf", false],
  ])("identifies %s", (_label, make, kind, extension, isImage) => {
    const result = sniffFileType((make as () => Uint8Array)());
    expect(result?.kind).toBe(kind);
    expect(result?.extension).toBe(extension);
    expect(result?.isImage).toBe(isImage);
  });

  it.each([
    ["GIF", () => ascii("GIF89a")],
    ["ZIP", () => bytes(0x50, 0x4b, 0x03, 0x04)],
    ["a Windows executable", () => bytes(0x4d, 0x5a, 0x90, 0x00)],
    ["an SVG", () => ascii("<svg xmlns='http://www.w3.org/2000/svg'>")],
    ["plain text", () => ascii("just a note")],
    ["nothing at all", () => new Uint8Array(0)],
  ])("rejects %s", (_label, make) => {
    expect(sniffFileType(make())).toBeNull();
  });

  /**
   * The attack the sniffer exists for: a ZIP named photo.jpg, sent with
   * Content-Type: image/jpeg. Both of those are the uploader's to choose, and
   * neither is consulted.
   */
  it("is not fooled by a name or a declared type", () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
    expect(sniffFileType(zip)).toBeNull();
  });

  it("does not accept a PDF hiding behind leading junk", () => {
    expect(sniffFileType(concat([ascii("GIF89a"), ascii("%PDF-1.7")]))).toBeNull();
  });

  // mif1 is shared with AVIF, which is not on the allowlist, so it only
  // counts as HEIC when a real HEIF brand appears alongside it.
  it("accepts mif1 only when a HEIF brand is also declared", () => {
    expect(sniffFileType(makeHeic({ brand: "mif1" }))?.kind).toBe("image/heic");

    const avif = isoBox("ftyp", concat([ascii("mif1"), u32be(0), ascii("avif")]));
    expect(sniffFileType(avif)).toBeNull();
  });
});

describe("safeStoredName", () => {
  it("replaces the caller's extension with the sniffed one", () => {
    expect(safeStoredName("photo.png", "jpg")).toBe("photo.jpg");
  });

  it("strips path separators", () => {
    expect(safeStoredName("../../etc/passwd", "pdf")).toBe("passwd.pdf");
  });

  it("strips characters that could confuse a storage path", () => {
    expect(safeStoredName("in/voice #7?.pdf", "pdf")).toBe("voice _7_.pdf");
  });

  it("falls back when nothing usable is left", () => {
    expect(safeStoredName("...", "jpg")).toMatch(/\.jpg$/);
  });
});

describe("stripMetadata removes EXIF", () => {
  it.each([
    ["JPEG", "image/jpeg" as const, makeJpeg],
    ["PNG", "image/png" as const, makePng],
    ["WebP", "image/webp" as const, makeWebp],
    ["HEIC", "image/heic" as const, makeHeic],
  ])("%s: the GPS marker is gone afterwards", (_label, kind, make) => {
    const original = make();
    // The fixture has to actually contain it, or the assertion below proves
    // nothing at all.
    expect(containsSecret(original)).toBe(true);

    const result = stripMetadata(kind, original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(containsSecret(result.bytes)).toBe(false);
  });

  it("leaves the image data alone", () => {
    const result = stripMetadata("image/jpeg", makeJpeg());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = Buffer.from(result.bytes).toString("latin1");
    expect(text).toContain("SCANDATA-SCANDATA");
    // APP0/JFIF and APP2/ICC survive: neither carries location, and losing
    // the colour profile would visibly change the picture.
    expect(text).toContain("JFIF");
    expect(text).toContain("ICC_PROFILE");
  });

  it("keeps a JPEG a JPEG", () => {
    const result = stripMetadata("image/jpeg", makeJpeg());
    if (!result.ok) throw new Error(result.reason);
    expect(sniffFileType(result.bytes)?.kind).toBe("image/jpeg");
    expect(result.bytes.length).toBeLessThan(makeJpeg().length);
  });

  it("keeps a PNG a PNG, ending at IEND", () => {
    const result = stripMetadata("image/png", makePng());
    if (!result.ok) throw new Error(result.reason);
    expect(sniffFileType(result.bytes)?.kind).toBe("image/png");
    expect(Buffer.from(result.bytes).toString("latin1")).toContain("IDAT");
    expect(Buffer.from(result.bytes).toString("latin1")).toContain("IEND");
  });

  it("keeps a WebP a WebP, and fixes the RIFF size", () => {
    const result = stripMetadata("image/webp", makeWebp());
    if (!result.ok) throw new Error(result.reason);
    expect(sniffFileType(result.bytes)?.kind).toBe("image/webp");

    const declared =
      result.bytes[4] +
      (result.bytes[5] << 8) +
      (result.bytes[6] << 16) +
      (result.bytes[7] << 24);
    // A stale size here is the classic WebP-editing bug: decoders read past
    // the end or truncate the image.
    expect(declared).toBe(result.bytes.length - 8);
  });

  it("clears the WebP flags that claim metadata it no longer has", () => {
    const result = stripMetadata("image/webp", makeWebp());
    if (!result.ok) throw new Error(result.reason);
    const flags = result.bytes[12 + 8]; // VP8X payload byte 0
    expect(flags & 0x08).toBe(0); // EXIF
    expect(flags & 0x04).toBe(0); // XMP
  });

  it("leaves an image with no metadata byte-identical", () => {
    const clean = makePng({ withExif: false });
    const result = stripMetadata("image/png", clean);
    if (!result.ok) throw new Error(result.reason);
    expect(Array.from(result.bytes)).toEqual(Array.from(clean));
  });

  it("does not mutate the caller's buffer", () => {
    const original = makeHeic();
    const copy = Uint8Array.from(original);
    stripMetadata("image/heic", original);
    expect(Array.from(original)).toEqual(Array.from(copy));
  });

  // PDFs carry an author/producer dictionary rather than camera GPS, and
  // rewriting an xref table is a different job. Passed through knowingly.
  it("passes a PDF through untouched", () => {
    const pdf = ascii("%PDF-1.7\n/Producer (Acrobat)\n");
    const result = stripMetadata("application/pdf", pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.bytes)).toEqual(Array.from(pdf));
  });
});

/**
 * Fail closed. Every one of these is a file we do not fully understand, and
 * the right answer is to refuse it rather than to store something that might
 * still carry location data.
 */
describe("stripMetadata rejects what it cannot parse", () => {
  it.each([
    ["a truncated JPEG", "image/jpeg" as const, () => makeJpeg().subarray(0, 12)],
    ["a JPEG with no scan", "image/jpeg" as const, () => bytes(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 1, 2, 3, 4, 5, 6)],
    ["a truncated PNG chunk", "image/png" as const, () => makePng().subarray(0, 20)],
    ["a PNG with no IEND", "image/png" as const, () => concat([PNG_SIG, pngChunk("IDAT", ascii("x"))])],
    ["a truncated WebP chunk", "image/webp" as const, () => makeWebp().subarray(0, 18)],
  ])("refuses %s", (_label, kind, make) => {
    const result = stripMetadata(kind, make());
    expect(result.ok).toBe(false);
  });

  it("refuses a HEIC whose Exif item points outside the file", () => {
    const heic = makeHeic({ exifLength: 999_999 });
    const result = stripMetadata("image/heic", heic);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/outside the file/);
  });

  it("refuses a HEIC whose Exif item does not hold Exif", () => {
    // Point the extent at the pixel bytes instead. Zeroing that range would
    // be zeroing the picture, so the file is rejected rather than guessed at.
    const heic = makeHeic();
    const at = Buffer.from(heic).toString("latin1").indexOf("PIXELS");
    const ilocAt = Buffer.from(heic).toString("latin1").indexOf("iloc");
    // The extent offset is the 4 bytes before the extent length, 8 back from
    // the end of the iloc box's payload.
    heic.set(u32be(at), ilocAt + 4 + 4 + 2 + 2 + 2 + 2 + 2);
    const result = stripMetadata("image/heic", heic);
    expect(result.ok).toBe(false);
  });

  it("accepts a HEIC with no Exif item at all", () => {
    const ftyp = isoBox("ftyp", concat([ascii("heic"), u32be(0), ascii("heic")]));
    const meta = isoFullBox("meta", 0, new Uint8Array(0));
    const mdat = isoBox("mdat", ascii("PIXELS"));
    const result = stripMetadata("image/heic", concat([ftyp, meta, mdat]));
    expect(result.ok).toBe(true);
  });
});
