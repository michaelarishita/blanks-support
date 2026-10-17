import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Instagram health panel (Prompt: Instagram is next) and the Messenger
 * copy fix. Structural, over the source — these are properties of what the
 * panels render and how the Settings page wires them, which a test that
 * rendered one panel in isolation could not prove about the pair.
 */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("Messenger panel: the copy is right once the Page IS subscribed", () => {
  const src = read("../components/MessengerStatus.tsx");

  it('stops saying "normal until subscribed" when the subscription is ok', () => {
    expect(src).toContain('health.subscription.state === "ok"');
    expect(src).toContain("waiting for the first message");
    // The old copy is kept only as the genuinely-not-subscribed-yet case.
    expect(src).toContain("normal until the Page is subscribed");
  });

  it("takes health as a prop rather than fetching it twice", () => {
    expect(src).toContain("health }: { health: MetaHealth }");
    expect(src).not.toContain("await readMetaHealth(");
  });
});

describe("Instagram panel mirrors Messenger, with the Instagram-specific facts", () => {
  const src = read("../components/InstagramStatus.tsx");

  it("reuses the Messenger panel's rows, not a second vocabulary", () => {
    expect(src).toContain('from "@/components/MessengerStatus"');
    expect(src).toContain("Row");
    expect(src).toContain("Diagnosis");
  });

  it("surfaces the three facts: account, subscription, last event", () => {
    expect(src).toContain("Instagram account");
    expect(src).toContain("Page subscription");
    expect(src).toContain("Last Instagram message");
  });

  it("judges Instagram on the `messages` field, not Messenger's message_echoes", () => {
    // Instagram has no separate message_echoes — echoes arrive via `messages` —
    // so the combined Messenger verdict must not drag the Instagram row down.
    expect(src).toContain('fields.includes("messages")');
  });

  it("counts only Instagram events for 'last message'", () => {
    expect(src).toContain('lastEventFor("instagram")');
  });

  it("has the subscription-aware waiting copy too", () => {
    expect(src).toContain("waiting for the first message");
  });
});

describe("health.ts: the Instagram-specific checks", () => {
  const src = read("../lib/meta/health.ts");

  it("last event is filtered by webhook object", () => {
    expect(src).toContain("export async function lastEventFor");
    expect(src).toContain('.eq("object", object)');
  });

  it("checks a professional Instagram account is connected to the Page", () => {
    expect(src).toContain("export async function checkInstagramAccount");
    expect(src).toContain("instagram_business_account");
    // Fails CLOSED-but-honest: a Graph failure is "unknown", a real absence is
    // "broken" — never conflated, the house rule for every check here.
    expect(src).toContain('state: "broken"');
  });
});

describe("Settings wires one health read into both panels", () => {
  const src = read("../app/(dashboard)/settings/page.tsx");
  it("reads readMetaHealth once and passes it to each panel", () => {
    expect(src).toContain("readMetaHealth()");
    expect(src).toContain("<MessengerStatus health={metaHealth} />");
    expect(src).toContain("<InstagramStatus health={metaHealth} />");
  });
});
