"use client";

import { useEffect } from "react";

/** True when the user is typing, so a shortcut shouldn't steal the key. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export interface HotkeyOptions {
  /** Fire even while a field has focus (for Escape and ⌘↵-style combos). */
  allowInInput?: boolean;
  enabled?: boolean;
  preventDefault?: boolean;
}

/**
 * Binds single-key shortcuts on the document.
 *
 * Deliberately ignores any press carrying a modifier: the browser and OS own
 * ⌘/Ctrl/Alt combinations, and hijacking ⌘R to "reply" would be hostile.
 */
export function useHotkey(
  keys: string | string[],
  handler: (event: KeyboardEvent) => void,
  { allowInInput = false, enabled = true, preventDefault = true }: HotkeyOptions = {}
) {
  useEffect(() => {
    if (!enabled) return;
    const wanted = (Array.isArray(keys) ? keys : [keys]).map((k) => k.toLowerCase());

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!wanted.includes(event.key.toLowerCase())) return;
      if (!allowInInput && isEditableTarget(event.target)) return;

      if (preventDefault) event.preventDefault();
      handler(event);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keys, handler, allowInInput, enabled, preventDefault]);
}
