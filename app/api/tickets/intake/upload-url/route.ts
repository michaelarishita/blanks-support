import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { corsHeaders, isOriginAllowed } from "@/lib/cors";
import { createRateLimiter } from "@/lib/rate-limit";
import { ACCEPTED_DESCRIPTION, MAX_FILES, MAX_FILE_BYTES } from "@/lib/uploads/limits";
import { INTAKE_PREFIX, signUploadGrant } from "@/lib/uploads/grant";

// ------------------------------------------------------------
// Mints signed upload URLs so the browser can PUT files straight to Supabase
// Storage, without them passing through this function.
//
// THE WHOLE POINT: a Vercel serverless function rejects request bodies over
// 4.5MB at the platform level, before any of our code runs — so the intake
// route never saw three iPhone photos and never got the chance to. The "too
// large" message customers were getting was us mapping a 413 we did not
// cause and could not have prevented. Raising our own limit would have
// changed nothing.
//
// This route's body is a few hundred bytes of JSON, and the bytes go
// somewhere else entirely.
// ------------------------------------------------------------

/**
 * Same budget as an intake submission, because that is what it precedes: one
 * of these per attempt. It is separate module state from the intake route's
 * limiter, so the two do not consume each other's allowance.
 */
const mintLimiter = createRateLimiter(3, 10 * 60_000);

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

interface RequestedFile {
  name: string;
  size: number;
}

/** Reads the request into a shape, or explains why it can't. */
function readRequested(body: unknown): RequestedFile[] | string {
  const files = (body as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return "No files requested.";
  }
  if (files.length > MAX_FILES) {
    return `Please attach at most ${MAX_FILES} files.`;
  }

  const requested: RequestedFile[] = [];
  for (const entry of files) {
    const name = (entry as { name?: unknown })?.name;
    const size = (entry as { size?: unknown })?.size;

    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      return `Please attach ${ACCEPTED_DESCRIPTION} files under 10MB.`;
    }
    // The declared size is a claim, not a fact — it is checked again against
    // the stored object's real length when the upload is claimed. Refusing it
    // here just saves the customer a doomed 40MB upload.
    if (size > MAX_FILE_BYTES) {
      return `“${typeof name === "string" ? name : "That file"}” is too large — each file must be under 10MB.`;
    }

    requested.push({
      name: typeof name === "string" ? name.slice(0, 200) : "attachment",
      size,
    });
  }

  return requested;
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const CORS_HEADERS = corsHeaders(origin);

  if (!isOriginAllowed(origin)) {
    return NextResponse.json(
      { error: "Origin not allowed" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
  if (!mintLimiter.check(ip)) {
    console.warn(`[upload-url] rate limit hit from ${ip}`);
    return NextResponse.json(
      { error: "Too many uploads from this connection. Please try again shortly." },
      { status: 429, headers: CORS_HEADERS }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const requested = readRequested(body);
  if (typeof requested === "string") {
    console.warn(`[upload-url] refused from ${ip}: ${requested}`);
    return NextResponse.json(
      { error: requested },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const admin = createAdminClient();
  const uploads: { grant: string; url: string; name: string }[] = [];

  for (const file of requested) {
    // A random path, and NOT one derived from the filename: the path is the
    // only thing standing between one customer's upload and another's, so it
    // must not be guessable from anything the customer knows.
    const path = `${INTAKE_PREFIX}${randomUUID()}`;

    const { data, error } = await admin.storage
      .from("attachments")
      .createSignedUploadUrl(path);

    if (error || !data?.signedUrl) {
      console.error("[upload-url] could not sign:", error);
      return NextResponse.json(
        { error: "Could not prepare the upload. Please try again." },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    uploads.push({
      // The grant is what the customer hands back with the form. It proves we
      // minted this path; it does not prove anything about the contents,
      // which is why the claim step still sniffs and strips.
      grant: signUploadGrant(path, file.name),
      url: data.signedUrl,
      name: file.name,
    });
  }

  return NextResponse.json({ ok: true, uploads }, { headers: CORS_HEADERS });
}
