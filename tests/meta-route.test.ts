import { beforeEach, describe, expect, it, vi } from "vitest";
import { signMetaBody } from "@/lib/meta/signature";

/**
 * The endpoint itself, driven as a request.
 *
 * The property under test is almost never "it worked" — it is "it answered
 * 200 anyway". Meta unsubscribes an app after an hour of non-200s, and an
 * unsubscribed app is a silent inbound outage: the Page keeps receiving
 * messages, we keep not hearing about them, and the ticket table looks like
 * a quiet week. Every branch below is about not losing the subscription.
 */

const SECRET = "app-secret-not-a-real-one";
const VERIFY = "verify-token-not-a-real-one";

const recordResult = vi.hoisted(() => ({ id: "evt-1" as string | null, error: null as string | null }));
const drain = vi.hoisted(() => ({ calls: 0, throws: false }));
const recorded = vi.hoisted(() => ({ signatureOk: [] as boolean[] }));

vi.mock("@/lib/meta/queue", () => ({
  recordWebhookEvent: async ({ signatureOk }: { signatureOk: boolean }) => {
    recorded.signatureOk.push(signatureOk);
    return recordResult;
  },
  drainWebhookEvents: async () => {
    drain.calls++;
    if (drain.throws) throw new Error("processing blew up");
    return { received: 1, created: 1, appended: 0, skipped: {}, drained: 1, failed: 0 };
  },
  MAX_ATTEMPTS: 5,
}));

// `after` runs its callback immediately here, so the test can observe what
// would have happened once the response had gone.
const afterCallbacks: (() => unknown)[] = [];
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => unknown) => { afterCallbacks.push(fn); } };
});

const { GET, POST } = await import("@/app/api/webhooks/meta/route");

function post(raw: string, header: string | null) {
  return new Request("https://support.example.com/api/webhooks/meta", {
    method: "POST",
    body: raw,
    headers: header ? { "x-hub-signature-256": header } : {},
  }) as unknown as Parameters<typeof POST>[0];
}

function get(params: Record<string, string>) {
  const url = new URL("https://support.example.com/api/webhooks/meta");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const request = new Request(url) as unknown as Parameters<typeof GET>[0];
  // NextRequest exposes nextUrl; a plain Request does not.
  Object.defineProperty(request, "nextUrl", { value: url, configurable: true });
  return request;
}

const BODY = JSON.stringify({
  object: "page",
  entry: [{ id: "426348370572945", messaging: [{ message: { mid: "m1", text: "hi" } }] }],
});

beforeEach(() => {
  process.env.META_APP_SECRET = SECRET;
  process.env.META_VERIFY_TOKEN = VERIFY;
  recordResult.id = "evt-1";
  recordResult.error = null;
  drain.calls = 0;
  drain.throws = false;
  recorded.signatureOk = [];
  afterCallbacks.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("the subscription handshake", () => {
  it("echoes the challenge as PLAIN TEXT", async () => {
    // JSON — even the right value in quotes — fails verification with no
    // useful error, which is a genuinely annoying twenty minutes.
    const res = await GET(get({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "12345" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("12345");
  });

  it("refuses a wrong token", async () => {
    const res = await GET(get({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "12345" }));
    expect(res.status).toBe(403);
  });

  it("refuses a wrong mode", async () => {
    const res = await GET(get({ "hub.mode": "unsubscribe", "hub.verify_token": VERIFY, "hub.challenge": "12345" }));
    expect(res.status).toBe(403);
  });

  it("does not put the token in the response", async () => {
    const res = await GET(get({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "x" }));
    expect(await res.text()).not.toContain(VERIFY);
  });
});

describe("an unsigned or wrongly signed event", () => {
  it("is refused with 403", async () => {
    const res = await POST(post(BODY, "sha256=" + "0".repeat(64)));
    expect(res.status).toBe(403);
  });

  it("is refused when the header is missing entirely", async () => {
    expect((await POST(post(BODY, null))).status).toBe(403);
  });

  it("is still recorded, so a run of them is visible", async () => {
    await POST(post(BODY, "sha256=" + "0".repeat(64)));
    expect(recorded.signatureOk).toEqual([false]);
  });

  it("is never processed", async () => {
    await POST(post(BODY, "sha256=" + "0".repeat(64)));
    expect(afterCallbacks).toHaveLength(0);
  });
});

describe("a properly signed event", () => {
  it("is acknowledged BEFORE any processing", async () => {
    const res = await POST(post(BODY, signMetaBody(BODY, SECRET)));
    expect(res.status).toBe(200);
    // The response is built with the drain still unrun — that ordering IS the
    // five-second guarantee.
    expect(drain.calls).toBe(0);
    expect(afterCallbacks).toHaveLength(1);
  });

  it("processes once the response has gone", async () => {
    await POST(post(BODY, signMetaBody(BODY, SECRET)));
    await afterCallbacks[0]();
    expect(drain.calls).toBe(1);
  });

  it("STILL returns 200 when processing throws", async () => {
    // The whole point. A 500 here earns a retry storm and, after an hour, a
    // disabled subscription.
    drain.throws = true;
    const res = await POST(post(BODY, signMetaBody(BODY, SECRET)));
    expect(res.status).toBe(200);
    await expect(afterCallbacks[0]()).resolves.not.toThrow();
  });

  it("returns 200 for a signed body that is not JSON", async () => {
    // Retrying will not make it parse. Acknowledged and kept.
    const raw = "not json";
    const res = await POST(post(raw, signMetaBody(raw, SECRET)));
    expect(res.status).toBe(200);
  });

  it("refuses to acknowledge an event it could not store", async () => {
    // The ONE case worth a non-200: we do not have it, so a retry is
    // genuinely useful and losing it silently is worse.
    recordResult.id = null;
    recordResult.error = "relation meta_webhook_events does not exist";
    const res = await POST(post(BODY, signMetaBody(BODY, SECRET)));
    expect(res.status).toBe(500);
    expect(afterCallbacks).toHaveLength(0);
  });
});

describe("failing closed", () => {
  it("refuses everything when the app secret is unset", async () => {
    // "Nothing to check" is how an endpoint ships unauthenticated.
    delete process.env.META_APP_SECRET;
    const res = await POST(post(BODY, signMetaBody(BODY, SECRET)));
    expect(res.status).toBe(403);
  });

  it("refuses the handshake when the verify token is unset", async () => {
    delete process.env.META_VERIFY_TOKEN;
    const res = await GET(get({ "hub.mode": "subscribe", "hub.verify_token": "x", "hub.challenge": "y" }));
    expect(res.status).toBe(500);
  });
});
