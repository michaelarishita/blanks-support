import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTHOR_FALLBACK, agentDisplayName } from "@/lib/display";
import { DEFAULT_COMPANY, renderEmailHtml, renderEmailText } from "@/lib/email/template";

/**
 * The whole point of the split: the team calls Michael "Mike", and a customer
 * must never see that. agents.name is customer-facing; agents.display_name is
 * the dashboard label.
 */
const michael = { name: "Michael Arishita", display_name: "Mike" };

describe("agentDisplayName", () => {
  it("prefers the internal display name", () => {
    expect(agentDisplayName(michael)).toBe("Mike");
  });

  it.each([
    [{ name: "Jon Crow", display_name: "Jcrow" }, "Jcrow"],
    [{ name: "Melissa", display_name: null }, "Melissa"],
    [{ name: "Melissa", display_name: "" }, "Melissa"],
    [{ name: "Melissa", display_name: "   " }, "Melissa"],
  ])("resolves %j to %j", (agent, expected) => {
    expect(agentDisplayName(agent)).toBe(expected);
  });

  it("falls back when the agent record is gone", () => {
    expect(agentDisplayName(null)).toBe(AUTHOR_FALLBACK);
    expect(agentDisplayName({})).toBe(AUTHOR_FALLBACK);
  });
});

describe("the signature is untouched by the display name", () => {
  const agent = { name: michael.name, title: "Founder/CEO", phone: null };

  it("signs outbound email with the customer-facing name", () => {
    const html = renderEmailHtml({
      bodyHtml: "<p>hi</p>",
      agent,
      company: DEFAULT_COMPANY,
    });
    expect(html).toContain("Michael Arishita");
    expect(html).not.toContain("Mike");
  });

  it("keeps the plain-text signature customer-facing too", () => {
    const text = renderEmailText({
      bodyHtml: "<p>hi</p>",
      agent,
      company: DEFAULT_COMPANY,
    });
    expect(text).toContain("Michael Arishita");
    expect(text).not.toContain("Mike");
  });

  // The regression this guards: someone "simplifying" by feeding the
  // dashboard label into the signature.
  it("changing the display name does not change the signature", () => {
    const before = renderEmailHtml({ bodyHtml: "<p>hi</p>", agent, company: DEFAULT_COMPANY });
    const renamed = { ...michael, display_name: "Big Mike" };
    expect(agentDisplayName(renamed)).toBe("Big Mike");
    const after = renderEmailHtml({ bodyHtml: "<p>hi</p>", agent, company: DEFAULT_COMPANY });
    expect(after).toBe(before);
  });

  it("changing the signature name does not change the dashboard label", () => {
    const renamed = { ...michael, name: "M. Arishita" };
    expect(agentDisplayName(renamed)).toBe("Mike");
  });
});

describe("migration 0010", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../supabase/migrations/0010_display_names.sql", import.meta.url)),
    "utf8"
  );

  it("backfills display_name from name so nothing changes look by default", () => {
    expect(sql).toMatch(/update agents set display_name = name where display_name is null/i);
  });

  it("sets the two names the team asked for", () => {
    expect(sql).toMatch(/display_name = 'Jcrow'/);
    expect(sql).toMatch(/display_name = 'Mike'/);
  });

  // If this ever rewrote agents.name, Michael's signature would read "Mike".
  it("never rewrites agents.name", () => {
    expect(sql).not.toMatch(/set\s+name\s*=/i);
  });
});
