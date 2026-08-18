/**
 * Browser half of the direct-to-storage upload.
 *
 * Runs in the widget, so it must stay free of anything server-only — no
 * crypto, no sniffer, no strippers. It knows how to ask for a signed URL and
 * how to PUT bytes at one, and nothing else.
 */

import { GENERIC_FAILURE, messageForStatus } from "@/lib/widget-errors";

export interface MintedUpload {
  /** Signed proof we minted this path. Handed back with the form. */
  grant: string;
  /** Where the bytes go. */
  url: string;
  name: string;
}

export type MintResult =
  | { ok: true; uploads: MintedUpload[] }
  | { ok: false; error: string };

/** One entry is usable only if the server sent both halves of it. */
function readMinted(value: unknown): MintedUpload | null {
  const entry = value as Partial<MintedUpload> | null;
  if (!entry || typeof entry.grant !== "string" || typeof entry.url !== "string") {
    return null;
  }
  return {
    grant: entry.grant,
    url: entry.url,
    name: typeof entry.name === "string" ? entry.name : "attachment",
  };
}

/**
 * Asks the server for one signed URL per file. Small JSON both ways.
 *
 * Parses by hand rather than with `response.json()`, for the same reason the
 * form submit does: that method throws the browser's own parse error on a
 * non-JSON body, and in WebKit that reads "The string did not match the
 * expected pattern." — which is not something to show a customer.
 */
export async function requestUploadUrls(
  files: { name: string; size: number }[]
): Promise<MintResult> {
  let response: Response;
  try {
    response = await fetch("/api/tickets/intake/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: files.map((file) => ({ name: file.name, size: file.size })),
      }),
    });
  } catch {
    return { ok: false, error: GENERIC_FAILURE };
  }

  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }

  const record = (body ?? {}) as Record<string, unknown>;

  if (!response.ok) {
    const serverCopy =
      typeof record.error === "string" && record.error.length <= 300
        ? record.error
        : messageForStatus(response.status, true);
    return { ok: false, error: serverCopy };
  }

  const uploads = Array.isArray(record.uploads)
    ? record.uploads.map(readMinted).filter((u): u is MintedUpload => u !== null)
    : [];

  // One URL per file or none: a partial mint would silently drop an
  // attachment the customer watched themselves attach.
  if (uploads.length !== files.length) {
    return { ok: false, error: GENERIC_FAILURE };
  }

  return { ok: true, uploads };
}

/**
 * PUTs one file at its signed URL, reporting progress.
 *
 * XMLHttpRequest rather than fetch, for the one thing XHR still does better:
 * `upload.onprogress`. fetch has no upload progress at all, and a phone on
 * mobile data sending three photos needs the bar — a form that looks frozen
 * for twenty seconds gets abandoned, or worse, submitted again.
 */
export function putWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url, true);
    // Supabase stores whatever is declared here; the server re-sniffs the
    // bytes when the upload is claimed, so this is a convenience, not a claim
    // anyone acts on.
    request.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream"
    );

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      reject(new Error(`upload failed with status ${request.status}`));
    };
    request.onerror = () => reject(new Error("upload failed"));
    request.ontimeout = () => reject(new Error("upload timed out"));
    request.onabort = () => reject(new Error("upload cancelled"));

    signal?.addEventListener("abort", () => request.abort(), { once: true });

    request.send(file);
  });
}
