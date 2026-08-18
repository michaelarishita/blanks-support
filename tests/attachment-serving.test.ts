import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INLINE_SAFE_TYPES, isInlineSafe, storageContentType } from "@/lib/attachments";

/**
 * Email deliberately accepts any file type — a wholesale CSV or a signed PDF
 * is a legitimate thing for a customer to send. That openness is only safe
 * because of how the files are SERVED, which makes this the guard that pays
 * for it.
 */
describe("isInlineSafe", () => {
  it.each(["image/jpeg", "image/png", "image/webp"])("renders %s inline", (type) => {
    expect(isInlineSafe(type)).toBe(true);
  });

  /**
   * The vector: an SVG is an XML document that can carry <script>, and an
   * HTML attachment is obvious. Served inline from a signed storage URL,
   * either one executes in the storage origin against whichever agent opened
   * the ticket — and an .svg looks like an image to everyone until it runs.
   */
  it.each([
    ["image/svg+xml", "an XML document that can carry <script>"],
    ["text/html", "obviously executable"],
    ["application/xhtml+xml", "same as HTML"],
    ["application/pdf", "PDF viewers execute JavaScript"],
    ["text/csv", "not renderable, and not ours to render"],
    ["application/octet-stream", "unidentified"],
  ])("never renders %s inline (%s)", (type) => {
    expect(isInlineSafe(type)).toBe(false);
  });

  it("refuses a missing or empty type", () => {
    expect(isInlineSafe(null)).toBe(false);
    expect(isInlineSafe(undefined)).toBe(false);
    expect(isInlineSafe("")).toBe(false);
  });

  it("is case-insensitive, since the header is not normalised anywhere", () => {
    expect(isInlineSafe("IMAGE/JPEG")).toBe(true);
  });

  it("keeps the allowlist to raster images only", () => {
    // A growing allowlist is how this protection erodes. Anything added here
    // has to be something a browser renders WITHOUT executing.
    expect([...INLINE_SAFE_TYPES].every((t) => t.startsWith("image/"))).toBe(true);
    expect(INLINE_SAFE_TYPES.has("image/svg+xml")).toBe(false);
  });
});

describe("storageContentType", () => {
  it("keeps a type we identified by its bytes", () => {
    expect(storageContentType("image/jpeg")).toBe("image/jpeg");
  });

  it("stores anything unidentified as octet-stream", () => {
    // Defence in depth: even a signed URL fetched directly has nothing to
    // render, whatever the sender labelled the file.
    expect(storageContentType(null)).toBe("application/octet-stream");
  });
});

describe("the route decides, not the caller", () => {
  const route = readFileSync(
    fileURLToPath(new URL("../app/api/attachments/[id]/route.ts", import.meta.url)),
    "utf8"
  );

  it("checks the stored type before honouring ?inline=1", () => {
    expect(route).toContain("isInlineSafe(attachment.mime_type)");
    // The query param alone must never reach the signing call.
    expect(route).toMatch(/const inline = inlineRequested && isInlineSafe/);
  });

  it("reads the mime type it is about to judge", () => {
    expect(route).toContain('select("storage_path, filename, mime_type")');
  });

  it("still sets a download disposition on everything else", () => {
    expect(route).toContain("{ download: attachment.filename }");
  });

  it("shares one allowlist with the thread UI", () => {
    const lightbox = readFileSync(
      fileURLToPath(new URL("../components/AttachmentLightbox.tsx", import.meta.url)),
      "utf8"
    );
    // Two copies could only drift into promising something the server refuses.
    expect(lightbox).toContain("isInlineSafe");
    expect(lightbox).not.toContain('new Set(["image/jpeg"');
  });
});
