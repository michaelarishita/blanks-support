"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import {
  Dropdown,
  DropdownItem,
  DropdownLabel,
} from "@/components/ui/Dropdown";
import { CheckIcon, ChevronDownIcon } from "@/components/ui/icons";

import { SORTS, type SortKey } from "@/lib/ticket-query";

export { SORTS };
export type { SortKey };

export default function InboxHeader({
  title,
  count,
  channelLabel,
  sort,
}: {
  title: string;
  count: number;
  channelLabel?: string | null;
  sort: SortKey;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setSort(next: SortKey) {
    const query = new URLSearchParams(params.toString());
    // "newest" is the default, so keep it out of the URL.
    if (next === "newest") query.delete("sort");
    else query.set("sort", next);
    router.push(`${pathname}?${query.toString()}`);
  }

  return (
    <div className="sticky top-0 z-20 -mx-6 mb-3 border-b border-subtle bg-surface/85 px-6 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <h1 className="text-title font-semibold text-primary">
          {title}
          {channelLabel && (
            <span className="font-normal text-tertiary"> · {channelLabel}</span>
          )}
        </h1>
        <span className="tnum rounded-full bg-gray-100 px-2 py-0.5 text-caption font-medium text-secondary">
          {count}
        </span>

        <div className="flex-1" />

        <Dropdown
          align="end"
          menuClassName="w-[190px]"
          trigger={(open) => (
            <span
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-sm border border-subtle bg-panel px-2.5",
                "text-caption font-medium text-secondary shadow-sm",
                "transition-colors duration-micro ease-out hover:border-strong hover:text-primary",
                open && "border-strong text-primary"
              )}
            >
              {SORTS[sort]}
              <ChevronDownIcon
                size={13}
                className={cn(
                  "transition-transform duration-micro ease-out",
                  open && "rotate-180"
                )}
              />
            </span>
          )}
        >
          {(close) => (
            <>
              <DropdownLabel>Sort by</DropdownLabel>
              {(Object.keys(SORTS) as SortKey[]).map((key) => (
                <DropdownItem
                  key={key}
                  onClick={() => {
                    setSort(key);
                    close();
                  }}
                  icon={
                    <span className={cn(key !== sort && "invisible")}>
                      <CheckIcon size={14} />
                    </span>
                  }
                >
                  {SORTS[key]}
                </DropdownItem>
              ))}
            </>
          )}
        </Dropdown>
      </div>
    </div>
  );
}
