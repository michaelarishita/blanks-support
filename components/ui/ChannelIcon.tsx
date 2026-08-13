import type { TicketChannel } from "@/lib/types";
import { CHANNEL_META } from "@/lib/types";
import {
  GlobeIcon,
  InstagramIcon,
  MailIcon,
  MessengerIcon,
} from "./icons";

const ICONS = {
  web_form: GlobeIcon,
  email: MailIcon,
  instagram: InstagramIcon,
  messenger: MessengerIcon,
} as const;

export default function ChannelIcon({
  channel,
  size = 16,
  className,
}: {
  channel: TicketChannel;
  size?: number;
  className?: string;
}) {
  const Glyph = ICONS[channel] ?? GlobeIcon;
  return (
    <Glyph
      size={size}
      className={className}
      role="img"
      aria-label={CHANNEL_META[channel]?.label ?? channel}
    />
  );
}
