import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isInlineSafe } from "@/lib/attachments";

// Attachments live in a private bucket. This route checks the caller is a
// signed-in agent, then redirects to a short-lived signed URL, so the storage
// path itself is never a shareable link.

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_SECONDS = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // A REQUEST to render in place, not a decision. Whether it is honoured
  // depends on the stored type, checked below — the caller does not get to
  // choose that.
  const inlineRequested = new URL(request.url).searchParams.get("inline") === "1";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  // Read through the agent's client so RLS decides whether they may see it.
  const { data: attachment } = await supabase
    .from("attachments")
    .select("storage_path, filename, mime_type")
    .eq("id", id)
    .maybeSingle();
  if (!attachment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The server decides. Inline is allowed only for raster images we
  // identified by their bytes at ingest — never for HTML, SVG or PDF, each of
  // which executes script when a browser renders it, in the storage origin,
  // against whoever opened the ticket. Email accepts any file type on
  // purpose, so this is where that openness is made safe.
  const inline = inlineRequested && isInlineSafe(attachment.mime_type);

  if (inlineRequested && !inline) {
    console.warn(
      `[attachments] refused inline rendering of ${attachment.mime_type ?? "unknown"} (${id}) — served as a download`
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("attachments")
    .createSignedUrl(
      attachment.storage_path,
      SIGNED_URL_TTL_SECONDS,
      // `download` is what sets Content-Disposition: attachment. Omitting it
      // is the ONLY way a browser renders the bytes, so it is omitted only
      // for the allowlisted types above.
      inline ? {} : { download: attachment.filename }
    );

  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { error: error?.message ?? "Could not read attachment" },
      { status: 500 }
    );
  }

  return NextResponse.redirect(data.signedUrl);
}
