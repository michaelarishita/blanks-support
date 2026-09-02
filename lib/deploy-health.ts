import { serverBuildId } from "@/lib/stale-deploy";

/**
 * Is what customers are using the code we last shipped?
 *
 * Every subsystem here has a heartbeat except the one that ships the app.
 * Seven production builds failed over four days and the only reason anybody
 * found out was that somebody went looking — the same shape as the inbound
 * outage, and for the same reason: a failure that produces silence rather
 * than an error.
 *
 * Deliberately NOT built on Vercel's notification emails. We already know an
 * emailed alert dies in the noise — that is the whole reason system alerts
 * became a row first and an email second.
 *
 * Pure and clock-injectable; the network half is in `readDeployHealth`.
 */

/** Behind for longer than this is a problem rather than a deploy in flight. */
export const BEHIND_ALERT_HOURS = 6;

export type DeployVerdict = "current" | "behind" | "unknown";

export interface DeployHealth {
  state: DeployVerdict;
  /** The sha production is serving, when we could read it. */
  running: string | null;
  /** The sha at the head of main, when we could read it. */
  head: string | null;
  /** How long they have disagreed, in hours, when we can tell. */
  behindHours: number | null;
  detail: string;
}

/**
 * The comparison, given both answers.
 *
 * `unknown` is a first-class outcome and never collapses into `behind`. A
 * GitHub rate limit or an unreachable site says nothing about whether a
 * deploy succeeded, and reporting it as "production is stale" would send
 * somebody to re-deploy a system that was fine — the schema banner's lesson,
 * applied to the thing that ships the schema.
 */
export function compareDeploy({
  running,
  head,
  divergedSince,
  now,
}: {
  running: string | null;
  head: string | null;
  /** When the two were first seen to disagree. */
  divergedSince: number | null;
  now: number;
}): DeployHealth {
  if (!running || !head) {
    return {
      state: "unknown",
      running,
      head,
      behindHours: null,
      detail: !running
        ? "could not read the build id from production"
        : "could not read the head of main",
    };
  }

  // Short shas on one side, full on the other: compare by prefix, longest
  // common form. A false "behind" from a formatting difference would be the
  // most annoying possible version of this alarm.
  const n = Math.min(running.length, head.length);
  if (n >= 7 && running.slice(0, n) === head.slice(0, n)) {
    return {
      state: "current",
      running,
      head,
      behindHours: 0,
      detail: `production is running ${running.slice(0, 7)}`,
    };
  }

  // They differ. That alone is not an alarm — a deploy takes minutes, and a
  // push five seconds ago is not a failure.
  const behindHours =
    divergedSince === null ? 0 : Math.floor((now - divergedSince) / 3_600_000);

  return {
    state: behindHours >= BEHIND_ALERT_HOURS ? "behind" : "current",
    running,
    head,
    behindHours,
    detail:
      behindHours >= BEHIND_ALERT_HOURS
        ? `production has been on ${running.slice(0, 7)} for ${behindHours}h while main is ${head.slice(0, 7)}`
        : `deploying: production ${running.slice(0, 7)}, main ${head.slice(0, 7)}`,
  };
}

const TIMEOUT_MS = 8000;

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store", headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What production is serving.
 *
 * Read from the deployed site itself rather than from Vercel's API: it is the
 * only source that reflects what a CUSTOMER is actually being given, which is
 * the question. A green deploy that is not being served would still be a
 * problem, and this notices that too.
 */
export async function readRunningBuild(siteUrl: string): Promise<string | null> {
  const html = await fetchText(`${siteUrl.replace(/\/$/, "")}/login`);
  if (!html) return null;
  const meta = html.match(/name="build-sha"\s+content="([^"]+)"/);
  return meta?.[1] ?? null;
}

/** The head of main, from GitHub. Public repo read; no token needed. */
export async function readHeadOfMain(repo: string): Promise<string | null> {
  const body = await fetchText(
    `https://api.github.com/repos/${repo}/commits/main`,
    { Accept: "application/vnd.github+json", "User-Agent": "blanks-support-heartbeat" }
  );
  if (!body) return null;
  try {
    const sha = (JSON.parse(body) as { sha?: string }).sha;
    return typeof sha === "string" ? sha : null;
  } catch {
    return null;
  }
}

/** The local build's own id, for the case where the site is unreachable. */
export function localBuildId(): string | null {
  return serverBuildId();
}
