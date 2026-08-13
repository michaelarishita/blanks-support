"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  removeBrandLogo,
  updateCompanyBrand,
  uploadBrandLogo,
} from "@/app/(dashboard)/settings/actions";
import type { CompanySettings } from "@/lib/email/template";
import { FIELD_LIMITS } from "@/lib/fields";
import Button from "@/components/ui/Button";
import { FieldLabel, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";

/** Reads a chosen image's intrinsic size so the email can set width/height. */
function measureImage(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      // Fall back to letting the server apply its default width.
      resolve({ width: 0, height: 0 });
    };
    image.src = url;
  });
}

export default function CompanyBrandEditor({
  company,
}: {
  company: CompanySettings;
}) {
  const [companyName, setCompanyName] = useState(company.company_name ?? "");
  const [website, setWebsite] = useState(company.website ?? "");
  const [websiteLabel, setWebsiteLabel] = useState(company.website_label ?? "");
  const [brandColor, setBrandColor] = useState(company.brand_color ?? "#f5c518");
  const [saving, startSave] = useTransition();
  const [uploading, startUpload] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const router = useRouter();

  function save() {
    startSave(async () => {
      const res = await updateCompanyBrand({
        companyName,
        website,
        websiteLabel,
        brandColor,
      });
      if (res?.error) toast(res.error, { tone: "error" });
      else {
        toast("Branding saved", { tone: "success" });
        router.refresh();
      }
    });
  }

  function upload(file: File) {
    startUpload(async () => {
      const { width, height } = await measureImage(file);
      const formData = new FormData();
      formData.set("file", file);
      formData.set("width", String(width));
      formData.set("height", String(height));

      const res = await uploadBrandLogo(formData);
      if (res?.error) toast(res.error, { tone: "error" });
      else {
        toast("Logo uploaded", { tone: "success" });
        router.refresh();
      }
      if (fileRef.current) fileRef.current.value = "";
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldLabel label="Company name" htmlFor="brand-name">
          <Input
            id="brand-name"
            value={companyName}
            maxLength={FIELD_LIMITS.companyName}
            onChange={(e) => setCompanyName(e.target.value)}
          />
        </FieldLabel>

        <FieldLabel label="Website" htmlFor="brand-website">
          <Input
            id="brand-website"
            value={website}
            maxLength={FIELD_LIMITS.website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://blankssportsnutrition.com"
          />
        </FieldLabel>

        <FieldLabel
          label="Website link text"
          htmlFor="brand-website-label"
          hint="Defaults to the domain"
        >
          <Input
            id="brand-website-label"
            value={websiteLabel}
            maxLength={FIELD_LIMITS.websiteLabel}
            onChange={(e) => setWebsiteLabel(e.target.value)}
            placeholder="blankssportsnutrition.com"
          />
        </FieldLabel>

        <FieldLabel label="Brand colour" htmlFor="brand-color" hint="Used for links in email">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "#f5c518"}
              onChange={(e) => setBrandColor(e.target.value)}
              aria-label="Pick brand colour"
              className="h-9 w-10 flex-none cursor-pointer rounded-md border border-subtle bg-panel p-1"
            />
            <Input
              id="brand-color"
              value={brandColor}
              maxLength={7}
              onChange={(e) => setBrandColor(e.target.value)}
              className="font-mono text-mono"
            />
          </div>
        </FieldLabel>
      </div>

      <div>
        <div className="mb-1.5 text-label text-secondary">Email logo</div>
        {company.logo_url ? (
          <div className="flex items-center gap-4">
            <div className="rounded-md border border-subtle bg-white p-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- remote
                  Supabase Storage URL; next/image would need host config. */}
              <img
                src={company.logo_url}
                alt="Current email logo"
                className="block h-10 w-auto max-w-[200px] object-contain"
              />
            </div>
            <div className="text-caption text-tertiary">
              Sent at {company.logo_width ?? 240}px wide
              {company.logo_height ? ` × ${company.logo_height}px` : ""}
            </div>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() =>
                startUpload(async () => {
                  const res = await removeBrandLogo();
                  if (res?.error) toast(res.error, { tone: "error" });
                  else {
                    toast("Logo removed", { tone: "success" });
                    router.refresh();
                  }
                })
              }
            >
              Remove
            </Button>
          </div>
        ) : (
          <p className="mb-2 text-caption text-tertiary">
            No logo yet — the signature ends with a text wordmark until one is
            uploaded.
          </p>
        )}

        <div className="mt-3 flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
            }}
            className="block w-full text-caption text-secondary file:mr-3 file:cursor-pointer file:rounded-sm file:border file:border-subtle file:bg-panel file:px-3 file:py-1.5 file:text-caption file:font-medium file:text-primary hover:file:bg-gray-50"
          />
          {uploading && (
            <span className="flex-none text-caption text-tertiary">Uploading…</span>
          )}
        </div>
        <p className="mt-1.5 text-caption text-tertiary">
          PNG or JPEG, up to 2MB. Scaled to 240px wide in email. SVG and WebP
          aren&apos;t accepted — mail clients handle them inconsistently.
        </p>
      </div>

      <Button variant="primary" onClick={save} loading={saving}>
        Save branding
      </Button>
    </div>
  );
}
