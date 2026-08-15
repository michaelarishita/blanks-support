"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateDisplayName } from "@/app/(dashboard)/settings/actions";
import { FIELD_LIMITS } from "@/lib/fields";
import Button from "@/components/ui/Button";
import { FieldLabel, Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";

/**
 * The internal display name, kept deliberately apart from the Signature
 * panel. Putting "what the team calls you" next to "what customers see"
 * inside one form is how the two get conflated — which is the exact mistake
 * the split exists to prevent.
 */
export default function ProfileEditor({
  displayName,
  signatureName,
}: {
  displayName: string;
  signatureName: string;
}) {
  const [value, setValue] = useState(displayName);
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const differs = value.trim() !== signatureName.trim();

  function save() {
    startTransition(async () => {
      const res = await updateDisplayName(value);
      if (res?.error) toast(res.error, { tone: "error" });
      else {
        toast("Display name saved", { tone: "success" });
        router.refresh();
      }
    });
  }

  return (
    <div className="max-w-sm space-y-4">
      <FieldLabel
        label="Display name (internal)"
        htmlFor="display-name"
        hint="Shown in the inbox, thread and assignment list."
      >
        <Input
          id="display-name"
          value={value}
          maxLength={FIELD_LIMITS.name}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Mike"
        />
      </FieldLabel>

      <div className="rounded-md border border-subtle bg-gray-50 px-3 py-2 text-caption text-secondary">
        Customers see{" "}
        <span className="font-medium text-primary">{signatureName}</span> on your
        outbound email
        {differs && " — not the name above"}. Change that under{" "}
        <span className="font-medium">Signature</span>.
      </div>

      <Button
        variant="primary"
        onClick={save}
        loading={pending}
        disabled={!value.trim() || value.trim() === displayName.trim()}
      >
        Save display name
      </Button>
    </div>
  );
}
