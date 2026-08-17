import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
  // Thumbnails need the bytes rendered in place. The default is still a
  // download, so a click on the chip saves the file rather than navigating an
  // agent away into a raw image.
  const inline = new URL(request.url).searchParams.get("inline") === "1";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  // Read through the agent's client so RLS decides whether they may see it.
  const { data: attachment } = await supabase
    .from("attachments")
    .select("storage_path, filename")
    .eq("id", id)
    .maybeSingle();
  if (!attachment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("attachments")
    .createSignedUrl(
      attachment.storage_path,
      SIGNED_URL_TTL_SECONDS,
      // Content-Disposition: attachment is what makes a browser save rather
      // than render, so an <img> pointing here has to opt out of it.
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
