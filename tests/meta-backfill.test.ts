import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { conversationsToEvents } from "@/lib/meta/backfill";

const PAGE = "PAGE_ID";

describe("conversationsToEvents — the pure core of the inbox backfill", () => {
  it("imports a customer's message as an inbound messenger event", () => {
    const events = conversationsToEvents(
      [
        {
          id: "c1",
          messages: {
            data: [
              {
                id: "m_wes",
                created_time: "2026-09-01T10:00:00+0000",
                from: { id: "PSID_WES", name: "Wes Salonen" },
                message: "Hello. I love Blank's!!!!",
              },
            ],
          },
        },
      ],
      PAGE
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "message",
      channel: "messenger",
      mid: "m_wes",
      customerId: "PSID_WES",
      pageId: PAGE,
      text: "Hello. I love Blank's!!!!",
      isStoryReply: false,
    });
    expect(events[0].timestamp).toBe(Date.parse("2026-09-01T10:00:00+0000"));
  });

  it("skips OUR OWN replies (from === pageId) — a gap in the thread, not a lost message", () => {
    const events = conversationsToEvents(
      [
        {
          id: "c1",
          messages: {
            data: [
              { id: "m_them", from: { id: "PSID" }, message: "hi" },
              { id: "m_us", from: { id: PAGE }, message: "our reply" },
            ],
          },
        },
      ],
      PAGE
    );
    expect(events.map((e) => e.mid)).toEqual(["m_them"]);
  });

  it("drops messages with no id (can't dedupe → won't risk a double-import)", () => {
    const events = conversationsToEvents(
      [{ id: "c1", messages: { data: [{ from: { id: "PSID" }, message: "x" }] } }],
      PAGE
    );
    expect(events).toHaveLength(0);
  });

  it("routes every event through the same ingest, so re-runs dedupe", () => {
    // Structural: the backfill must not invent a second store path — it calls
    // processMetaEvents, whose meta_message_id unique index makes it idempotent.
    const src = readFileSync(
      fileURLToPath(new URL("../lib/meta/backfill.ts", import.meta.url)),
      "utf8"
    );
    expect(src).toContain("processMetaEvents(");
  });
});

describe("the channel-filtered empty state names the channel", () => {
  const list = readFileSync(
    fileURLToPath(new URL("../components/TicketList.tsx", import.meta.url)),
    "utf8"
  );
  it("uses the channel label instead of the generic widget/email line", () => {
    expect(list).toContain("No ${channelLabel} tickets here");
    expect(list).toContain("channelLabel");
  });
});
