import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOPICS } from "@/lib/types";

/**
 * Topics have three separate homes and no foreign key between any of them:
 *
 *   lib/types.ts TOPICS   the customer's picker
 *   tags.name             what the intake endpoint looks up BY NAME to tag
 *   rules.conditions      what routing matches on, also by name
 *
 * So a rename breaks two things silently. A topic with no tag row files
 * untagged tickets; a rule condition naming a retired topic reads as live
 * routing while being unreachable. Neither surfaces as an error anywhere.
 *
 * These tests reconstruct the post-migration state from the SQL rather than
 * talking to a database, so they run in the same pure suite as everything
 * else. That limits them to the statement shapes we actually write — which is
 * fine, because they are checking OUR migrations, not arbitrary SQL.
 */

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../supabase/migrations", import.meta.url)
);

const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

/**
 * Removes `--` comments.
 *
 * Not cosmetic: the comments in 0012 contain apostrophes ("0011's
 * placeholders", "Jon's rule"), and every parser below reads single-quoted
 * SQL literals. Leaving them in makes the quote pairing off by one and the
 * results quietly wrong.
 */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function read(file: string): string {
  return stripComments(
    readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8")
  );
}

/** The top-level `( ... )` groups following a keyword, paren-depth aware. */
function tupleGroups(sql: string, fromIndex: number): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = fromIndex; i < sql.length; i++) {
    const char = sql[i];
    if (char === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0 && start !== -1) {
        groups.push(sql.slice(start, i));
        start = -1;
      }
    } else if (char === ";" && depth === 0) {
      break;
    }
  }
  return groups;
}

/** Tag names that exist once every migration has run. */
function tagNamesAfterMigrations(): Set<string> {
  const names = new Set<string>();

  for (const file of FILES) {
    const sql = read(file);

    // insert into tags (name, color, is_topic) values ('X', …), ('Y', …);
    const insertMatch = /insert\s+into\s+tags\s*\([^)]*\)\s*values/i.exec(sql);
    if (insertMatch) {
      for (const group of tupleGroups(sql, insertMatch.index + insertMatch[0].length)) {
        const name = /'((?:[^']|'')*)'/.exec(group);
        if (name) names.add(name[1].replace(/''/g, "'"));
      }
    }

    // update tags set name = 'New' where name = 'Old'
    const renames = sql.matchAll(
      /update\s+tags\s+set\s+name\s*=\s*'((?:[^']|'')*)'\s+where\s+name\s*=\s*'((?:[^']|'')*)'/gi
    );
    for (const rename of renames) {
      const to = rename[1].replace(/''/g, "'");
      const from = rename[2].replace(/''/g, "'");
      names.delete(from);
      names.add(to);
    }
  }

  return names;
}

interface SeededRule {
  file: string;
  name: string;
  topics: string[];
}

/** Rules that exist once every migration has run — inserts minus deletes. */
function liveSeededRules(): SeededRule[] {
  const byName = new Map<string, SeededRule>();

  for (const file of FILES) {
    const sql = read(file);

    // delete from rules where name in ('A', 'B');
    const deleteMatches = sql.matchAll(
      /delete\s+from\s+rules\s+where\s+name\s+in\s*\(([\s\S]*?)\)\s*;/gi
    );
    for (const deletion of deleteMatches) {
      for (const literal of deletion[1].matchAll(/'((?:[^']|'')*)'/g)) {
        byName.delete(literal[1].replace(/''/g, "'"));
      }
    }

    // insert into rules (…) values ( 'Name', …, '[conditions]'::jsonb, … );
    const insertMatch = /insert\s+into\s+rules\s*\([^)]*\)\s*values/i.exec(sql);
    if (!insertMatch) continue;

    for (const group of tupleGroups(sql, insertMatch.index + insertMatch[0].length)) {
      const nameMatch = /'((?:[^']|'')*)'/.exec(group);
      if (!nameMatch) continue;
      const name = nameMatch[1].replace(/''/g, "'");

      const topics = [
        ...group.matchAll(/"field"\s*:\s*"topic"[^}]*?"value"\s*:\s*"([^"]+)"/g),
      ].map((match) => match[1]);

      byName.set(name, { file, name, topics });
    }
  }

  return [...byName.values()];
}

