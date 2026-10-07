/**
 * The few primitives the frontend needs, built on native elements and styled with shadcn/ui's theme
 * tokens (`bg-background`, `text-muted-foreground`, `bg-primary`, `border`…), so they match any
 * shadcn/Tailwind app and its dark mode without importing the app's components.
 */
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Button({ variant = "default", icon = false, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost";
  /** A square icon-only button (give it an aria-label). */
  icon?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors [&_svg]:shrink-0",
        icon ? "size-8" : "h-8 px-3",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:pointer-events-none disabled:opacity-50",
        variant === "default" && "bg-primary text-primary-foreground hover:bg-primary/90",
        variant === "outline" && "border bg-background hover:bg-muted",
        variant === "ghost" && "hover:bg-muted",
        className,
      )}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        "h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:opacity-60",
        className,
      )}
    />
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cx("animate-pulse rounded-md bg-muted", className)} />;

/** A modal confirm on the native <dialog>: focus trap, Escape and backdrop come from the browser. */
export function ConfirmDialog({ open, title, children, confirmLabel, busy, onConfirm, onCancel }: {
  open: boolean; title: string; children: ReactNode; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }}
      aria-labelledby="chat-confirm-title"
      className="m-auto w-full max-w-md rounded-lg border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/50"
    >
      {open && (
        <div className="space-y-4">
          <h2 id="chat-confirm-title" className="text-lg font-semibold tracking-tight">{title}</h2>
          <div className="space-y-1 text-sm text-muted-foreground">{children}</div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button onClick={onConfirm} disabled={busy} data-testid="confirm-action">{busy ? "Saving…" : confirmLabel}</Button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** A status pill (h-5, rounded-full, caption size): neutral, quiet outline, the accent fill, or danger. */
export function Badge({ tone = "muted", children }: { tone?: "muted" | "strong" | "outline" | "danger"; children: ReactNode }) {
  return (
    <span className={cx(
      "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
      tone === "muted" && "bg-secondary text-secondary-foreground",
      tone === "strong" && "bg-primary text-primary-foreground",
      tone === "outline" && "border text-muted-foreground",
      tone === "danger" && "bg-destructive/12 text-destructive",
    )}>{children}</span>
  );
}

/** A plain modal (no confirm button) on the native <dialog>. */
export function Modal({ open, title, description, children, onClose, testId }: {
  open: boolean; title: string; description?: string; children: ReactNode; onClose: () => void; testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={title} data-testid={testId}
      className="m-auto w-full max-w-2xl rounded-lg border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/50">
      {open && (
        <div className="min-w-0 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
            <Button variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "3 hours ago", with the exact time on hover. */
export function Ago({ ms, className }: { ms: number | null | undefined; className?: string }) {
  if (!ms) return <span className={className}>Never</span>;
  const s = (ms - Date.now()) / 1000, a = Math.abs(s);
  const text = a < 60 ? "just now" : a < 3600 ? rtf.format(Math.round(s / 60), "minute") : a < 86400 ? rtf.format(Math.round(s / 3600), "hour") : rtf.format(Math.round(s / 86400), "day");
  return <time dateTime={new Date(ms).toISOString()} title={new Date(ms).toLocaleString()} className={className}>{text}</time>;
}

/** Copy to the clipboard and say so (or say how, when the browser refuses). */
export async function copyText(text: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return "Copied.";
  } catch {
    return "Copy failed. Select the text and copy it.";
  }
}
