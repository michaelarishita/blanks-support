"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateSignature } from "@/app/(dashboard)/settings/actions";
import { renderEmailHtml, type CompanySettings } from "@/lib/email/template";
import { FIELD_LIMITS } from "@/lib/fields";
import Button from "@/components/ui/Button";
import { FieldLabel, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";

const SAMPLE_BODY = `<p style="margin:0 0 12px 0;">Hey Sam,</p>
<p style="margin:0 0 12px 0;">Thanks for reaching out! Your order shipped this morning and should arrive in 2&ndash;3 days. I&rsquo;ve dropped the tracking link below.</p>
<p style="margin:0;">Let me know if there&rsquo;s anything else.</p>`;

export default function SignatureEditor({
  agent,
  company,
}: {
  agent: { name: string; title: string | null; phone: string | null; signature_enabled: boolean };
  company: CompanySettings;
}) {
  const [name, setName] = useState(agent.name ?? "");
  const [title, setTitle] = useState(agent.title ?? "");
  const [phone, setPhone] = useState(agent.phone ?? "");
  const [enabled, setEnabled] = useState(agent.signature_enabled !== false);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  // The preview calls the same renderer the send path uses, so what's on
  // screen is the email — not an approximation of it.
  const previewHtml = useMemo(
    () =>
      renderEmailHtml({
        bodyHtml: SAMPLE_BODY,
        agent: enabled ? { name: name || "Your name", title, phone } : null,
        company,
      }),
    [name, title, phone, enabled, company]
  );

  function save() {
    startTransition(async () => {
      const res = await updateSignature({
        name,
        title,
        phone,
        signatureEnabled: enabled,
      });
      if (res?.error) toast(res.error, { tone: "error" });
      else {
        toast("Signature saved", { tone: "success" });
        router.refresh();
      }
    });
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <FieldLabel label="Display name" htmlFor="sig-name">
          <Input
            id="sig-name"
            value={name}
            maxLength={FIELD_LIMITS.name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Michael Arishita"
          />
        </FieldLabel>

        <FieldLabel label="Title" htmlFor="sig-title" hint="Optional">
          <Input
            id="sig-title"
            value={title}
            maxLength={FIELD_LIMITS.title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Founder/CEO"
          />
        </FieldLabel>

        <FieldLabel label="Phone" htmlFor="sig-phone" hint="Optional">
          <Input
            id="sig-phone"
            value={phone}
            maxLength={FIELD_LIMITS.phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 555 123 4567"
          />
        </FieldLabel>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 h-4 w-4 flex-none accent-brand-500"
          />
          <span className="text-body text-secondary">
            Append signature to outbound emails
          </span>
        </label>

        <Button variant="primary" onClick={save} loading={pending}>
          Save signature
        </Button>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
          Live preview
        </div>
        {/* An iframe, so the email's own styles can't leak into the app (or
            inherit from it) and the preview matches a real client. */}
        <iframe
          title="Email preview"
          srcDoc={previewHtml}
          sandbox=""
          className="h-[420px] w-full rounded-md border border-subtle bg-white"
        />
      </div>
    </div>
  );
}
