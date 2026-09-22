import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * PRIVACY IS THE HARD PART. This is written FIRST, before the feature works.
 *
 * personal_messages holds ONE agent's private inbox. The rest of this app
 * assumes any agent may read any ticket (RLS via is_agent()). That assumption
 * must NOT reach this table: the owner is the only reader. If a future edit
 * relaxes the policy to is_agent() — or drops RLS — these assertions fail.
 *
 * The repo has no live two-user RLS harness (the admin client bypasses RLS and
 * vitest has no agent JWTs), so this asserts the policy's SHAPE over the
 * migration SQL — the same discipline as schema-check and query-error-honesty.
 * The property "another agent cannot read a row" is a property of the policy
 * text, and that is what is checked.
 */

const sql = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const migration = sql("../supabase/migrations/0027_personal_triage.sql");

describe("personal_messages is private to its owner", () => {
  it("enables row level security on both tables", () => {
    expect(migration).toMatch(/alter table personal_messages enable row level security/i);
    expect(migration).toMatch(
      /alter table personal_triage_corrections enable row level security/i
    );
  });

  it("scopes reads to the OWNER, via owner_agent_id = auth.uid()", () => {
    // The owner-only predicate must appear for the select policy.
    expect(migration).toMatch(/owner_agent_id\s*=\s*auth\.uid\(\)/i);
  });

  it("NEVER grants broad agent read on personal data (no is_agent / is_admin)", () => {
    // The whole point: the ticket-wide read model must not reach this table.
    // is_agent()/is_admin() anywhere in this migration would be that leak.
    expect(migration).not.toMatch(/is_agent\s*\(/i);
    expect(migration).not.toMatch(/is_admin\s*\(/i);
  });

  it("stores a snippet but NEVER a message body column", () => {
    // Bodies are fetched from Gmail on demand and never persisted.
    expect(migration).toMatch(/snippet/i);
    expect(migration).not.toMatch(/\bbody_text\b/i);
    expect(migration).not.toMatch(/\bbody_html\b/i);
    expect(migration).not.toMatch(/\bbody\s+text\b/i);
  });
});
