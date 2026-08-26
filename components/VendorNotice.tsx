import { VENDOR_LABEL, type VendorReason } from "@/lib/vendor/outreach";
import { InfoIcon } from "@/components/ui/icons";

/**
 * The vendor-outreach notice.
 *
 * Quieter than RiskNotice on purpose — grey, not red, and no dismiss button.
 * It is describing a guess about the SENDER's intent, not asking anybody to
 * be careful with a customer, and the honest register for a low-confidence
 * classification is a note rather than a warning.
 *
 * The wording is "Likely vendor outreach", never "spam". Sponsorship and
 * wholesale enquiries read exactly like this and are the business; an agent
 * who sees "spam" on one of them is being told to close it.
 *
 * INTERNAL ONLY. Nothing here reaches the customer or an outbound email.
 */
export default function VendorNotice({ reasons }: { reasons: VendorReason[] }) {
  if (!reasons.length) return null;

  return (
    <div className="flex items-start gap-2.5 border-b border-subtle bg-surface px-6 py-2.5">
      <span className="mt-0.5 flex-none text-tertiary">
        <InfoIcon size={14} />
      </span>
      <div className="min-w-0 flex-1 text-caption text-secondary">
        <span className="font-semibold text-primary">{VENDOR_LABEL}</span>
        {" — started at Low priority so it isn't competing with customers. "}
        <span className="text-tertiary">
          Nothing has been resolved or hidden, and this is a guess: change the
          priority if it&apos;s wrong.
        </span>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-tertiary">
          {reasons.map((reason) => (
            <li key={reason.code}>{reason.label}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
