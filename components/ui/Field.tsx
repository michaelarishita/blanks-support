"use client";

import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";
import { ChevronDownIcon } from "./icons";

const BASE =
  "w-full bg-panel text-body text-primary placeholder:text-tertiary " +
  "border border-subtle rounded-md " +
  "transition-colors duration-micro ease-out " +
  "hover:border-strong focus:border-brand-400 " +
  "disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-tertiary";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(BASE, "h-9 px-3", className)} {...props} />;
  }
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea ref={ref} className={cn(BASE, "resize-y px-3 py-2", className)} {...props} />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(BASE, "h-9 cursor-pointer appearance-none pl-3 pr-8", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tertiary"
      />
    </div>
  );
});

/** Label + optional hint/error wrapper, so form spacing is consistent. */
export function FieldLabel({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-label text-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-caption text-danger-text">{error}</p>
      ) : hint ? (
        <p className="text-caption text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}
