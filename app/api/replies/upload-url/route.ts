import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  ACCEPTED_DESCRIPTION,
  MAX_FILE_BYTES,
  MAX_OUTBOUND_FILES,
} from "@/lib/uploads/limits";
import { OUTBOUND_PREFIX, signUploadGrant } from "@/lib/uploads/grant";
import { recordGrantIssued } from "@/lib/uploads/ledger";

// ------------------------------------------------------------
// Mints signed upload URLs for an AGENT attaching files to an outbound reply,
// so the bytes go browser → Supabase directly and never through this function
// (the same 4.5MB platform limit that broke the widget applies here too — a
// shipping-label scan or two phone photos would exceed it).
//
// Unlike the public intake mint, this is session-authenticated: only a
// signed-in agent can mint, and the temp path lives under `outbound/`.
// ------------------------------------------------------------

export const dynamic = "force-dynamic";

/** Per-agent, generous — this is a trusted user picking a handful of files. */
const mintLimiter = createRateLimiter(30, 10 * 60_000);

interface RequestedFile {
  name: string;
  size: number;
}

function readRequested(body: unknown): RequestedFile[] | string {
  const files = (body as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0) return "No files requested.";
  if (files.length > MAX_OUTBOUND_FILES) {
    return `Please attach at most ${MAX_OUTBOUND_FILES} files.`;
  }

  const requested: RequestedFile[] = [];
  for (const entry of files) {
    const name = (entry as { name?: unknown })?.name;
    const size = (entry as { size?: unknown })?.size;
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      return `Please attach ${ACCEPTED_DESCRIPTION} files under 10MB.`;
    }
    // Declared size is a claim, re-checked against the real object on claim.
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
  // Session-authenticated: an anonymous caller cannot mint an outbound path.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (!mintLimiter.check(user.id)) {
    return NextResponse.json(
      { error: "Too many uploads just now — give it a moment." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const requested = readRequested(body);
  if (typeof requested === "string") {
    return NextResponse.json({ error: requested }, { status: 400 });
  }

  const admin = createAdminClient();
  const uploads: { grant: string; url: string; name: string }[] = [];

  for (const file of requested) {
    const path = `${OUTBOUND_PREFIX}${randomUUID()}`;
    const { data, error } = await admin.storage
      .from("attachments")
      .createSignedUploadUrl(path);
    if (error || !data?.signedUrl) {
      console.error("[replies/upload-url] could not sign:", error);
      return NextResponse.json(
        { error: "Could not prepare the upload. Please try again." },
        { status: 500 }
      );
    }

    await recordGrantIssued({
      storagePath: path,
      originalName: file.name,
      declaredBytes: file.size,
      ip: user.id, // the acting agent, for the ledger
    });

    uploads.push({
      grant: signUploadGrant(path, file.name),
      url: data.signedUrl,
      name: file.name,
    });
  }

  return NextResponse.json({ ok: true, uploads });
}
