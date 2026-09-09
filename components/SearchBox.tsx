"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { useHotkey } from "@/lib/shortcuts";
import { SearchIcon, XIcon } from "@/components/ui/icons";

/**
 * The way into search, reachable by keyboard and by thumb.
 *
 * `/` focuses it from anywhere (the convention every inbox uses), and it is a
 * real form so Enter submits and the mobile keyboard shows a Search key. It
 * navigates to /search rather than filtering in place, because search spans
 * every view — resolved included — and is not a filter on the list you happen
 * to be looking at.
 */
export default function SearchBox({
  initialQuery = "",
  autoFocus = false,
  placeholder = "Search tickets…",
  className,
}: {
  initialQuery?: string;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the box in step when navigating between searches (the query in the
  // URL changed under us, e.g. Back).
  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  const focus = useCallback(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // `/` is the search accelerator. useHotkey already ignores it while a field
  // is focused, so it never steals the key mid-word.
  useHotkey("/", focus);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const q = value.trim();
    // An empty submit clears back to the resting search page rather than
    // querying for nothing.
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  }

  return (
    <form
      role="search"
      onSubmit={submit}
      className={cn(
        "flex h-9 items-center gap-2 rounded-md border border-subtle bg-surface px-2.5",
        "focus-within:border-strong",
        className
      )}
    >
      <SearchIcon size={15} className="flex-none text-tertiary" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Search tickets"
        autoFocus={autoFocus}
        // Native clear/autocorrect fight a search box; turn them off.
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-body text-primary placeholder:text-tertiary focus:outline-none"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setValue("");
            focus();
          }}
          className="flex-none rounded-sm p-0.5 text-tertiary hover:text-secondary"
        >
          <XIcon size={14} />
        </button>
      )}
    </form>
  );
}
