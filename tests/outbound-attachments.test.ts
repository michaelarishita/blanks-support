import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The grant signer derives from this; set it before any signing runs.
process.env.TOKEN_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");

const src = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

import { buildRawEmail, type EmailFilePart } from "@/lib/email/mime";
import { renderEmailHtml } from "@/lib/email/template";
import { isReferencedByBody } from "@/lib/email/parse";
import {
  signUploadGrant,
  verifyUploadGrant,
  INTAKE_PREFIX,
  OUTBOUND_PREFIX,
} from "@/lib/uploads/grant";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

const base = {
  fromEmail: "me@blankssportsnutrition.com",
  to: "customer@example.com",
  subject: "Subject",
  bodyText: "body",
  bodyHtml: "<p>hello</p>",
  messageId: "<m@blankssportsnutrition.com>",
};

const png: EmailFilePart = {
  filename: "scoop.png",
  mimeType: "image/png",
  bytes: new Uint8Array([1, 2, 3, 4]),
  contentId: "blkatt-abc123@blankssportsnutrition.com",
};
const pdf: EmailFilePart = {
  filename: "label.pdf",
  mimeType: "application/pdf",
  bytes: new Uint8Array([5, 6, 7, 8]),
};

describe("outbound MIME nesting", () => {
  it("stays multipart/alternative with no attachments", () => {
    const m = decode(buildRawEmail(base));
    expect(m).toContain("Content-Type: multipart/alternative");
    expect(m).not.toContain("multipart/related");
    expect(m).not.toContain("multipart/mixed");
  });

  it("wraps inline images in multipart/related, referenced by Content-ID", () => {
    const m = decode(buildRawEmail({ ...base, inlineImages: [png] }));
    expect(m).toContain("multipart/related");
    expect(m).toContain("multipart/alternative"); // still inside
    expect(m).toContain(`Content-ID: <${png.contentId}>`);
    expect(m).toContain("Content-Disposition: inline");
  });

  it("wraps non-image files in multipart/mixed as attachments", () => {
    const m = decode(buildRawEmail({ ...base, attachments: [pdf] }));
    expect(m).toContain("multipart/mixed");
    expect(m).toContain('Content-Disposition: attachment; filename="label.pdf"');
  });

  it("nests mixed[ related[ alternative, inline ], attachment ] when both present", () => {
    const m = decode(buildRawEmail({ ...base, inlineImages: [png], attachments: [pdf] }));
    // Order in the serialized message reflects the nesting.
    expect(m.indexOf("multipart/mixed")).toBeLessThan(m.indexOf("multipart/related"));
    expect(m.indexOf("multipart/related")).toBeLessThan(m.indexOf("multipart/alternative"));
    expect(m).toContain(`Content-ID: <${png.contentId}>`);
    expect(m).toContain('filename="label.pdf"');
  });

  it("does not add a Content-ID to a downloadable attachment", () => {
    const m = decode(buildRawEmail({ ...base, attachments: [pdf] }));
    expect(m).not.toContain("Content-ID");
  });
});

describe("inline image HTML references its part", () => {
  it("embeds an <img src=cid:…> at the end of the body", () => {
    const html = renderEmailHtml({
      bodyHtml: "<p>Here is the scoop.</p>",
      agent: null,
      company: { company_name: "Blank's", logo_url: null, website: null } as never,
      inlineImages: [{ contentId: png.contentId!, filename: png.filename }],
    });
    expect(html).toContain(`src="cid:${png.contentId}"`);
    // After the reply text, before the (absent) signature/quote.
    expect(html.indexOf("Here is the scoop")).toBeLessThan(html.indexOf("cid:"));
  });
});

/**
 * The trap: a customer quotes our reply (which referenced our inline photo via
 * cid:) and attaches a NEW photo of their own. Our inbound parser must file the
 * customer's photo, not mistake it for one of our inline images and drop it.
 */
describe("our inline photos don't misfile a customer's when quoted back", () => {
  const ourQuotedHtml =
    `<p>Reply</p><img src="cid:blkatt-abc123@blankssportsnutrition.com" />` +
    `<blockquote>…their earlier message…</blockquote>`;

  it("keeps a customer photo whose Content-ID we never referenced", () => {
    // Their photo carries its own id; nothing in the HTML references it.
    expect(
      isReferencedByBody({ contentId: "customers-own-photo-42" }, ourQuotedHtml)
    ).toBe(false);
  });

  it("keeps a customer photo with no Content-ID at all", () => {
    expect(isReferencedByBody({ contentId: null }, ourQuotedHtml)).toBe(false);
  });

  it("would only mark OUR own re-quoted image inline (a harmless dedupe)", () => {
    // If a client did re-attach our image with our cid, matching it is fine —
    // it is a copy of what we already sent, not the customer's new photo.
    expect(
      isReferencedByBody(
        { contentId: "blkatt-abc123@blankssportsnutrition.com" },
        ourQuotedHtml
      )
    ).toBe(true);
  });
});

describe("composer wiring", () => {
  const box = src("../components/ReplyBox.tsx");

  it("blocks Send while an upload is in flight, failed, or over cap", () => {
    expect(box).toContain("uploads.blockingSend");
  });

  it("sends the grants and reused ids with the reply", () => {
    expect(box).toContain("grants: uploads.grants");
    expect(box).toContain("reuseIds");
  });

  it("only offers attaching on a reply, never an internal note", () => {
    // The attach controls sit behind a !isNote guard.
    expect(box).toContain("{!isNote && (");
  });

  it("uses the shared accept list and the reply upload endpoint", () => {
    expect(box).toContain("ACCEPT_ATTRIBUTE");
    expect(src("../components/useComposerAttachments.ts")).toContain(
      "/api/replies/upload-url"
    );
  });
});

describe("the outbound mint endpoint is authenticated", () => {
  const route = src("../app/api/replies/upload-url/route.ts");
  it("requires a signed-in user and mints under the outbound prefix", () => {
    expect(route).toContain("auth.getUser()");
    expect(route).toContain("status: 401");
    expect(route).toContain("OUTBOUND_PREFIX");
  });
});

describe("upload grant accepts the outbound temp prefix", () => {
  it("signs and verifies an outbound/ path", () => {
    const grant = signUploadGrant(`${OUTBOUND_PREFIX}uuid-1`, "photo.jpg");
    const result = verifyUploadGrant(grant);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(`${OUTBOUND_PREFIX}uuid-1`);
  });

  it("still verifies an intake/ path", () => {
    const grant = signUploadGrant(`${INTAKE_PREFIX}uuid-2`, "photo.jpg");
    expect(verifyUploadGrant(grant).ok).toBe(true);
  });

  it("refuses a path outside every temp prefix", () => {
    const grant = signUploadGrant("secret/uuid-3", "x.jpg");
    const result = verifyUploadGrant(grant);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});
