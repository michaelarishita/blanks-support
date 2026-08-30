// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  isStaleDeploymentError,
  looksLikeSchemaError,
} from "@/lib/stale-deploy";

vi.mock("@/app/actions", () => ({}));
const DashboardError = (await import("@/app/(dashboard)/error")).default;

afterEach(cleanup);

/**
 * A stale tab is not an outage.
 *
 * When a new build ships, a tab that was already open holds client JavaScript
 * referring to Server Action ids the new server has never heard of. The next
 * action fails, and the raw framework error reads as the app being broken.
 */
describe("recognising a stale tab", () => {
  it("matches the error Next actually throws", () => {
    // The message from next/dist/client/components/unrecognized-action-error.
    const real = new Error(
      'Server Action "7f3ab2c1" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action'
    );
    real.name = "UnrecognizedActionError";
    expect(isStaleDeploymentError(real)).toBe(true);
  });

  it("matches on the name alone, in case the wording changes", () => {
    const renamed = new Error("something else entirely");
    renamed.name = "UnrecognizedActionError";
    expect(isStaleDeploymentError(renamed)).toBe(true);
  });

  it("matches on the message alone, in case the class is renamed", () => {
    // Two chances on purpose: `name` survives an error crossing a boundary,
    // the message survives a class being renamed, and neither is reliable
    // alone. An instanceof check would be the most precise and the most
    // brittle — it fails silently when two copies of the module exist.
    expect(
      isStaleDeploymentError(
        new Error("Failed to find Server Action. This request might be from an older deployment.")
      )
    ).toBe(true);
  });

  it("does not swallow an ordinary failure", () => {
    // The expensive mistake in the other direction: telling somebody to reload
    // when the database is actually down teaches them that "reload" is what
    // this app says when it has nothing useful to offer.
    for (const message of [
      "column agents.title does not exist",
      "fetch failed",
      "Not authenticated",
      "new row violates row-level security policy",
      "The server action returned an error",
    ]) {
      expect(isStaleDeploymentError(new Error(message))).toBe(false);
    }
  });

  it("survives a non-error being thrown", () => {
    for (const thrown of [null, undefined, "a string", 42, {}]) {
      expect(isStaleDeploymentError(thrown)).toBe(false);
    }
  });
});

/**
 * The hint that sent somebody to the database for a problem that was not
 * there. Useful for a schema error; misleading on everything else.
 */
describe("the migration hint", () => {
  it("fires on what a real schema error looks like", () => {
    for (const message of [
      'column messages.bulk_marker does not exist',
      'relation "public.system_alerts" does not exist',
      "Postgres 42703: column tickets.risk_score does not exist",
      "42P01",
      "PGRST205: Could not find the table 'public.x' in the schema cache",
      "Could not find the 'watch_new_tickets' column of 'agents' in the schema cache",
    ]) {
      expect(looksLikeSchemaError(message)).toBe(true);
    }
  });

  it("stays quiet on everything else", () => {
    for (const message of [
      'Server Action "7f3a" was not found on the server.',
      "fetch failed",
      "Requested entity was not found. (HTTP 404)",
      "No support mailbox connected.",
      "new row violates row-level security policy",
      "",
    ]) {
      expect(looksLikeSchemaError(message)).toBe(false);
    }
  });
});

/** The boundary itself, rendered — not asserted over its source. */
describe("what the error boundary shows", () => {
  const reset = () => {};

  it("offers a reload, and no internals, for a stale tab", () => {
    const stale = Object.assign(
      new Error('Server Action "7f3ab2c1" was not found on the server.'),
      { name: "UnrecognizedActionError" }
    );
    const { container } = render(<DashboardError error={stale} reset={reset} />);
    const text = container.textContent ?? "";

    expect(text).toContain("A new version was released");
    expect(text).toMatch(/reload/i);
    // The framework's message is true and useless to the reader.
    expect(text).not.toContain("Server Action");
    expect(text).not.toContain("7f3ab2c1");
    // And it must not say the thing that makes this read as an outage.
    expect(text).not.toContain("Something broke");
    // "Try again" re-renders the same stale bundle and would fail identically.
    expect(text).not.toContain("Try again");
  });

  it("promises the draft is safe, because it is", () => {
    const stale = Object.assign(new Error("x"), {
      name: "UnrecognizedActionError",
    });
    const { container } = render(<DashboardError error={stale} reset={reset} />);
    expect(container.textContent).toMatch(/saved|still be here/i);
  });

  it("still shows the real message for a real error", () => {
    const { container } = render(
      <DashboardError
        error={new Error("column agents.title does not exist")}
        reset={reset}
      />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Something broke");
    expect(text).toContain("column agents.title does not exist");
    expect(text).toContain("migration");
  });

  it("omits the migration hint when the error is not about the schema", () => {
    const { container } = render(
      <DashboardError error={new Error("fetch failed")} reset={reset} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("fetch failed");
    expect(text).not.toContain("migration");
    expect(text).not.toContain("schema");
  });
});
