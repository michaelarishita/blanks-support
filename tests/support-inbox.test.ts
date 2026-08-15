import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import { humanizePostgresError, isMissingSchemaError } from "@/lib/supabase/errors";

/**
 * An in-memory stand-in for the oauth_tokens table, with the one constraint
 * that actually broke: at most one row may have is_support_inbox = true.
 */
interface Row {
  provider: string;
  agent_id: string | null;
  account_ref: string;
  encrypted_refresh_token: string;
  is_support_inbox: boolean;
}

const rows: Row[] = [];
const revoked: string[] = [];

/** Mirrors claim_support_inbox: replace the occupant of the slot. */
function claimSupportInbox(accountRef: string, token: string) {
  const displaced = rows.find((r) => r.provider === "google" && r.is_support_inbox);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].provider === "google" && rows[i].is_support_inbox) rows.splice(i, 1);
  }
  rows.push({
    provider: "google",
    agent_id: null,
    account_ref: accountRef,
    encrypted_refresh_token: token,
    is_support_inbox: true,
  });

  // The unique index, asserted rather than assumed.
  const occupants = rows.filter((r) => r.provider === "google" && r.is_support_inbox);
  if (occupants.length > 1) {
    throw new Error(
      "duplicate key value violates unique constraint oauth_tokens_one_support_inbox"
    );
  }

  if (displaced && displaced.account_ref !== accountRef) {
    revoked.push(displaced.encrypted_refresh_token);
  }
  return displaced ?? null;
}

/** The old behaviour, kept to prove the test would have caught the bug. */
function saveConnectionOldWay(accountRef: string, token: string) {
  const existing = rows.find(
    (r) => r.provider === "google" && r.agent_id === null && r.account_ref === accountRef
  );
  if (existing) {
    existing.encrypted_refresh_token = token;
  } else {
    rows.push({
      provider: "google",
      agent_id: null,
      account_ref: accountRef,
      encrypted_refresh_token: token,
      is_support_inbox: true,
    });
  }
  const occupants = rows.filter((r) => r.provider === "google" && r.is_support_inbox);
  if (occupants.length > 1) {
    throw new Error(
      "duplicate key value violates unique constraint oauth_tokens_one_support_inbox"
    );
  }
}

beforeEach(() => {
  rows.length = 0;
  revoked.length = 0;
});

describe("claiming the support-inbox slot", () => {
  // The exact sequence from the incident: michael@ connected by mistake,
  // then hello@ connected to correct it.
  it("replaces the occupant — one row remains, and it is the second account", () => {
    claimSupportInbox("michael@blankssportsnutrition.com", "token-a");
    claimSupportInbox("hello@blankssportsnutrition.com", "token-b");

    const supportRows = rows.filter((r) => r.is_support_inbox);
    expect(supportRows).toHaveLength(1);
    expect(supportRows[0].account_ref).toBe("hello@blankssportsnutrition.com");
    expect(supportRows[0].encrypted_refresh_token).toBe("token-b");
  });

  it("revokes the displaced account's token", () => {
    claimSupportInbox("michael@blankssportsnutrition.com", "token-a");
    claimSupportInbox("hello@blankssportsnutrition.com", "token-b");
    expect(revoked).toEqual(["token-a"]);
  });

  it("is idempotent for the same account", () => {
    claimSupportInbox("hello@blankssportsnutrition.com", "token-a");
    claimSupportInbox("hello@blankssportsnutrition.com", "token-b");

    expect(rows.filter((r) => r.is_support_inbox)).toHaveLength(1);
    expect(rows[0].encrypted_refresh_token).toBe("token-b");
    // Same mailbox reconnecting: nothing to revoke.
    expect(revoked).toEqual([]);
  });

  it("works on an empty slot", () => {
    claimSupportInbox("hello@blankssportsnutrition.com", "token-a");
    expect(rows.filter((r) => r.is_support_inbox)).toHaveLength(1);
    expect(revoked).toEqual([]);
  });

  it("leaves a personal agent connection untouched", () => {
    rows.push({
      provider: "google",
      agent_id: "agent-1",
      account_ref: "michael@blankssportsnutrition.com",
      encrypted_refresh_token: "personal",
      is_support_inbox: false,
    });
    claimSupportInbox("hello@blankssportsnutrition.com", "token-b");

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.agent_id === "agent-1")?.encrypted_refresh_token).toBe(
      "personal"
    );
  });

  // Guards the fix: the old code raised the exact error from the incident.
  it("the previous implementation raised the constraint violation", () => {
    saveConnectionOldWay("michael@blankssportsnutrition.com", "token-a");
    expect(() =>
      saveConnectionOldWay("hello@blankssportsnutrition.com", "token-b")
    ).toThrow(/oauth_tokens_one_support_inbox/);
  });
});

