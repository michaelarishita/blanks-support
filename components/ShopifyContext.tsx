"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { fetchOrderContext } from "@/app/shopify-actions";
import type { ShopifyCustomerContext, ShopifyOrder } from "@/lib/shopify/orders";

/**
 * Fetches Shopify order context ONCE per ticket view and shares it.
 *
 * Both the sidebar and the composer's macros need this data. Fetching in each
 * of them would double the cost against Shopify's rate limit for no benefit —
 * "never fetch in a loop per ticket render" is the constraint that shaped
 * this.
 *
 * Loading is asynchronous on purpose: the thread must render immediately, and
 * Shopify being slow or down must degrade to a message rather than a blocked
 * page.
 */
export interface ShopifyState {
  loading: boolean;
  configured: boolean;
  context: ShopifyCustomerContext | null;
  error: string | null;
  /** The order a macro should use: the pinned one, else the most recent. */
  primaryOrder: ShopifyOrder | null;
  reload: () => void;
  /** Lets the manual search replace what the panel and macros see. */
  override: (context: ShopifyCustomerContext) => void;
}

const Context = createContext<ShopifyState>({
  loading: false,
  configured: false,
  context: null,
  error: null,
  primaryOrder: null,
  reload: () => {},
  override: () => {},
});

export function useShopify() {
  return useContext(Context);
}

export function ShopifyProvider({
  email,
  orderNumber,
  children,
}: {
  email: string | null;
  orderNumber: string | null;
  children: ReactNode;
}) {
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [context, setContext] = useState<ShopifyCustomerContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // Nothing to look up without an email or an order number.
    if (!email && !orderNumber) return;
    setLoading(true);
    setError(null);
    fetchOrderContext(email, orderNumber)
      .then((result) => {
        setConfigured(result.configured);
        setContext(result.context ?? null);
        setError(result.error ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Lookup failed"))
      .finally(() => setLoading(false));
  }, [email, orderNumber]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Context.Provider
      value={{
        loading,
        configured,
        context,
        error,
        primaryOrder: context?.orders[0] ?? null,
        reload: load,
        override: (next) => {
          setContext(next);
          setError(null);
          setConfigured(true);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
