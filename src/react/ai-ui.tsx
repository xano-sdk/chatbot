/**
 * Shared pieces for the AI parts: the dialog (native <dialog>, focus returned on close), notices, the
 * progress line, and value formatting. shadcn theme tokens only, so light and dark both work.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import type { AiFieldInfo } from "./ai-client.js";
import { IconAlert, IconLock, IconSparkle, IconX } from "./icons.js";
import { cx } from "./ui.js";

const RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background";

/** A modal on the native <dialog>: Escape and the focus trap come from the browser; focus goes back where it was. */
export function AiDialog({ open, title, description, onClose, children, footer, busy, testId, wide }: {
  open: boolean; title: string; description?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode;
  busy?: boolean; testId?: string; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      d.showModal?.();
      if (!d.showModal) d.setAttribute("open", "");
    }
    if (!open && (d.open || d.hasAttribute("open"))) {
      d.close?.();
      d.removeAttribute("open");
      returnTo.current?.focus?.();
    }
  }, [open]);
  useEffect(() => () => { returnTo.current?.focus?.(); }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      data-testid={testId}
      className={cx(
        "m-auto w-[calc(100%-1.5rem)] rounded-xl border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50",
        wide ? "max-w-2xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] min-w-0 flex-col">
          <div className="flex items-start gap-3 border-b px-5 py-4">
            <div aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><IconSparkle width={14} height={14} /></div>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-base font-medium tracking-tight">{title}</h2>
              {description && <p id={descId} className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
            </div>
            <button type="button" aria-label="Close" onClick={onClose} disabled={busy}
              className={cx("-mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50", RING)}><IconX /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** A plain-words notice: an error (role=alert), a lock, or a quiet note. */
export function Notice({ tone = "note", children, action, testId }: { tone?: "error" | "lock" | "note"; children: ReactNode; action?: ReactNode; testId?: string }) {
  const Icon = tone === "lock" ? IconLock : IconAlert;
  return (
    <div role={tone === "error" ? "alert" : undefined} data-testid={testId}
      className={cx("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        tone === "error" ? "border-destructive/30 bg-destructive/5 text-foreground" : "bg-muted/40 text-muted-foreground")}>
      <Icon width={14} height={14} className={cx("mt-0.5", tone === "error" && "text-destructive")} />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** "Writing a draft…" with an indeterminate bar. Announced politely. */
export function Working({ label, onCancel }: { label: string; onCancel?: () => void }) {
  return (
    <div className="space-y-3 py-2" role="status" aria-live="polite" data-testid="ai-working">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2"><IconSparkle width={14} height={14} className="animate-pulse text-primary" />{label}</span>
        {onCancel && <button type="button" onClick={onCancel} className={cx("rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground", RING)}>Stop</button>}
      </div>
      <div aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full w-1/3 rounded-full bg-primary/70 motion-reduce:w-full motion-reduce:opacity-40" style={{ animation: "xs-ai-progress 1.2s ease-in-out infinite" }} />
      </div>
      <style>{"@keyframes xs-ai-progress{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}@media (prefers-reduced-motion:reduce){[style*=xs-ai-progress]{animation:none!important}}"}</style>
    </div>
  );
}

/** A small "Test mode" pill for stub answers. */
export const TestModeBadge = () => (
  <span title="The AI provider isn't set up here, so answers are placeholders." data-testid="ai-test-mode"
    className="inline-flex h-5 shrink-0 items-center rounded-full border border-dashed px-2 text-xs text-muted-foreground">Test mode</span>
);

export const fieldClass = cx("w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:opacity-60", RING);
export const ringClass = RING;

const dateFmt = typeof Intl !== "undefined" ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;

/** A field value as people read it. */
export function showValue(value: unknown, field?: AiFieldInfo): string {
  if (value === null || value === undefined || value === "") return "";
  if (field?.type === "bool") return value === true || value === "true" ? "Yes" : "No";
  if (field?.type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    return dateFmt && !Number.isNaN(d.getTime()) ? dateFmt.format(d) : value;
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Two values the same, after the server's normalisation (dates by day, numbers by value). */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === null || v === undefined || v === "" ? "" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : String(v));
  return norm(a) === norm(b);
}

/** "Title and Priority", "Title, Priority and Due date". */
export const listWords = (words: string[]) =>
  words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** Wraps `children` in a description of who can't do what (for a locked action). */
export const lockReason = (label: string) => `You can view suggestions, but you can't change this ${label}.`;

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-testid="ai-empty">{children}</div>;
}
