"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { disconnectAgent } from "@/lib/google/tokens";
import { deliverPendingMessages } from "@/lib/google/outbound";
import { updateCompanySettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { FIELD_LIMITS, absoluteUrl, hexColor, plainField } from "@/lib/fields";
import type { ActionResult } from "@/lib/types";

/** Resolves the caller, and their admin status, from the verified session. */
async function requireAgent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: me } = await supabase
    .from("agents")
    .select("id, role, is_active")
    .eq("id", user.id)
    .single();
  if (!me?.is_active) return null;

  return { supabase, id: me.id, isAdmin: me.role === "admin" };
}

export async function disconnectGmail() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated" };

  try {
    // An agent can only ever disconnect their own mailbox — the id comes from
    // the verified session, never from the client.
    await disconnectAgent(user.id);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not disconnect" };
  }

  revalidatePath("/settings");
  return { ok: true };
}

export interface FlushResult {
  error?: string;
  attempted: number;
  sent: number;
  failures: { ticketNumber: number | null; error: string }[];
}

const emptyFlush = (error: string): FlushResult => ({
  error,
  attempted: 0,
  sent: 0,
  failures: [],
});

/**
 * Retries every public reply still sitting in queued or failed state — the
 * Phase 1 backlog, plus anything a later outage left behind.
 */
export async function sendQueuedReplies(): Promise<FlushResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return emptyFlush("Not authenticated");

  // This sends mail on behalf of other agents, so keep it to admins.
  const { data: me } = await supabase
    .from("agents")
    .select("role, is_active")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin" || !me.is_active) {
    return emptyFlush("Only admins can send the queued backlog");
  }

  let result;
  try {
    result = await deliverPendingMessages();
  } catch (e) {
    return emptyFlush(
      e instanceof Error ? e.message : "Could not send queued replies"
    );
  }

  revalidatePath("/settings");
  revalidatePath("/inbox");
  return result;
}

/** Saves the signed-in agent's own signature fields. */
export async function updateSignature(input: {
  name: string;
  title: string;
  phone: string;
  signatureEnabled: boolean;
}): Promise<ActionResult> {
  const me = await requireAgent();
  if (!me) return { error: "Not authenticated" };

  const name = plainField(input.name, FIELD_LIMITS.name);
  if (!name) return { error: "Display name can't be empty" };

  // Writes go through the agent's own client — the agents_update_self policy
  // is what guarantees nobody can edit somebody else's signature.
  const { error } = await me.supabase
    .from("agents")
    .update({
      name,
      title: plainField(input.title, FIELD_LIMITS.title),
      phone: plainField(input.phone, FIELD_LIMITS.phone),
      signature_enabled: Boolean(input.signatureEnabled),
    })
    .eq("id", me.id);
  if (error) return { error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

/** Saves the shared company block. Admin only — it affects everyone's mail. */
export async function updateCompanyBrand(input: {
  companyName: string;
  website: string;
  websiteLabel: string;
  brandColor: string;
}): Promise<ActionResult> {
  const me = await requireAgent();
  if (!me) return { error: "Not authenticated" };
  if (!me.isAdmin) return { error: "Only admins can change company branding" };

  const companyName = plainField(input.companyName, FIELD_LIMITS.companyName);
  if (!companyName) return { error: "Company name can't be empty" };

  const color = hexColor(input.brandColor);
  if (input.brandColor && !color) {
    return { error: "Brand colour must be a hex value like #f5c518" };
  }

  const website = absoluteUrl(input.website, FIELD_LIMITS.website);
  if (input.website.trim() && !website) {
    return { error: "Website must be a valid URL" };
  }

  try {
    await updateCompanySettings(
      {
        company_name: companyName,
        website,
        website_label:
          plainField(input.websiteLabel, FIELD_LIMITS.websiteLabel) ??
          website?.replace(/^https?:\/\//, "") ??
          null,
        brand_color: color ?? "#f5c518",
      },
      me.id
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save" };
  }

  revalidatePath("/settings");
  return { ok: true };
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
// PNG and JPEG only. WebP and AVIF render inconsistently across mail clients,
// and SVG is a scripting vector that many clients strip outright.
const ALLOWED_LOGO_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
]);

/** Uploads the email logo to the public `brand` bucket. Admin only. */
export async function uploadBrandLogo(formData: FormData): Promise<ActionResult> {
  const me = await requireAgent();
  if (!me) return { error: "Not authenticated" };
  if (!me.isAdmin) return { error: "Only admins can upload the logo" };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose an image to upload" };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return { error: "Logo must be 2MB or smaller" };
  }

  const extension = ALLOWED_LOGO_TYPES.get(file.type);
  if (!extension) return { error: "Logo must be a PNG or JPEG" };

  // Intrinsic dimensions are measured in the browser and sent along, so the
  // email can carry explicit width/height without an image library here.
  const naturalWidth = Number(formData.get("width")) || 0;
  const naturalHeight = Number(formData.get("height")) || 0;

  // Cap the rendered width for email, preserving aspect ratio.
  const displayWidth = Math.min(naturalWidth || 240, 240);
  const displayHeight =
    naturalWidth && naturalHeight
      ? Math.round((naturalHeight / naturalWidth) * displayWidth)
      : null;

  const admin = createAdminClient();
  // Content-addressed-ish name so a replaced logo isn't served from a stale
  // CDN cache under the old URL.
  const path = `email-logo-${Date.now()}.${extension}`;

  const { error: uploadError } = await admin.storage
    .from("brand")
    .upload(path, file, { contentType: file.type, upsert: true });
  if (uploadError) {
    return {
      error: uploadError.message.includes("Bucket not found")
        ? "The `brand` storage bucket doesn't exist yet — run 0004_brand_storage.sql."
        : uploadError.message,
    };
  }

  const {
    data: { publicUrl },
  } = admin.storage.from("brand").getPublicUrl(path);

  try {
    await updateCompanySettings(
      { logo_url: publicUrl, logo_width: displayWidth, logo_height: displayHeight },
      me.id
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save the logo" };
  }

  revalidatePath("/settings");
  return { ok: true };
}

/** Clears the logo, reverting the signature to its text wordmark. */
export async function removeBrandLogo(): Promise<ActionResult> {
  const me = await requireAgent();
  if (!me) return { error: "Not authenticated" };
  if (!me.isAdmin) return { error: "Only admins can change the logo" };

  try {
    await updateCompanySettings({ logo_url: null, logo_height: null }, me.id);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not remove the logo" };
  }

  revalidatePath("/settings");
  return { ok: true };
}