const pgError = (
  code: string,
  message: string,
  details = ""
): PostgrestError =>
  ({ code, message, details, hint: "", name: "PostgrestError" }) as PostgrestError;

describe("humanizePostgresError", () => {
  it("explains the support-inbox constraint instead of quoting it", () => {
    const text = humanizePostgresError(
      pgError(
        "23505",
        'duplicate key value violates unique constraint "oauth_tokens_one_support_inbox"'
      )
    );
    expect(text).toMatch(/already connected as the support inbox/i);
    expect(text).toMatch(/0007_claim_support_inbox\.sql/);
    expect(text).not.toMatch(/duplicate key value/);
  });

  it("points a missing table at the migration banner", () => {
    const text = humanizePostgresError(
      pgError("PGRST205", "Could not find the table 'public.settings'")
    );
    expect(text).toMatch(/migration hasn't been run/i);
    expect(text).toMatch(/banner/);
  });

  it("names an already-imported email rather than the index", () => {
    expect(
      humanizePostgresError(
        pgError("23505", 'duplicate key value violates unique constraint "messages_gmail_message_id_uniq"')
      )
    ).toMatch(/already been imported/i);
  });

  it("keeps the underlying detail for an unrecognised error", () => {
    const text = humanizePostgresError(pgError("XX000", "connection reset"));
    expect(text).toContain("connection reset");
  });

  it("names the migration when the SQL function is missing", () => {
    // The schema banner cannot probe a function-only migration, so this is
    // the only place a missing 0007 announces itself.
    const text = humanizePostgresError(
      pgError("PGRST202", "Could not find the function public.claim_support_inbox")
    );
    expect(text).toMatch(/migration hasn't been run/i);
  });

  it.each([
    ["42P01", true],
    ["42703", true],
    ["42883", true],
    ["PGRST202", true],
    ["PGRST205", true],
    ["23505", false],
  ])("isMissingSchemaError(%s) === %s", (code, expected) => {
    expect(isMissingSchemaError(pgError(code, "x"))).toBe(expected);
  });
});

/**
 * The guard that would have stopped the incident before any row was written.
 * Mirrors the check in the OAuth callback.
 */
function shouldRefuseSupportConnect(
  connectedAs: string,
  supportEmail: string | undefined,
  confirmed: boolean
): boolean {
  const expected = supportEmail?.trim().toLowerCase();
  if (!expected || confirmed) return false;
  return connectedAs.trim().toLowerCase() !== expected;
}

describe("support mailbox address guard", () => {
  const HELLO = "hello@blankssportsnutrition.com";

  it("refuses the wrong account", () => {
    expect(
      shouldRefuseSupportConnect("michael@blankssportsnutrition.com", HELLO, false)
    ).toBe(true);
  });

  it("accepts the expected account", () => {
    expect(shouldRefuseSupportConnect(HELLO, HELLO, false)).toBe(false);
  });

  it.each(["HELLO@BlanksSportsNutrition.com", "  hello@blankssportsnutrition.com  "])(
    "compares case- and whitespace-insensitively (%j)",
    (connected) => {
      expect(shouldRefuseSupportConnect(connected, HELLO, false)).toBe(false);
    }
  );

  it("allows an explicitly confirmed mismatch through", () => {
    expect(
      shouldRefuseSupportConnect("michael@blankssportsnutrition.com", HELLO, true)
    ).toBe(false);
  });

  it("cannot refuse when SUPPORT_EMAIL is unset", () => {
    expect(shouldRefuseSupportConnect("anyone@example.com", undefined, false)).toBe(
      false
    );
  });
});
