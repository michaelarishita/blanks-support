import Link from "next/link";
import Badge from "@/components/ui/Badge";
import ChannelIcon from "@/components/ui/ChannelIcon";
import Avatar from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";
import { shortAgo } from "@/lib/format";
import { agentDisplayName, customerDisplayName } from "@/lib/display";
import { STATUS_META } from "@/lib/types";
import {
  matchedInLabel,
  renderSnippet,
  type SearchRow,
} from "@/lib/search";

/**
 * A search result row carries enough to judge the ticket WITHOUT opening it:
 * number, subject, customer, status, assignee, date, and a snippet with the
 * matched terms highlighted. That is the point of searching bodies — you
 * recognise the reply you were after from the excerpt, not from the subject.
 */
function Snippet({ snippet }: { snippet: string | null }) {
  const segments = renderSnippet(snippet);
  if (!segments.length) return null;
  return (
    <p className="mt-1 line-clamp-2 text-caption text-secondary">
      {segments.map((seg, i) =>
        seg.highlight ? (
          // React escapes the text content, so raw customer markup in a body
          // can never execute here — the reason the snippet is delimited with
          // control characters rather than shipped as HTML from the database.
          <mark
            key={i}
            className="rounded-[2px] bg-amber-200/70 px-0.5 text-primary"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </p>
  );
}

export default function SearchResults({ rows }: { rows: SearchRow[] }) {
  return (
    <ul className="divide-y divide-subtle overflow-hidden rounded-lg border border-subtle bg-panel">
      {rows.map((row) => {
        const status = STATUS_META[row.status];
        const customer = customerDisplayName({
          name: row.customer_name,
          email: row.customer_email,
        });
        const assignee = row.assignee_id
          ? agentDisplayName({
              name: row.assignee_name,
              display_name: row.assignee_display_name,
            })
          : null;
        return (
          <li key={row.id}>
            <Link
              href={`/tickets/${row.id}`}
              className={cn(
                "flex flex-col gap-1 px-3 py-3 transition-colors duration-micro ease-out",
                "hover:bg-gray-50 sm:px-4"
              )}
            >
              <div className="flex items-center gap-2">
                <span className="flex-none text-tertiary">
                  <ChannelIcon channel={row.channel} />
                </span>
                <span className="min-w-0 flex-1 truncate text-body font-medium text-primary">
                  {row.subject}
                </span>
                <span className="tnum flex-none text-caption text-tertiary">
                  #{row.number}
                </span>
                {status && (
                  <Badge tone={status.tone} className="flex-none">
                    {status.label}
                  </Badge>
                )}
              </div>

              <Snippet snippet={row.snippet} />

              <div className="flex items-center gap-2 text-caption text-tertiary">
                <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary">
                  {matchedInLabel(row.matched_in)}
                </span>
                <span className="min-w-0 truncate text-secondary">{customer}</span>
                <span className="flex-1" />
                {assignee ? (
                  <span className="hidden items-center gap-1.5 sm:flex">
                    <Avatar name={assignee} seed={row.assignee_id} size="xs" />
                    <span className="max-w-[8rem] truncate">{assignee}</span>
                  </span>
                ) : (
                  <span className="hidden text-tertiary sm:inline">Unassigned</span>
                )}
                <time
                  dateTime={row.last_message_at}
                  className="flex-none tnum"
                >
                  {shortAgo(row.last_message_at)}
                </time>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
