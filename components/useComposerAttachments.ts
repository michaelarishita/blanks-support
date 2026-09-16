"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestUploadUrls, putWithProgress } from "@/lib/uploads/direct";
import {
  MAX_FILE_BYTES,
  MAX_OUTBOUND_FILES,
  MAX_OUTBOUND_TOTAL_BYTES,
  formatBytes,
} from "@/lib/uploads/limits";

/**
 * The composer's upload state machine — the widget's proven flow (two silent
 * retries, then a visible failure the agent must resolve), reused for outbound
 * replies. Uploads start on PICK and go browser → Supabase directly; the send
 * receives grants only. Kept as a hook so ReplyBox stays about composing.
 */

const UPLOAD_RETRIES = 2;
const UPLOAD_BACKOFF_MS = 400;
const REPLY_UPLOAD_ENDPOINT = "/api/replies/upload-url";

export interface ComposerUpload {
  id: number;
  file: File;
  progress: number;
  status: "uploading" | "done" | "failed";
  grant?: string;
  error?: string;
}

let nextId = 1;

export function useComposerAttachments() {
  const [items, setItems] = useState<ComposerUpload[]>([]);
  // Mirrors items so addFiles can compute remaining slots without a stale
  // closure and WITHOUT starting uploads inside a setState updater — which
  // React StrictMode double-invokes, and that would double-upload each file.
  const itemsRef = useRef<ComposerUpload[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const patch = useCallback((id: number, next: Partial<ComposerUpload>) => {
    setItems((current) => current.map((it) => (it.id === id ? { ...it, ...next } : it)));
  }, []);

  const upload = useCallback(
    async (item: ComposerUpload) => {
      // One signed URL for this file, then PUT with progress, retrying twice.
      for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt++) {
        try {
          const minted = await requestUploadUrls(
            [{ name: item.file.name, size: item.file.size }],
            REPLY_UPLOAD_ENDPOINT
          );
          if (!minted.ok) throw new Error(minted.error);
          const target = minted.uploads[0];
          await putWithProgress(target.url, item.file, (percent) =>
            patch(item.id, { progress: percent })
          );
          patch(item.id, { status: "done", progress: 100, grant: target.grant, error: undefined });
          return;
        } catch (e) {
          if (attempt === UPLOAD_RETRIES) {
            patch(item.id, {
              status: "failed",
              progress: 0,
              error: e instanceof Error ? e.message : "Upload failed",
            });
            return;
          }
          patch(item.id, { progress: 0 });
          await new Promise((r) => setTimeout(r, UPLOAD_BACKOFF_MS * (attempt + 1)));
        }
      }
    },
    [patch]
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const room = MAX_OUTBOUND_FILES - itemsRef.current.length;
      const accepted = files.slice(0, Math.max(0, room)).map((file) => {
        // A courtesy check; the server sniffs and enforces regardless.
        const tooBig = file.size > MAX_FILE_BYTES;
        return {
          id: nextId++,
          file,
          progress: 0,
          status: tooBig ? ("failed" as const) : ("uploading" as const),
          error: tooBig ? `Over ${formatBytes(MAX_FILE_BYTES)}` : undefined,
        };
      });
      if (!accepted.length) return;
      setItems((current) => [...current, ...accepted]);
      // Fire OUTSIDE the updater so a double-invoked updater can't double-upload.
      for (const item of accepted) if (item.status === "uploading") void upload(item);
    },
    [upload]
  );

  const retry = useCallback(
    (id: number) => {
      const item = itemsRef.current.find((it) => it.id === id);
      if (!item || item.file.size > MAX_FILE_BYTES) return;
      setItems((current) =>
        current.map((it) =>
          it.id === id ? { ...it, status: "uploading", progress: 0, error: undefined } : it
        )
      );
      void upload({ ...item, status: "uploading", progress: 0, error: undefined });
    },
    [upload]
  );

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((it) => it.id !== id));
  }, []);

  const reset = useCallback(() => setItems([]), []);

  const uploading = items.some((it) => it.status === "uploading");
  const hasFailed = items.some((it) => it.status === "failed");
  const totalBytes = items.reduce((sum, it) => sum + it.file.size, 0);
  const overCap = totalBytes > MAX_OUTBOUND_TOTAL_BYTES;
  const grants = useMemo(
    () => items.filter((it) => it.status === "done" && it.grant).map((it) => it.grant as string),
    [items]
  );

  return {
    items,
    addFiles,
    retry,
    remove,
    reset,
    uploading,
    hasFailed,
    overCap,
    totalBytes,
    grants,
    /** True when uploads are in a state that must block Send. */
    blockingSend: uploading || hasFailed || overCap,
    capMessage: overCap
      ? `Attachments total ${formatBytes(totalBytes)} — keep under ${formatBytes(
          MAX_OUTBOUND_TOTAL_BYTES
        )} per email.`
      : null,
  };
}
