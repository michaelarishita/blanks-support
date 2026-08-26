"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ignoreSenderFromTicket } from "@/app/actions";
import { useToast } from "@/components/ui/Toast";

/**
 * "Never ticket this sender again", from the one screen where anybody
 * actually knows the answer.
 *
 * Two scopes, because cold outreach behaves in two ways. A single vendor
 * mailbox writing repeatedly is an ADDRESS; a sending platform that rotates
 * the local part every time — six addresses from one domain in a fortnight —
 * is a DOMAIN, and blocking the address there achieves nothing.
 *
 * Domain is not the default and is spelled out in full before it is clicked,
 * because @gmail.com is one careless click away from muting most of the
 * customer base.
 */
export default function IgnoreSender({
  ticketId,
  email,
}: {
  ticketId: string;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const domain = email.split("@").pop() ?? "";

  function ignore(scope: "address" | "domain") {
    startTransition(async () => {
      const res = await ignoreSenderFromTicket(ticketId, scope);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      setOpen(false);
      toast(`${res.value} won't create tickets any more`, { tone: "success" });
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2.5 text-caption text-tertiary underline-offset-2 transition-colors duration-micro ease-out hover:text-secondary hover:underline"
      >
        Never ticket this sender again
      </button>
    );
  }

  return (
    <div className="mt-2.5 rounded-md border border-subtle bg-surface p-2.5">
      <p className="text-caption text-secondary">
        Future mail is dropped before a ticket is created.{" "}
        <span className="text-tertiary">
          This ticket stays exactly as it is — nothing is deleted or resolved.
        </span>
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => ignore("address")}
          className="rounded-md border border-subtle px-2.5 py-1.5 text-left text-caption font-medium text-primary hover:bg-gray-100 disabled:opacity-50"
        >
          Just <span className="font-mono text-mono">{email}</span>
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => ignore("domain")}
          className="rounded-md border border-subtle px-2.5 py-1.5 text-left text-caption font-medium text-primary hover:bg-gray-100 disabled:opacity-50"
        >
          Everyone at <span className="font-mono text-mono">@{domain}</span>
          <span className="block text-tertiary">
            Including subdomains. Check this isn&apos;t a shared mail provider.
          </span>
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="self-start px-0.5 py-1 text-caption text-tertiary hover:text-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
