import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inlineSrc, isViewable } from "@/components/AttachmentLightbox";
import type { Attachment } from "@/lib/types";

const attachment = (mime: string | null): Attachment => ({
  id: "att-1",
  message_id: "msg-1",
  filename: "photo",
  mime_type: mime,
  size_bytes: 1234,
  storage_path: "t/m/photo",
});

describe("isViewable", () => {
  it.each(["image/jpeg", "image/png", "image/webp"])("opens %s", (mime) => {
    expect(isViewable(attachment(mime))).toBe(true);
  });

  /**
   * HEIC is excluded on purpose. Chrome and Firefox cannot decode it, so
   * opening one would put a broken-image icon in a dark box — strictly worse
   * than the download chip, which at least does something. Safari could show
   * it, and a thread that behaves differently per browser is its own bug.
   */
  it("does not open HEIC", () => {
    expect(isViewable(attachment("image/heic"))).toBe(false);
  });

  it.each(["application/pdf", "text/plain", null])(
    "does not open %s",
    (mime) => {
      expect(isViewable(attachment(mime))).toBe(false);
    }
  );
});

describe("inlineSrc", () => {
  it("asks for the inline disposition", () => {
    // Without inline=1 the route sets Content-Disposition: attachment, and an
    // <img> pointing at it renders nothing while the browser offers a save.
    expect(inlineSrc("abc")).toBe("/api/attachments/abc?inline=1");
  });

  /**
   * Signed URLs live 60 seconds. A thread left open past that has thumbnails
   * pointing at dead links, so a retry has to mint a fresh signature — and a
   * plain reload of the same URL would be served the cached 302 to the expired
   * one. A different URL is the only thing that actually refetches.
   */
  it("busts the cache on retry", () => {
    expect(inlineSrc("abc", 1)).toBe("/api/attachments/abc?inline=1&r=1");
    expect(inlineSrc("abc", 1)).not.toBe(inlineSrc("abc"));
  });
});

/**
 * Structural, because these are the two behaviours that made attachments
 * annoying to look at, and both are easy to regress in a styling pass.
 */
describe("the thumbnail and the lightbox behave", () => {
  const attachments = readFileSync(
    fileURLToPath(new URL("../components/Attachments.tsx", import.meta.url)),
    "utf8"
  );
  const lightbox = readFileSync(
    fileURLToPath(new URL("../components/AttachmentLightbox.tsx", import.meta.url)),
    "utf8"
  );

  it("shows the whole photo rather than a centre crop", () => {
    expect(attachments).toContain("object-contain");
    expect(attachments).not.toContain("object-cover");
  });

  it("makes the thumbnail open the viewer instead of downloading", () => {
    expect(attachments).toContain("lightbox.open(attachment.id)");
  });

  it("keeps download available, as a button inside the lightbox", () => {
    expect(lightbox).toContain("Download");
    expect(lightbox).toContain("`/api/attachments/${image.id}`");
  });

  it("closes on Escape and navigates with the arrow keys", () => {
    expect(lightbox).toContain('event.key === "Escape"');
    expect(lightbox).toContain('event.key === "ArrowRight"');
    expect(lightbox).toContain('event.key === "ArrowLeft"');
  });

  it("leaves pinch-zoom to the browser", () => {
    expect(lightbox).toContain("pinch-zoom");
  });

  it("retries an expired signature exactly once", () => {
    // Once, because a genuinely missing object must not become an infinite
    // reload loop against our own API.
    expect(lightbox).toContain("if (retry === 0)");
  });
});
