import WidgetForm from "@/components/WidgetForm";
import { allowedOrigins } from "@/lib/cors";
import { PARENT_ORIGIN_PARAM, resolveParentOrigin } from "@/lib/widget-frame";

// Server shell for the customer support form.
//
// It exists to do one thing the form can't: resolve the parent origin against
// the allowlist. WIDGET_ALLOWED_ORIGINS is server-only (not NEXT_PUBLIC_), so
// the list has to be read here and handed down.
//
// Resolving it on the SERVER also means the framed layout is in the first
// paint rather than applied after hydration — no flash of the tall centred
// standalone layout inside a 380px panel.
export default async function WidgetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Same list as the CORS allowlist, and deliberately so: "origins we trust"
  // is one idea here, whether they are calling the intake endpoint or framing
  // the form.
  const allowed = allowedOrigins();
  const parentOrigin = resolveParentOrigin(
    params[PARENT_ORIGIN_PARAM],
    allowed
  );

  return (
    <WidgetForm parentOrigin={parentOrigin} allowedParents={allowed} />
  );
}
