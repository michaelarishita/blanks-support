import { describe, expect, it } from "vitest";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  validateUploads,
} from "@/lib/uploads/validate";

const ascii = (text: string) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/** Smallest thing the sniffer will call a PDF. */
const pdf = (extra = "") => ascii(`%PDF-1.7\n${extra}`);

/** A JPEG with no metadata: SOI, a DQT, a scan, EOI. */
function jpeg(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x01,
    0xff, 0xda, 0x00, 0x04, 0x01, 0x00,
    0x11, 0x22, 0x33,
    0xff, 0xd9,
  ]);
}

const file = (name: string, bytes: Uint8Array) => ({ name, bytes });

/** A recognisable stand-in for the GPS tags a phone writes. */
const GPS = "GPSLatitude33.4484GPSLongitude-112.0740";

/** A JPEG carrying an APP1 EXIF segment with the marker above inside it. */
function jpegWithExif(): Uint8Array {
  const payload = ascii(`Exif\0\0II*\0${GPS}`);
  const length = payload.length + 2;
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...payload,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x01,
    0xff, 0xda, 0x00, 0x04, 0x01, 0x00,
    0x11, 0x22, 0x33,
    0xff, 0xd9,
  ]);
}

const contains = (bytes: Uint8Array, text: string) =>
  Buffer.from(bytes).toString("latin1").includes(text);

describe("validateUploads", () => {
  it("accepts a mixed batch", () => {
    const result = validateUploads([
      file("photo.jpg", jpeg()),
      file("receipt.pdf", pdf()),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(2);
    expect(result.files[0].kind).toBe("image/jpeg");
    expect(result.files[1].kind).toBe("application/pdf");
  });

  it("accepts nothing at all", () => {
    const result = validateUploads([]);
    expect(result.ok).toBe(true);
  });

  it("marks which files the thread can thumbnail", () => {
    const result = validateUploads([file("a.jpg", jpeg()), file("b.pdf", pdf())]);
    if (!result.ok) throw new Error(result.message);
    expect(result.files[0].isImage).toBe(true);
    expect(result.files[1].isImage).toBe(false);
  });

  it(`refuses more than ${MAX_FILES} files`, () => {
    const result = validateUploads(
      Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`p${i}.jpg`, jpeg()))
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/at most 3/);
  });

  it("refuses a file over the size cap", () => {
    const huge = new Uint8Array(MAX_FILE_BYTES + 1);
    huge.set(jpeg(), 0);
    const result = validateUploads([file("huge.jpg", huge)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/too large/);
  });

  it("refuses an empty file", () => {
    const result = validateUploads([file("nothing.jpg", new Uint8Array(0))]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/empty/);
  });

  /**
   * The whole reason the sniffer exists. Both the name and the browser's
   * Content-Type belong to whoever is uploading, so a ZIP called photo.jpg has
   * to be refused on its contents alone.
   */
  it("refuses a file whose name lies about its contents", () => {
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const result = validateUploads([file("photo.jpg", zip)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0].reason).toMatch(/allowlist/);
  });

  it.each([
    ["a GIF", ascii("GIF89a....")],
    ["an SVG", ascii("<svg xmlns='http://www.w3.org/2000/svg'/>")],
    ["an executable", Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
  ])("refuses %s", (_label, bytes) => {
    expect(validateUploads([file("x", bytes)]).ok).toBe(false);
  });

  /**
   * All-or-nothing. Accepting two of three photos leaves the customer thinking
   * all three arrived, and the gap only surfaces when an agent asks about a
   * picture that was never there.
   */
  it("rejects the whole batch when one file is bad", () => {
    const result = validateUploads([
      file("good.jpg", jpeg()),
      file("bad.gif", ascii("GIF89a")),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].name).toBe("bad.gif");
  });

  /**
   * The customer gets a sentence they can act on; the parser detail goes to
   * the log. Narrating "metadata: unrecognised HEIC layout" to a public caller
   * tells them exactly which code path they just reached.
   */
  it("does not leak the internal reason to the caller", () => {
    const result = validateUploads([file("x.gif", ascii("GIF89a"))]);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.message).not.toMatch(/allowlist|sniff|metadata|parse/i);
    expect(result.message).toMatch(/JPEG, PNG, WebP, HEIC or PDF/);
    // …while the detail is still available for the server log.
    expect(result.rejections[0].reason).toMatch(/allowlist/);
  });

  /**
   * The privacy promise, asserted THROUGH the function the endpoint calls.
   *
   * The strippers had thorough tests of their own and this still would have
   * passed with the strip call deleted from validateUploads: every fixture
   * here was metadata-free, so nothing noticed that the bytes came back
   * untouched. Testing the unit and testing that the unit is wired in are
   * different tests, and only the second one is what the customer relies on.
   */
  it("returns bytes with the EXIF removed, not the bytes it was given", () => {
    const original = jpegWithExif();
    expect(contains(original, GPS)).toBe(true);

    const result = validateUploads([file("IMG_0001.jpg", original)]);
    if (!result.ok) throw new Error(result.message);
    expect(contains(result.files[0].bytes, GPS)).toBe(false);
  });

  it("keeps the picture while dropping the metadata", () => {
    const result = validateUploads([file("IMG_0001.jpg", jpegWithExif())]);
    if (!result.ok) throw new Error(result.message);
    // The scan data — the actual image — has to survive the strip.
    expect(result.files[0].bytes).toContain(0x11);
    expect(result.files[0].kind).toBe("image/jpeg");
    expect(result.files[0].bytes.length).toBeLessThan(jpegWithExif().length);
  });

  it("refuses a file whose metadata it cannot parse", () => {
    // A JPEG that stops mid-segment: we cannot prove the EXIF is gone, so it
    // is refused rather than stored on the assumption that it probably is.
    const truncated = jpegWithExif().subarray(0, 10);
    const result = validateUploads([file("broken.jpg", truncated)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0].reason).toMatch(/^metadata:/);
  });

  it("renames to the sniffed extension, not the supplied one", () => {
    const result = validateUploads([file("actually-a-jpeg.png", jpeg())]);
    if (!result.ok) throw new Error(result.message);
    expect(result.files[0].filename).toBe("actually-a-jpeg.jpg");
  });

  it("strips path separators out of the stored name", () => {
    const result = validateUploads([file("../../../etc/passwd.jpg", jpeg())]);
    if (!result.ok) throw new Error(result.message);
    expect(result.files[0].filename).toBe("passwd.jpg");
    expect(result.files[0].filename).not.toContain("/");
  });
});
