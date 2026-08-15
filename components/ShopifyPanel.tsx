"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { searchShopify } from "@/app/shopify-actions";
import { shortAgo } from "@/lib/format";
import type { ShopifyOrder } from "@/lib/shopify/orders";
import { useShopify } from "@/components/ShopifyContext";
import Skeleton from "@/components/ui/Skeleton";
import { Input } from "@/components/ui/Field";
import Button from "@/components/ui/Button";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  SearchIcon,
} from "@/components/ui/icons";

function money(amount: string, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "—";
  return currency === "USD"
    ? `$${value.toFixed(2)}`
    : `${value.toFixed(2)} ${currency}`;
}

/** Shopify's own words, lightly tidied — never reinvented. */
function statusTone(order: ShopifyOrder): string {
  const status = (order.fulfillmentStatus ?? "").toUpperCase();
  if (status.includes("FULFILLED")) return "bg-success-bg text-success-text";
  if (status.includes("PARTIAL")) return "bg-warning-bg text-warning-text";
  if (status.includes("UNFULFILLED")) return "bg-gray-100 text-secondary";
  return "bg-gray-100 text-secondary";
}

function humanise(value: string | null): string {
  if (!value) return "Unknown";
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function OrderRow({ order, pinned }: { order: ShopifyOrder; pinned: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-sm border border-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors duration-micro ease-out hover:bg-gray-50"
      >
        <ChevronRightIcon
          size={12}
          className={cn(
            "flex-none text-tertiary transition-transform duration-micro ease-out",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="tnum text-label text-primary">{order.name}</span>
            {pinned && (
              <span className="rounded-[3px] bg-brand-50 px-1 text-[10px] font-semibold text-brand-800">
                THIS TICKET
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-caption text-tertiary">
            <span>{shortAgo(order.createdAt)} ago</span>
            <span>·</span>
            <span className="tnum">{money(order.total, order.currency)}</span>
          </span>
        </span>
        <span
          className={cn(
            "flex-none rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            statusTone(order)
          )}
        >
          {humanise(order.fulfillmentStatus)}
        </span>
      </button>

      {open && (
        <div className="animate-fade-in space-y-2 border-t border-subtle px-2.5 py-2">
          <dl className="space-y-1 text-caption">
            <div className="flex justify-between gap-2">
              <dt className="text-tertiary">Payment</dt>
              <dd className="text-secondary">{humanise(order.financialStatus)}</dd>
            </div>
            {order.trackingNumber && (
              <div className="flex justify-between gap-2">
                <dt className="text-tertiary">Tracking</dt>
                <dd className="min-w-0 truncate text-secondary">
                  {order.trackingCompany ? `${order.trackingCompany} ` : ""}
                  {order.trackingNumber}
                </dd>
              </div>
            )}
          </dl>

          <ul className="space-y-0.5">
            {order.lineItems.map((item, i) => (
              <li key={i} className="flex gap-2 text-caption text-secondary">
                <span className="tnum flex-none text-tertiary">{item.quantity}×</span>
                <span className="min-w-0">
                  {item.title}
                  {item.variantTitle && item.variantTitle !== "Default Title" && (
                    <span className="text-tertiary"> · {item.variantTitle}</span>
                  )}
                </span>
              </li>
            ))}
            {order.lineItems.length === 0 && (
              <li className="text-caption text-tertiary">No line items returned.</li>
            )}
          </ul>

          <div className="flex flex-wrap gap-2 pt-0.5">
            {order.trackingUrl && (
              <a
                href={order.trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-caption font-medium text-brand-link hover:underline"
              >
                Track shipment
              </a>
            )}
            {order.adminUrl && (
              <a
                href={order.adminUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-caption font-medium text-brand-link hover:underline"
              >
                Open in Shopify
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ShopifyPanel({
  ticketOrderNumber,
}: {
  ticketOrderNumber: string | null;
}) {
  const { loading, configured, context, error, override } = useShopify();
  const [term, setTerm] = useState("");
  const [searching, startSearch] = useTransition();
  const [searchError, setSearchError] = useState<string | null>(null);
  const [foundOrder, setFoundOrder] = useState<ShopifyOrder | null>(null);

  function runSearch() {
    if (!term.trim()) return;
    setSearchError(null);
    setFoundOrder(null);
    startSearch(async () => {
      const result = await searchShopify(term);
      if (result.error) setSearchError(result.error);
      else if (result.context) override(result.context);
      else if (result.order) setFoundOrder(result.order);
    });
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (!configured) {
    return (
      <p className="text-caption text-tertiary">
        Shopify isn&apos;t connected. Add SHOPIFY_SHOP_DOMAIN and
        SHOPIFY_ADMIN_TOKEN to enable order context.
      </p>
    );
  }

  // Shopify being down degrades to a message; the rest of the ticket works.
  if (error) {
    return (
      <div className="flex items-start gap-1.5 rounded-sm border border-warning-border bg-warning-bg px-2.5 py-2 text-caption text-warning-text">
        <AlertTriangleIcon size={13} className="mt-0.5 flex-none" />
        <span>{error}</span>
      </div>
    );
  }

  const orders = context?.orders ?? [];

  return (
    <div className="space-y-2.5">
      {context?.found && (
        <div className="flex items-baseline justify-between gap-2 text-caption">
          <span className="min-w-0 truncate text-secondary">
            {context.customerName ?? context.customerEmail}
          </span>
          {context.lifetimeOrders !== null && (
            <span className="tnum flex-none text-tertiary">
              {context.lifetimeOrders} order
              {context.lifetimeOrders === 1 ? "" : "s"}
              {context.lifetimeSpend &&
                ` · ${money(context.lifetimeSpend, context.currency ?? "USD")}`}
            </span>
          )}
        </div>
      )}

      {orders.map((order) => (
        <OrderRow
          key={order.id}
          order={order}
          pinned={Boolean(
            ticketOrderNumber &&
              order.name.replace("#", "") === ticketOrderNumber.replace("#", "")
          )}
        />
      ))}

      {foundOrder && <OrderRow order={foundOrder} pinned={false} />}

      {context?.possiblyTruncated && (
        <p className="text-caption text-warning-text">
          Shopify reports {context.lifetimeOrders} orders but returned none —
          this store&apos;s app likely lacks <code>read_all_orders</code>, which
          hides anything older than 60 days.
        </p>
      )}

      {/* Not an error state: plenty of people write in from a different
          address than they ordered with. */}
      {!context?.found && !foundOrder && (
        <p className="text-caption text-tertiary">
          No Shopify customer found for this email.
        </p>
      )}

      <div className="flex gap-1.5 pt-0.5">
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          placeholder="Order # or email"
          className="h-8 text-caption"
          aria-label="Search Shopify by order number or email"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={runSearch}
          loading={searching}
          disabled={!term.trim()}
          iconOnly
          aria-label="Search Shopify"
        >
          <SearchIcon size={14} />
        </Button>
      </div>
      {searchError && <p className="text-caption text-danger-text">{searchError}</p>}
    </div>
  );
}
