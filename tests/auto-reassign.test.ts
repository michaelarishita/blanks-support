import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { replyAssignment } from "@/lib/assignment";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const actions = read("../app/actions.ts");
const replyBox = read("../components/ReplyBox.tsx");
const send = read("../lib/notifications/send.ts");

/** The pure rule the reassign path is built on. */
describe("replyAssignment", () => {
  it("claims an unowned ticket", () => {
    expect(replyAssignment(null, "me")).toBe("claim");
    expect(replyAssignment(undefined, "me")).toBe("claim");
  });

  it("leaves your own ticket alone", () => {
    expect(replyAssignment("me", "me")).toBe("keep");
  });

  it("takes over someone else's", () => {
    expect(replyAssignment("harvey", "me")).toBe("reassign");
  });
});

/**
 * The reassign path lives entirely inside the public-reply branch, and its
 * write is guarded so a concurrent human wins. Structural, because the shape —
 * "an internal note never moves ownership" — is what matters and cannot be
 * observed by calling a function that happens to work.
 */
describe("only a public reply reassigns", () => {
  const region = actions.slice(
    actions.indexOf("let claimed = false;"),
    actions.indexOf("let resolved = false;")
  );

  it("runs the whole decision under !isNote", () => {
    expect(region).toContain("if (!isNote) {");
    expect(region).toContain("replyAssignment(previousAssignee, userId)");
  });

  it("reassigns only in the 'someone else' case", () => {
    expect(region).toContain('action === "reassign"');
  });

  it("guards the write on the owner it read, so a live claim wins", () => {
    expect(region).toContain('.eq("assignee_id", previousAssignee)');
  });

  it("records the reason so 'why is this mine' is answerable", () => {
    expect(region).toMatch(/logEvent\(supabase, ticketId, userId, "reassigned"/);
    expect(region).toContain("replied to a ticket assigned to someone else");
  });

  it("tells the previous owner it left their queue", () => {
    expect(region).toContain("sendReassignmentNotification(");
  });
});

describe("the undo is independent of the resolve undo", () => {
  const fn = actions.slice(
    actions.indexOf("export async function reassignBack"),
    actions.indexOf("export async function retryDelivery")
  );

  it("hands the ticket back to the previous owner", () => {
    expect(fn).toContain(".update({ assignee_id: previousAssigneeId })");
  });

  it("reverts only while the replier still holds it", () => {
    // If someone else claimed it, or the customer replied and it moved, an
    // unconditional write would stamp over a state that had moved on.
    expect(fn).toContain('.eq("assignee_id", userId)');
  });

  it("records the undo", () => {
    expect(fn).toMatch(/logEvent\(supabase, ticketId, userId, "reassigned"/);
  });
});

describe("the send toast carries both facts, each with its own undo", () => {
  it("offers a reassign undo that does not touch the resolve", () => {
    // The two undos call different actions on different columns.
    expect(replyBox).toContain("keepTicketOpen(ticketId)");
    expect(replyBox).toContain("reassignBack(ticketId, prevId)");
  });

  const block = replyBox.slice(
    replyBox.indexOf("if (res?.reassignedFromId)"),
    replyBox.length
  );

  it("names who it came from", () => {
    expect(block).toContain("Reassigned to you from");
  });

  it("gives the decision the same 12 seconds as Keep open", () => {
    expect(block).toContain("duration: 12000");
    expect(block).toContain('label: "Undo"');
  });
});

describe("the previous-owner notice", () => {
  const fn = send.slice(
    send.indexOf("export async function sendReassignmentNotification"),
    send.indexOf("export interface NewTicketResult")
  );

  it("uses its own variant so the copy is not 'now yours'", () => {
    expect(fn).toContain('variant: "reassigned_away"');
  });

  it("threads into the previous owner's existing conversation", () => {
    expect(fn).toContain("threadRoot(previousAssigneeId, ticketId)");
  });

  it("sends immediately rather than deferring through the assignment cron", () => {
    // Deferring would park a scheduled row the cron re-sends as a plain
    // assignment — the wrong copy to the wrong person.
    expect(fn).not.toContain("decideSendTime");
  });

  it("records a stamped row so the cron never re-sends it", () => {
    expect(fn).toContain('kind: "assignment"');
    expect(fn).toContain("sent_at: new Date().toISOString()");
  });
});
