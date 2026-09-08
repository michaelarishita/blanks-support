"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { SearchIcon, XIcon } from "@/components/ui/icons";

/**
 * Filter the All-tickets list by sender — name or email.
 *
 * It COMBINES with the existing status/channel filters rather than replacing
 * them: whatever else is in the URL is preserved, and only `sender` is set or
 * cleared. Matching a name that two customer records share follows the person
 * across both addresses; it does not pretend two unrelated addresses are the
 * same customer when the database does not relate them.
 */
export default function SenderFilter({ initial = "" }: { initial?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(initial);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  function apply(next: string) {
    const query = new URLSearchParams(params.toString());
    query.set("view", "all");
    const term = next.trim();
    if (term) query.set("sender", term);
    else query.delete("sender");
    router.push(`${pathname}?${query.toString()}`);
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        apply(value);
      }}
      className={cn(
        "flex h-9 w-full max-w-xs items-center gap-2 rounded-md border border-subtle bg-panel px-2.5",
        "focus-within:border-strong"
      )}
    >
      <SearchIcon size={15} className="flex-none text-tertiary" />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Filter by sender…"
        aria-label="Filter by sender name or email"
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-body text-primary placeholder:text-tertiary focus:outline-none"
      />
      {initial && (
        <button
          type="button"
          aria-label="Clear sender filter"
          onClick={() => {
            setValue("");
            apply("");
          }}
          className="flex-none rounded-sm p-0.5 text-tertiary hover:text-secondary"
        >
          <XIcon size={14} />
        </button>
      )}
    </form>
  );
}
