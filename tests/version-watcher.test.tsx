// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

const VersionWatcher = (await import("@/components/VersionWatcher")).default;

/**
 * Noticing a new deployment BEFORE it breaks something.
 *
 * Every assertion here is about NOT showing the bar. Showing it is easy; the
 * failure that matters is a bar that appears when nothing has changed, because
 * "reload to continue" is a thing people stop reading the moment it is wrong
 * once — the same lesson as the alert banner and the schema checker.
 */
function serve(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  } as Response);
}

/** Answers a sequence of build ids, one per call, repeating the last. */
function serveSequence(ids: (string | null)[]) {
  let i = 0;
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ buildId: ids[Math.min(i++, ids.length - 1)] }),
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("when the bar appears", () => {
  it("shows once the answer CHANGES", async () => {
    // The first answer is the baseline — the build this tab loaded against.
    // Only a later, different one is a deployment.
    vi.stubGlobal("fetch", serveSequence(["build-aaa", "build-bbb"]));
    const { container } = render(<VersionWatcher />);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(container.textContent).toContain("A new version was released")
    );
    expect(container.textContent).toMatch(/reload/i);
    // It has to say the draft is safe, or the honest response to it is to not
    // reload until you have finished typing — which is when it stops working.
    expect(container.textContent).toMatch(/saved/i);
  });
});

describe("when it must stay quiet", () => {
  it("says nothing while the build is unchanged", async () => {
    vi.stubGlobal("fetch", serve({ buildId: "build-aaa" }));
    const { container } = render(<VersionWatcher />);
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toBe("");
  });

  it("says nothing on the very first answer, whatever it is", async () => {
    // A tab opened AFTER a deploy must not immediately demand a reload.
    vi.stubGlobal("fetch", serve({ buildId: "something-new" }));
    const { container } = render(<VersionWatcher />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toBe("");
  });

  it("says nothing when the server reports no build id", async () => {
    // Null is "we could not tell you", not "a new version shipped". Treating
    // the two the same would put a reload prompt in front of everybody the
    // moment the env var went missing.
    vi.stubGlobal("fetch", serve({ buildId: null }));
    const { container } = render(<VersionWatcher />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });

  it("says nothing when the check fails", async () => {
    vi.stubGlobal("fetch", serve({}, false));
    const { container } = render(<VersionWatcher />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });

  it("says nothing when the network is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { container } = render(<VersionWatcher />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });

  it("never takes null as a baseline", async () => {
    // Local development answers null. If null were stored as the baseline, the
    // first real id afterwards would read as a new deployment.
    vi.stubGlobal("fetch", serveSequence([null, null, "local"]));
    const { container } = render(<VersionWatcher />);
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.textContent).toBe("");
  });
});

describe("how it asks", () => {
  it("never caches the answer", async () => {
    const fetchMock = serve({ buildId: "build-aaa" });
    vi.stubGlobal("fetch", fetchMock);
    render(<VersionWatcher />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("is a status, not an alarm", async () => {
    // Nothing is broken at this point. A red alert here is the boy who cried
    // wolf, which this app has already paid for once.
    vi.stubGlobal("fetch", serveSequence(["build-aaa", "build-bbb"]));
    const { container } = render(<VersionWatcher />);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(container.querySelector('[role="status"]')).not.toBeNull()
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("re-checks when the tab is brought back", async () => {
    // The common case is a laptop opened onto yesterday's tab, where every
    // poll it would have made happened while it was asleep.
    const fetchMock = serve({ buildId: "build-aaa" });
    vi.stubGlobal("fetch", fetchMock);
    render(<VersionWatcher />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
