import type { SVGProps } from "react";

// Inline SVG icon set. Deliberately not emoji: emoji render differently on
// every OS, can't inherit currentColor, and read as unfinished.
// All icons are on a 16px grid, 1.5 stroke, and inherit color + size from
// the parent via `currentColor` and the `size` prop.

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/* ---------- Channels ---------- */

export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2a9 9 0 0 1 0 12M8 2a9 9 0 0 0 0 12" />
  </Icon>
);

export const MailIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
    <path d="m2.5 4.75 4.62 3.3a1.5 1.5 0 0 0 1.76 0l4.62-3.3" />
  </Icon>
);

export const InstagramIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2" width="12" height="12" rx="3.5" />
    <circle cx="8" cy="8" r="2.75" />
    <circle cx="11.4" cy="4.6" r="0.65" fill="currentColor" stroke="none" />
  </Icon>
);

export const MessengerIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 1.75c-3.5 0-6.25 2.6-6.25 5.9 0 1.85.87 3.48 2.25 4.55v2.05l2.08-1.14c.61.17 1.25.26 1.92.26 3.5 0 6.25-2.6 6.25-5.72S11.5 1.75 8 1.75Z" />
    <path d="m4.6 9.15 2.55-2.7 1.4 1.45 2.35-1.45-2.5 2.7-1.4-1.45-2.4 1.45Z" />
  </Icon>
);

/* ---------- Status / delivery ---------- */

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3 8.5 3.2 3.2L13 4.9" />
  </Icon>
);

export const CheckDoubleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m1.5 8.4 2.8 2.8 5.6-5.9M7.4 11.1l.5.5 5.7-6" />
  </Icon>
);

export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.6V8l2.2 1.6" />
  </Icon>
);

export const AlertTriangleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7.13 2.6 1.9 11.5a1 1 0 0 0 .87 1.5h10.46a1 1 0 0 0 .87-1.5L8.87 2.6a1 1 0 0 0-1.74 0Z" />
    <path d="M8 6.2v2.6M8 10.9h.01" />
  </Icon>
);

/** Neutral note, for advisory copy that is not a warning. */
export const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.4v3.4M8 5.3h.01" />
  </Icon>
);

export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5" />
    <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
  </Icon>
);

/* ---------- Navigation / chrome ---------- */

export const InboxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 9.5h3l1 2h4l1-2h3" />
    <path d="M3.4 3h9.2l1.4 6.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3L3.4 3Z" />
  </Icon>
);

export const UserIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="5.5" r="2.75" />
    <path d="M2.75 13.5a5.25 5.25 0 0 1 10.5 0" />
  </Icon>
);

export const UsersIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6.2" cy="5.5" r="2.5" />
    <path d="M1.75 13.2a4.5 4.5 0 0 1 8.9 0M10.6 3.3a2.5 2.5 0 0 1 0 4.4M12.1 9.4a4.5 4.5 0 0 1 2.15 3.8" />
  </Icon>
);

export const TagIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7.3 2H3a1 1 0 0 0-1 1v4.3a1 1 0 0 0 .3.7l6 6a1 1 0 0 0 1.4 0l4.3-4.3a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-.7-.3Z" />
    <circle cx="5.4" cy="5.4" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M12.9 9.9a1.1 1.1 0 0 0 .22 1.22l.04.04a1.35 1.35 0 1 1-1.9 1.9l-.05-.04a1.1 1.1 0 0 0-1.86.78v.11a1.35 1.35 0 1 1-2.7 0v-.06a1.1 1.1 0 0 0-1.93-.73l-.04.04a1.35 1.35 0 1 1-1.9-1.9l.03-.05a1.1 1.1 0 0 0-.78-1.86h-.1a1.35 1.35 0 1 1 0-2.7h.05a1.1 1.1 0 0 0 .73-1.93l-.04-.04a1.35 1.35 0 1 1 1.9-1.9l.05.03a1.1 1.1 0 0 0 1.22.22h.08a1.1 1.1 0 0 0 .67-1v-.11a1.35 1.35 0 1 1 2.7 0v.06a1.1 1.1 0 0 0 1.86.78l.04-.04a1.35 1.35 0 1 1 1.9 1.9l-.03.05a1.1 1.1 0 0 0 .22 1.22v.08a1.1 1.1 0 0 0 1 .67h.11a1.35 1.35 0 1 1 0 2.7h-.06a1.1 1.1 0 0 0-1 .67Z" />
  </Icon>
);

export const LogOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6M10.2 11 13.5 8l-3.3-3M13.5 8H6" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7.2" cy="7.2" r="4.7" />
    <path d="m10.7 10.7 3 3" />
  </Icon>
);

export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 6.2 4 4 4-4" />
  </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6.2 4 4 4-4 4" />
  </Icon>
);

export const ArrowLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 8H3M6.8 3.8 2.6 8l4.2 4.2" />
  </Icon>
);

export const MoreHorizontalIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="3.4" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.6" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);

export const XIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3.8 3.8 8.4 8.4M12.2 3.8l-8.4 8.4" />
  </Icon>
);

export const CopyIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.75" y="5.75" width="8" height="8" rx="1.5" />
    <path d="M3.4 10.25H3a.75.75 0 0 1-.75-.75V3a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 .75.75v.4" />
  </Icon>
);

export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.6 6.9a5.75 5.75 0 0 0-10.2-2.2M2.4 9.1a5.75 5.75 0 0 0 10.2 2.2" />
    <path d="M13.4 2.6v4.3h-4.3M2.6 13.4V9.1h4.3" />
  </Icon>
);

export const KeyboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
    <path d="M4.3 6.6h.01M6.8 6.6h.01M9.3 6.6h.01M11.8 6.6h.01M5 9.4h6" />
  </Icon>
);

export const PaperclipIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 7.4 8.1 12.3a3.1 3.1 0 0 1-4.4-4.4l5.2-5.2a2.06 2.06 0 0 1 2.9 2.9l-5 5a1 1 0 0 1-1.5-1.5l4.5-4.5" />
  </Icon>
);

export const ZapIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.9 1.6 3.2 8.6h4.1l-.9 5.8 5.7-7h-4.1l.9-5.8Z" />
  </Icon>
);

export const SnoozeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8.6" r="5.4" />
    <path d="M6.4 6.9h3.2L6.4 10.3h3.2" />
  </Icon>
);

/* ---------- Composer formatting ---------- */

export const BoldIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 2.5h4.1a2.75 2.75 0 0 1 0 5.5H4.5zM4.5 8h4.6a2.75 2.75 0 0 1 0 5.5H4.5z" />
  </Icon>
);

export const ItalicIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.5 2.5h-4M9.5 13.5h-4M9.5 2.5l-3 11" />
  </Icon>
);

export const UnderlineIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.2 2.5v4.9a3.8 3.8 0 0 0 7.6 0V2.5M3.6 13.5h8.8" />
  </Icon>
);

export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.7 8.9a2.6 2.6 0 0 0 3.9.3l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
    <path d="M9.3 7.1a2.6 2.6 0 0 0-3.9-.3L3.8 8.4a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
  </Icon>
);

export const ListBulletIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4.2h8M6 8h8M6 11.8h8" />
    <circle cx="3" cy="4.2" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3" cy="11.8" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const ListNumberedIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 4.2h7.5M6.5 8H14M6.5 11.8H14" />
    <path d="M2 2.9h1v2.6M1.9 8.1h1.9L1.9 10.4h2M1.9 11.4h2l-1.4 1.1 1.4 1.1h-2" strokeWidth={1.2} />
  </Icon>
);
