"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    /**
     * Built HERE, not during render, and that is a BUILD concern rather than
     * a style one.
     *
     * This page is statically prerendered, so anything in the component body
     * runs on the server at build time. `createClient()` throws when
     * NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY are absent, which made a missing
     * env var fail the whole production build — compile succeeds, export dies
     * on /login, four seconds, no deploy. That is a hard coupling between
     * shipping the app and a runtime secret, and it is the wrong direction:
     * a login page that renders and reports it cannot reach Supabase is
     * strictly better than a deploy that never lands and leaves stale code
     * serving customers.
     *
     * Constructing it in the handler means it only ever runs in a browser,
     * where the values are inlined and present.
     */
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setPending(false);
    if (error) {
      setError(
        error.message === "Invalid login credentials"
          ? "Wrong email or password."
          : error.message
      );
      return;
    }
    router.push("/inbox");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-6 text-center">
          <div className="text-xs font-semibold uppercase tracking-widest text-brand-600">
            Blanks Sports Nutrition
          </div>
          <h1 className="mt-1 text-2xl font-bold">Support Dashboard</h1>
        </div>

        <form onSubmit={signIn} className="space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@blankssportsnutrition.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none"
          />
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-brand-400 focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {error && <p className="mt-4 text-center text-sm text-red-600">{error}</p>}

        <p className="mt-6 text-center text-xs text-gray-400">
          Team accounts are created by an admin.
        </p>
      </div>
    </div>
  );
}
