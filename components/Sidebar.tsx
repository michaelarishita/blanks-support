"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/cn";
import type { Agent, TicketChannel } from "@/lib/types";
import { AGENT_PLACEHOLDER } from "@/lib/display";
import { CHANNEL_META } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import ChannelIcon from "@/components/ui/ChannelIcon";
import Tooltip from "@/components/ui/Tooltip";
import {
  Dropdown,
  DropdownItem,
  DropdownSeparator,
} from "@/components/ui/Dropdown";
import {
  ChevronDownIcon,
  InboxIcon,
  LogOutIcon,
  SettingsIcon,
  TagIcon,
  UserIcon,
  UsersIcon,
} from "@/components/ui/icons";

const VIEWS = [
  { key: "open", label: "Open", href: "/inbox?view=open", Icon: InboxIcon },
  { key: "mine", label: "My tickets", href: "/inbox?view=mine", Icon: UserIcon },
  {
    key: "unassigned",
    label: "Unassigned",
    href: "/inbox?view=unassigned",
    Icon: UsersIcon,
  },
  { key: "all", label: "All tickets", href: "/inbox?view=all", Icon: TagIcon },
  {
    key: "resolved",
    label: "Resolved",
    href: "/inbox?view=resolved",
    Icon: InboxIcon,
  },
];

const CHANNELS: TicketChannel[] = ["web_form", "email", "instagram", "messenger"];

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
      {children}
    </div>
  );
}

/** 32px nav row with a 2px amber rail when active. */
function NavRow({
  href,
  active,
  icon,
  label,
  count,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number | null;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-8 items-center gap-2.5 rounded-sm pl-2.5 pr-2",
        "transition-colors duration-micro ease-out",
        active
          ? "bg-brand-50 font-medium text-brand-900"
          : "text-secondary hover:bg-gray-100 hover:text-primary"
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand-500" />
      )}
      <span className={cn("flex-none", active ? "text-brand-700" : "text-tertiary")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-label">{label}</span>
      {count != null && count > 0 && (
        <span
          className={cn(
            "tnum flex-none rounded-full px-1.5 text-[11px] font-medium",
            active ? "text-brand-800" : "text-tertiary"
          )}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

export default function Sidebar({
  me,
  counts,
}: {
  me: Agent | null;
  counts: { open: number; mine: number; unassigned: number };
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const activeView = params.get("view") ?? "open";
  const activeChannel = params.get("channel");
  const onInbox = pathname === "/inbox";

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const countFor = (key: string) =>
    key === "open"
      ? counts.open
      : key === "mine"
        ? counts.mine
        : key === "unassigned"
          ? counts.unassigned
          : null;

  return (
    <aside className="flex w-[232px] flex-none flex-col border-r border-subtle bg-panel">
      <div className="px-4 pb-3 pt-4">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-brand-600">
          Blanks
        </div>
        <div className="text-title font-semibold leading-tight text-primary">
          Support
        </div>
      </div>

      <nav className="scrollbar-slim flex-1 overflow-y-auto px-2.5 pb-4">
        <GroupHeader>Views</GroupHeader>
        {VIEWS.map((v) => (
          <NavRow
            key={v.key}
            href={v.href}
            active={onInbox && activeView === v.key && !activeChannel}
            icon={<v.Icon />}
            label={v.label}
            count={countFor(v.key)}
          />
        ))}

        <GroupHeader>Channels</GroupHeader>
        {CHANNELS.map((c) => (
          <NavRow
            key={c}
            href={`/inbox?view=all&channel=${c}`}
            active={onInbox && activeChannel === c}
            icon={<ChannelIcon channel={c} />}
            label={CHANNEL_META[c].label}
          />
        ))}
      </nav>

      <div className="border-t border-subtle p-2">
        <Dropdown
          side="top"
          align="start"
          menuClassName="w-[210px]"
          trigger={(open) => (
            <span
              className={cn(
                "flex items-center gap-2.5 rounded-sm px-2 py-1.5",
                "transition-colors duration-micro ease-out",
                open ? "bg-gray-100" : "hover:bg-gray-100"
              )}
            >
              <Avatar
                name={me?.name ?? "?"}
                seed={me?.id}
                src={me?.avatar_url}
                size="md"
              />
              <span className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-label text-primary">
                    {me?.name ?? AGENT_PLACEHOLDER}
                  </span>
                  {me && !me.gmail_connected && (
                    <Tooltip content="Gmail not connected — email replies won't send">
                      <Badge tone="warning" dot className="px-1.5 py-0">
                        <span className="sr-only">Gmail not connected</span>
                      </Badge>
                    </Tooltip>
                  )}
                </span>
                <span className="block truncate text-caption capitalize text-tertiary">
                  {me?.role ?? ""}
                </span>
              </span>
              <ChevronDownIcon
                size={14}
                className={cn(
                  "flex-none text-tertiary transition-transform duration-micro ease-out",
                  open && "rotate-180"
                )}
              />
            </span>
          )}
        >
          {(close) => (
            <>
              <DropdownItem href="/settings" icon={<SettingsIcon />} onClick={close}>
                Settings
              </DropdownItem>
              <DropdownSeparator />
              <DropdownItem icon={<LogOutIcon />} onClick={signOut}>
                Sign out
              </DropdownItem>
            </>
          )}
        </Dropdown>
      </div>
    </aside>
  );
}
