/**
 * What a Graph API refusal actually means, with the evidence kept.
 *
 * The panel used to print Meta's `error.message` and nothing else, so a real
 * diagnosis — "API access blocked." — arrived as a verdict with no code, no
 * subcode, no trace id and no indication of which of four unrelated problems
 * it was. That sends the reader hunting, which is the failure shape this
 * codebase keeps finding: a status that is technically true and operationally
 * useless.
 *
 * Pure, so every branch is testable without a live app.
 */

/** Everything Meta told us, before anyone decided what it meant. */
export interface GraphFailure {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  type: string | null;
  message: string;
  /** Meta's own human-facing pair. Frequently the most useful thing it sends. */
  userTitle: string | null;
  userMessage: string | null;
  fbtraceId: string | null;
}

export type GraphFailureKind =
  /** We never reached Meta: network, timeout, or nothing configured. */
  | "unreachable"
  /** The token is malformed, expired or revoked. */
  | "token_invalid"
  /** The token works but does not carry the permission this call needs. */
  | "missing_scope"
  /** The token is valid but is the wrong KIND — a user token where a Page one is needed. */
  | "wrong_token_kind"
  /** The APP is restricted — access level, App Review, business verification. */
  | "app_restricted"
  /** Throttled. Nothing is wrong; try later. */
  | "rate_limited"
  /** Recognised as a failure, not recognised as a kind. */
  | "unknown";

export interface GraphDiagnosis {
  kind: GraphFailureKind;
  /** One line naming the cause. Never the raw message alone. */
  summary: string;
  /** What the reader should do, or null when there is nothing to do. */
  action: string | null;
  /** `code 200 · subcode 1349048 · fbtrace ACOer4…` — always shown. */
  evidence: string;
}

/** Parses a Graph error body into the fields worth keeping. */
export function readGraphFailure(
  httpStatus: number | null,
  body: unknown
): GraphFailure {
  const e = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    httpStatus,
    code: num(e.code),
    subcode: num(e.error_subcode),
    type: str(e.type),
    message: str(e.message) ?? (httpStatus ? `HTTP ${httpStatus}` : "no response"),
    userTitle: str(e.error_user_title),
    userMessage: str(e.error_user_msg),
    fbtraceId: str(e.fbtrace_id),
  };
}

function evidenceOf(f: GraphFailure): string {
  const parts = [
    f.httpStatus !== null ? `HTTP ${f.httpStatus}` : null,
    f.code !== null ? `code ${f.code}` : null,
    f.subcode !== null ? `subcode ${f.subcode}` : null,
    f.type,
    f.fbtraceId ? `fbtrace ${f.fbtraceId}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Which of the four it is.
 *
 * Ordered most-specific first. The hard pair is `missing_scope` and
 * `app_restricted`: Meta returns code 200 for both, and the difference is
 * whether the message names a capability the token lacks or says the app
 * itself is not allowed to call the API at all.
 *
 * "API access blocked." is the second. It is returned even for reading the
 * app's OWN metadata with an app access token — verified against production —
 * which no missing page permission could cause.
 */
export function classifyGraphFailure(f: GraphFailure): GraphDiagnosis {
  const evidence = evidenceOf(f);
  const message = f.message;

  if (f.httpStatus === null) {
    return {
      kind: "unreachable",
      summary: `Could not reach the Graph API — ${message}`,
      action: "Check connectivity and that META_PAGE_ACCESS_TOKEN is set.",
      evidence: evidence || "no response",
    };
  }

  // 4, 17, 32, 613 are the throttles. Nothing is broken.
  if (f.code !== null && [4, 17, 32, 613].includes(f.code)) {
    return {
      kind: "rate_limited",
      summary: `Rate limited by Meta — ${message}`,
      action: "Nothing to fix; it clears on its own.",
      evidence,
    };
  }

  /**
   * 190 + 2069032 is NOT an invalid token. It is a valid token of the wrong
   * KIND: Meta wants a Page token and has been given a system user token.
   *
   * This must be checked before the generic 190 branch, because the advice
   * that follows from "invalid token" — regenerate it — produces another
   * system user token and the identical failure. It cost days.
   */
  if (f.code === 190 && f.subcode === 2069032) {
    return {
      kind: "wrong_token_kind",
      summary:
        f.userMessage ??
        "A Page access token is required for this call; the token in use is not one.",
      action:
        "Nothing to regenerate. The Page token is derived from the system user " +
        "token automatically — if this persists, the system user has lost access " +
        "to the Page in Business settings.",
      evidence,
    };
  }

  // 190 is the token itself. Subcodes name the flavour.
  if (f.code === 190) {
    const why =
      f.subcode === 463
        ? "it has expired"
        : f.subcode === 467
          ? "it has been invalidated"
          : f.subcode === 458
            ? "the app is not installed for this user"
            : "it was rejected";
    return {
      kind: "token_invalid",
      summary: `The page access token is not usable — ${why}.`,
      action:
        "Regenerate it in Business settings → System users → Generate token, " +
        "and update META_PAGE_ACCESS_TOKEN in Vercel.",
      evidence,
    };
  }

  /**
   * App-level restriction. This is the one that reads like a token problem
   * and is not: it is returned for calls that involve no page permission at
   * all, including reading the app's own metadata.
   */
  if (/API access blocked|application (has been )?(disabled|restricted)|temporarily blocked/i.test(message)) {
    return {
      kind: "app_restricted",
      summary: `Meta has blocked this app from the Graph API — “${message}”`,
      action:
        "This is an app-level restriction, not a token or scope problem. Check " +
        "developers.facebook.com → the app → Alerts and App Review, and whether " +
        "business verification is still pending.",
      evidence,
    };
  }

  // 200/10/3 with a named capability is a scope problem.
  if (f.code !== null && [200, 10, 3, 299].includes(f.code)) {
    const named = message.match(
      /\b(pages_[a-z_]+|instagram_[a-z_]+|business_management|whatsapp_[a-z_]+)\b/
    );
    if (named) {
      return {
        kind: "missing_scope",
        summary: `The token is missing the ${named[1]} permission.`,
        action:
          "Regenerate the system user token with that permission ticked, and " +
          "confirm it actually attached — debug_token shows what a token really carries.",
        evidence,
      };
    }
    return {
      kind: "missing_scope",
      summary: `Permission refused — “${message}”`,
      action:
        "Check the token's scopes with debug_token; under Standard Access a " +
        "permission can fail to attach without saying so.",
      evidence,
    };
  }

  return {
    kind: "unknown",
    summary: `Graph API refused the call — “${message}”`,
    action: "Search the code in Meta's error reference; the trace id identifies this call.",
    evidence,
  };
}
