import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const widget = read("../components/WidgetForm.tsx");
const intake = read("../app/api/tickets/intake/route.ts");
const mint = read("../app/api/tickets/intake/upload-url/route.ts");
const claim = read("../lib/uploads/claim.ts");
const sweep = read("../lib/uploads/sweep.ts");

/**
 * A customer attached a photo, the ticket arrived without it, and they were
 * told it worked.
 *
 * The upload failed in the browser; the widget filtered the file out of the
 * payload; the server never learned it was meant to exist. Nothing rejected
 * it, nothing logged it, and nothing could count it — the only record was a
 * console.error in the customer's own browser.
 */
describe("a failed upload is never dropped silently", () => {
  it("retries before telling the customer anything", () => {
    // The likeliest cause is a moment of bad mobile data, and most of those
    // clear on the next attempt. Asking somebody to intervene in a problem
    // that would have fixed itself is how a form starts feeling broken.
    expect(widget).toContain("const UPLOAD_RETRIES = 2");
    expect(widget).toMatch(/for \(let attempt = 0; attempt <= UPLOAD_RETRIES/);
    expect(widget).toContain("UPLOAD_BACKOFF_MS * (attempt + 1)");
  });

  it("blocks submit while a file is unresolved", () => {
    // THE fix. readyGrants has always filtered to "done", so a failed upload
    // was simply absent from the payload.
    expect(widget).toMatch(
      /const unresolved = attachments\.some\(\(a\) => a\.status === "failed"\)/
    );
    expect(widget).toContain('disabled={state === "sending" || uploading || unresolved}');
    expect(widget).toContain("if (uploading || unresolved) return;");
  });

  it("does NOT block the form outright — removal re-enables it", () => {
    // Somebody on a bad connection who cannot file a ticket at all is worse
    // off than somebody whose photo went missing. The choice stays theirs; it
    // just has to be made on purpose.
    expect(widget).toContain("Try again");
    expect(widget).toContain("retryUpload");
    expect(widget).toMatch(/remove it to send without it/i);
  });

  it("tells the agent when a photo was abandoned", () => {
    // An agent answering "the tub arrived smashed" needs to know a picture of
    // it was meant to be here.
    expect(widget).toContain("setAbandoned");
    expect(widget).toMatch(/could not be uploaded from the customer's device/);
  });

  it("counts only files removed BECAUSE they failed", () => {
    // Removing one they simply changed their mind about is not a lost photo,
    // and must not put a misleading line in the ticket.
    expect(widget).toMatch(
      /if \(current\.find\(\(a\) => a\.id === id\)\?\.status === "failed"\)/
    );
  });
});

describe("the ledger, so the rate is measurable at all", () => {
  it("records a grant before the URL is handed out", () => {
    // A grant must never exist without a row, or the ledger has the same hole
    // it was built to close.
    expect(mint).toMatch(/await recordGrantIssued\([\s\S]{0,200}\}\);\s*\n\s*uploads\.push/);
  });

  it("records the case the whole thing exists for", () => {
    // Invited an upload, the bytes never arrived. Previously left no trace.
    expect(claim).toContain('resolveGrant(verified.path, "missing"');
  });

  it("records a rejection separately from a disappearance", () => {
    // A file we HAD and refused is a different fact from one that never
    // arrived, and the difference is the point of counting.
    expect(claim).toContain('"rejected"');
  });

  it("closes the ledger when the sweep expires a grant", () => {
    // Otherwise an unclaimed grant is "unresolved" forever and reconciliation
    // cannot tell "still typing" from "abandoned a week ago".
    expect(sweep).toContain('resolveGrant(path, "expired"');
  });
});

describe("storeAttachments — the same bug one door down", () => {
  it("reports what it lost instead of only logging it", () => {
    expect(intake).toMatch(/Promise<\{ stored: number; failed: string\[\] \}>/);
    expect(intake).toContain("failed.push(file.filename)");
  });

  it("says so in the ticket, not just in a log", () => {
    // A log line nobody reads is indistinguishable from silence.
    expect(intake).toMatch(/could not be saved — a fault on our side/);
  });

  it("cleans up an object whose row failed", () => {
    // The folder sweep only collects folders whose TICKET is gone. This
    // ticket exists, so nothing would ever have tidied this up.
    expect(intake).toMatch(/rowError[\s\S]{0,320}storage\s*\n?\s*\.from\("attachments"\)\s*\n?\s*\.remove/);
  });

  it("still does not fail the request", () => {
    // The customer's message is saved; losing the whole ticket because one
    // photo did not upload is the worse outcome.
    expect(intake).toContain("ok: true, ticket_number: ticket.number");
  });
});
