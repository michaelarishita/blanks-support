/**
 * What the customer is allowed to be told when a submission fails.
 *
 * The rule: the ONLY string shown verbatim is one the server sent in its JSON
 * `error` field, because those are ours and are written for a customer.
 * Everything else — a DOMException, a JSON parse failure, a network error — is
 * mapped to copy below.
 *
 * This is the error-swallowing principle in reverse. Elsewhere in the app the
 * sin is hiding a real failure behind a friendly message; here the sin is
 * showing a browser's internal diagnostic to a member of the public. Safari
 * renders an unparseable response body as "The string did not match the
 * expected pattern.", which is both meaningless to a customer and
 * indistinguishable, to us, from a dozen other WebKit throws.
 *
 * Pure, so every branch is testable without a browser — which matters
 * especially here, since the bug that prompted it only appears in one.
 */

export const CONTACT_FALLBACK = "hello@blankssportsnutrition.com";

export const GENERIC_FAILURE =
  `Something went wrong sending your message. Please try again, or email us at ${CONTACT_FALLBACK}.`;

const NETWORK_FAILURE =
  `We couldn't reach the server. Check your connection and try again, or email us at ${CONTACT_FALLBACK}.`;

const TOO_LARGE =
  "Your files were too large to send. Please keep each one under 10MB, or send them by email.";

const TOO_MANY_ATTEMPTS =
  "Too many attempts from this connection. Please wait a minute and try again.";

const SERVER_FAILURE =
  `Something went wrong on our end. Please try again shortly, or email us at ${CONTACT_FALLBACK}.`;

/**
 * True when the value is a string the SERVER wrote for a customer.
 *
 * Anything else — including a perfectly ordinary Error whose message came from
 * a browser API — is not customer copy and must not be shown.
 */
function isServerCopy(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 300;
}

/**
 * The message for a response we could not parse as JSON.
 *
 * A body-size rejection from the platform is the case that actually happens:
 * it arrives as HTML or as nothing at all, and calling .json() on it throws
 * the browser's own parse error rather than anything we wrote.
 */
export function messageForStatus(status: number, hadFiles: boolean): string {
  if (status === 413 || (status === 400 && hadFiles)) return TOO_LARGE;
  if (status === 429) return TOO_MANY_ATTEMPTS;
  if (status >= 500) return SERVER_FAILURE;
  return GENERIC_FAILURE;
}

/**
 * The message for a submission that threw before or instead of responding.
 *
 * `fetch` rejects with a TypeError for network failures — "Load failed" in
 * Safari, "Failed to fetch" in Chrome. Neither is worth showing, and neither
 * tells the customer the one useful thing, which is that it's worth retrying.
 */
export function messageForThrown(error: unknown, hadFiles: boolean): string {
  if (error instanceof TypeError) {
    // An upload cut off mid-flight looks exactly like a dropped connection,
    // and when files are attached the size is the likelier cause of the two.
    return hadFiles ? TOO_LARGE : NETWORK_FAILURE;
  }
  return GENERIC_FAILURE;
}

export interface ParsedResponse {
  ok: boolean;
  /** Present only on success. */
  ticketNumber?: number | null;
  /** Already customer-safe. */
  error?: string;
}

/**
 * Reads a response without letting its parsing failures escape.
 *
 * Deliberately reads text and parses by hand rather than calling
 * `response.json()`: that method throws the browser's parse error, and the
 * whole point here is that no browser string reaches a customer.
 */
export async function readSubmissionResponse(
  response: { ok: boolean; status: number; text: () => Promise<string> },
  hadFiles: boolean
): Promise<ParsedResponse> {
  let body: unknown = null;

  try {
    const text = await response.text();
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // Unparseable or unreadable. The status is the only thing left that
    // means anything.
    body = null;
  }

  const record = (body ?? {}) as Record<string, unknown>;

  if (!response.ok) {
    return {
      ok: false,
      error: isServerCopy(record.error)
        ? record.error
        : messageForStatus(response.status, hadFiles),
    };
  }

  // A 200 whose body we couldn't read is not a success we can report — we have
  // no ticket number and no idea whether it landed.
  if (body === null) {
    return { ok: false, error: GENERIC_FAILURE };
  }

  return {
    ok: true,
    ticketNumber:
      typeof record.ticket_number === "number" ? record.ticket_number : null,
  };
}