describe("migration parsing", () => {
  // If these ever break, every assertion below turns into a vacuous pass —
  // so the parsers get their own smoke test rather than being trusted.
  it("finds tag rows", () => {
    expect(tagNamesAfterMigrations().size).toBeGreaterThan(5);
  });

  it("finds seeded rules", () => {
    expect(liveSeededRules().length).toBeGreaterThan(0);
  });

  it("finds topic conditions on those rules", () => {
    const withTopics = liveSeededRules().filter((rule) => rule.topics.length);
    expect(withTopics.length).toBeGreaterThan(0);
  });
});

describe("every topic has a tag row", () => {
  const tags = tagNamesAfterMigrations();

  it.each(TOPICS)("%s exists in tags", (topic) => {
    // The intake endpoint tags a ticket by looking the topic up by name. A
    // topic with no row here doesn't error — it just files the ticket
    // untagged, and the inbox filter quietly stops finding it.
    expect(tags.has(topic)).toBe(true);
  });
});

describe("every rule condition names a real topic", () => {
  const live = liveSeededRules();

  it.each(live.flatMap((rule) => rule.topics.map((topic) => [rule.name, topic])))(
    "%s matches on an existing topic: %s",
    (_name, topic) => {
      // A rule pointing at a retired topic can never fire, but still reads as
      // live routing in Settings. That is exactly what happened to the 0011
      // sponsorship rule when "Ambassador / athlete" was retired.
      expect(TOPICS as readonly string[]).toContain(topic);
    }
  );
});

describe("the Subscription rename", () => {
  it("uses the new name in TOPICS", () => {
    expect(TOPICS as readonly string[]).toContain("Subscription Help");
  });

  it("no longer offers the old name", () => {
    expect(TOPICS as readonly string[]).not.toContain("Subscription");
  });

  it("renamed the row instead of adding one", () => {
    const tags = tagNamesAfterMigrations();
    expect(tags.has("Subscription Help")).toBe(true);
    // Both present would mean an insert, which would leave every existing
    // subscription ticket pointing at the old row and out of the new filter.
    expect(tags.has("Subscription")).toBe(false);
  });
});

describe("the Ambassador / athlete deprecation", () => {
  const DEPRECATED = "Ambassador / athlete";

  it("is gone from the customer picker", () => {
    expect(TOPICS as readonly string[]).not.toContain(DEPRECATED);
  });

  /**
   * The whole point of deprecating rather than deleting. Dropping the row
   * would cascade through ticket_tags and take the tag off every historical
   * ticket that carries it.
   */
  it("still exists as a tag row", () => {
    expect(tagNamesAfterMigrations().has(DEPRECATED)).toBe(true);
  });

  it("is not referenced by any live rule", () => {
    const offenders = liveSeededRules()
      .filter((rule) => rule.topics.includes(DEPRECATED))
      .map((rule) => `${rule.name} (${rule.file})`);
    expect(offenders).toEqual([]);
  });
});

describe("the live routing seeds", () => {
  const live = liveSeededRules();
  const named = (name: string) => live.find((rule) => rule.name === name);

  it("dropped 0011's placeholder rules", () => {
    for (const name of [
      "Order changes → Harvey",
      "Wholesale → tag and route",
      "Sponsorship and athletes → Michael",
    ]) {
      expect(named(name)).toBeUndefined();
    }
  });

  it.each([
    ["Product, wholesale and events → Jon", ["Product questions", "Wholesale / retailer", "Event questions"]],
    ["Orders and shipping → Harvey", ["Order questions", "Shipping & returns"]],
    ["Sponsorship → Michael", ["Sponsorship inquiry"]],
  ])("%s routes the topics it should", (name, topics) => {
    expect(named(name)?.topics).toEqual(topics);
  });

  it("keeps the refund rule", () => {
    expect(named("Refund mentions → High priority")).toBeDefined();
  });
});
