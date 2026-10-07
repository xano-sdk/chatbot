/**
 * Inline AI on a record: `<AiActionMenu>` (the sparkle menu), `<AiSummary>`, `<DraftDialog>` and
 * `<ExtractDialog>`. They talk to `defineAiActions`' endpoints through `createAiClient`.
 *
 * Nothing here writes on its own: summaries and drafts are suggestions until the person applies them,
 * and the server checks every applied value again. Applies can be undone (or are sent for approval).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AiError, describeAiError, useAiInfo, type AiApplyResult, type AiClient, type AiFieldInfo, type AiRecordInfo, type AiRecordRef, type AiRunResult } from "./ai-client.js";
import { AiDialog, Empty, Notice, TestModeBadge, Working, fieldClass, listWords, lockReason, ringClass, sameValue, showValue } from "./ai-ui.js";
import { IconArrowRight, IconCheck, IconClipboard, IconCopy, IconLock, IconPencil, IconRefresh, IconSparkle, IconUndo } from "./icons.js";
import { Button, cx } from "./ui.js";

const asError = (e: unknown) => (e instanceof AiError ? e : new AiError(describeAiError(0).message, 0, "network"));
const isAbort = (e: unknown) => (e as { name?: string })?.name === "AbortError";
const NOT_CONNECTED_TEXT = "AI isn't connected yet. Ask an admin to add the AI provider key.";

/** The record type's info, and whether AI is usable for it at all. */
function useRecordInfo(client: AiClient, type: string) {
  const { info, error, loading, outdated, refresh } = useAiInfo(client);
  const rec: AiRecordInfo | undefined = info?.records?.[type];
  return { info, rec, error, loading, outdated, refresh, connected: info?.connected ?? true, stub: info?.provider === "stub" };
}

function useCopy() {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = (text: string) =>
    Promise.resolve(navigator.clipboard?.writeText(text)).then(() => setCopied("done"), () => setCopied("failed")).finally(() => {
      clearTimeout(t.current);
      t.current = setTimeout(() => setCopied("idle"), 1600);
    });
  return { copied, copy };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// <AiSummary>
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

export interface AiSummaryProps {
  client: AiClient;
  record: AiRecordRef;
  /** Summarise as soon as it mounts (the menu's dialog does). Default false: the person asks. */
  autoRun?: boolean;
  className?: string;
}

/** An inline summary: ask, read, regenerate, copy. Every state is handled in place. */
export function AiSummary({ client, record, autoRun, className }: AiSummaryProps) {
  const { rec, connected, error: infoError } = useRecordInfo(client, record.type);
  const [result, setResult] = useState<AiRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AiError | null>(null);
  const abort = useRef<AbortController | null>(null);
  const { copied, copy } = useCopy();
  const label = rec?.label ?? record.type;

  const run = useCallback(async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setError(null);
    try {
      const r = await client.summarise(record, ctl.signal);
      if (!ctl.signal.aborted) setResult(r);
    } catch (e) {
      if (!isAbort(e)) setError(asError(e));
    } finally {
      if (abort.current === ctl) setBusy(false);
    }
  }, [client, record.type, record.id]);
  useEffect(() => { if (autoRun && connected) void run(); return () => abort.current?.abort(); }, [record.type, record.id]);
  // A different record starts clean.
  useEffect(() => { setResult(null); setError(null); }, [record.type, record.id]);

  if (rec && !rec.read) return null;
  const text = result?.text ?? "";
  return (
    <section aria-label={`AI summary of this ${label}`} aria-busy={busy} data-testid="ai-summary"
      className={cx("rounded-lg border bg-card p-4 text-card-foreground", className)}>
      <div className="flex items-center gap-2">
        <IconSparkle width={14} height={14} className="text-primary" />
        <h3 className="text-sm font-medium">AI summary</h3>
        {result?.provider === "stub" && <TestModeBadge />}
        <div className="ml-auto flex items-center gap-0.5">
          {result && !busy && text && (
            <>
              <button type="button" onClick={() => void copy(text)} aria-label={copied === "done" ? "Copied" : "Copy summary"} title="Copy"
                className={cx("rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground", ringClass)} data-testid="ai-summary-copy">
                {copied === "done" ? <IconCheck width={14} height={14} /> : <IconCopy width={14} height={14} />}
              </button>
              <button type="button" onClick={() => void run()} aria-label="Regenerate summary" title="Regenerate"
                className={cx("rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground", ringClass)} data-testid="ai-summary-regenerate">
                <IconRefresh width={14} height={14} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="mt-2" aria-live="polite">
        {!connected ? (
          <Notice testId="ai-not-connected">{NOT_CONNECTED_TEXT}</Notice>
        ) : infoError && !result ? (
          <Notice tone="error" action={<Button variant="ghost" className="h-7" onClick={() => void run()}>Try again</Button>}>{infoError.message}</Notice>
        ) : busy && !result ? (
          <div className="space-y-2" data-testid="ai-summary-loading">
            <span className="sr-only">Summarising…</span>
            <div aria-hidden className="h-3.5 w-11/12 animate-pulse rounded bg-muted" />
            <div aria-hidden className="h-3.5 w-full animate-pulse rounded bg-muted" />
            <div aria-hidden className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        ) : error ? (
          <Notice tone="error" testId="ai-summary-error"
            action={error.kind !== "rate_limited" && error.kind !== "not_connected" ? <Button variant="ghost" className="h-7" onClick={() => void run()}>Try again</Button> : undefined}>
            {error.message}
          </Notice>
        ) : result && result.problem ? (
          <Notice tone="error" action={<Button variant="ghost" className="h-7" onClick={() => void run()}>Try again</Button>}>{result.problem}</Notice>
        ) : result ? (
          <>
            <p className={cx("text-sm whitespace-pre-wrap text-pretty transition-opacity", busy && "opacity-50")} data-testid="ai-summary-text">{text}</p>
            <p className="mt-2 text-xs text-muted-foreground">{copied === "failed" ? "Copy failed. Select the text and copy it." : "AI can make mistakes. Check it before you rely on it."}</p>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Get the gist of this {label} in a few sentences.</p>
            <Button variant="outline" onClick={() => void run()} data-testid="ai-summary-run"><IconSparkle width={14} height={14} />Summarise</Button>
          </div>
        )}
      </div>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// Applying, with undo
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

type Applied = { result: AiApplyResult; previous: Record<string, unknown>; labels: string[] };

function useApply(client: AiClient, record: AiRecordRef, onApplied?: (r: AiApplyResult) => void) {
  const [busy, setBusy] = useState<"apply" | "undo" | null>(null);
  const [error, setError] = useState<AiError | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [undone, setUndone] = useState(false);
  const apply = async (values: Record<string, unknown>, current: Record<string, unknown>, labels: string[]) => {
    setBusy("apply");
    setError(null);
    try {
      const result = await client.apply(record, values);
      // An empty field comes back as "" so an undo can clear it again.
      const previous = Object.fromEntries(Object.keys(values).map((k) => [k, current[k] ?? ""]));
      setApplied({ result, previous, labels });
      setUndone(false);
      onApplied?.(result);
      return true;
    } catch (e) {
      setError(asError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const undo = async () => {
    if (!applied) return;
    setBusy("undo");
    setError(null);
    try {
      const result = await client.apply(record, applied.previous);
      setUndone(true);
      onApplied?.(result);
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(null);
    }
  };
  const reset = () => { setApplied(null); setError(null); setUndone(false); };
  return { busy, error, applied, undone, apply, undo, reset, setError };
}

function AppliedPanel({ applied, undone, busy, onUndo, label, error }: {
  applied: Applied; undone: boolean; busy: boolean; onUndo: () => void; label: string; error: AiError | null;
}) {
  const pending = applied.result.status === "pending";
  return (
    <div className="space-y-3" data-testid="ai-applied" role="status" aria-live="polite">
      <div className="flex items-start gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <div aria-hidden className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"><IconCheck width={12} height={12} /></div>
        <div className="min-w-0 text-sm">
          {pending ? (
            <>
              <p className="font-medium">Sent for approval</p>
              <p className="text-muted-foreground">Nothing changes on this {label} until it's approved. You'll find it under Approvals.</p>
            </>
          ) : undone ? (
            <>
              <p className="font-medium">Undone</p>
              <p className="text-muted-foreground">{listWords(applied.labels)} {applied.labels.length === 1 ? "is" : "are"} back as before.</p>
            </>
          ) : (
            <>
              <p className="font-medium">Saved</p>
              <p className="text-muted-foreground">Updated {listWords(applied.labels)} on this {label}.</p>
            </>
          )}
        </div>
        {!pending && !undone && (
          <Button variant="ghost" className="ml-auto" onClick={onUndo} disabled={busy} data-testid="ai-undo"><IconUndo width={14} height={14} />{busy ? "Undoing…" : "Undo"}</Button>
        )}
      </div>
      {error && <Notice tone="error">{error.message}</Notice>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// <DraftDialog>
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

export interface DraftDialogProps {
  client: AiClient;
  record: AiRecordRef;
  /** The field to draft (one of the type's `draft` fields). */
  field: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the result after an apply (or an undo): refresh the record from `result.record`. */
  onApplied?: (result: AiApplyResult) => void;
  /** Starter instructions shown as chips. */
  suggestions?: string[];
}

const DRAFT_SUGGESTIONS = ["Make it shorter", "Make it friendlier", "Make it more formal", "Fix spelling and grammar"];

/** Instruction → draft (progress, stoppable) → edit → apply (or send for approval) → undo. */
export function DraftDialog({ client, record, field, open, onOpenChange, onApplied, suggestions = DRAFT_SUGGESTIONS }: DraftDialogProps) {
  const { info, rec, connected } = useRecordInfo(client, record.type);
  const [stub, setStub] = useState(false);
  const spec = rec?.fields.find((f) => f.name === field);
  const fieldLabel = spec?.label ?? field;
  const label = rec?.label ?? record.type;
  const max = spec?.max;
  const limit = info?.instruction_limit ?? 500;
  const [step, setStep] = useState<"compose" | "writing" | "review" | "done">("compose");
  const [instruction, setInstruction] = useState("");
  const [draft, setDraft] = useState("");
  const [current, setCurrent] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<AiError | null>(null);
  const abort = useRef<AbortController | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const ap = useApply(client, record, onApplied);
  const { copied, copy } = useCopy();

  useEffect(() => {
    if (!open) { abort.current?.abort(); return; }
    setStep("compose"); setError(null); setDraft(""); ap.reset();
    setTimeout(() => instructionRef.current?.focus(), 0);
  }, [open]);

  const write = async () => {
    const text = instruction.trim();
    if (!text || text.length > limit) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setStep("writing");
    setError(null);
    try {
      const r = await client.draft(record, field, text, ctl.signal);
      if (ctl.signal.aborted) return;
      if (r.problem) { setError(new AiError(r.problem, 200, "server")); setStep("compose"); return; }
      setDraft(r.text);
      setStub(r.provider === "stub");
      setCurrent(r.current);
      setStep("review");
      setTimeout(() => draftRef.current?.focus(), 0);
    } catch (e) {
      if (isAbort(e)) return;
      setError(asError(e));
      setStep("compose");
      setTimeout(() => instructionRef.current?.focus(), 0);
    }
  };
  const stop = () => { abort.current?.abort(); setStep("compose"); setTimeout(() => instructionRef.current?.focus(), 0); };
  const applyDraft = async () => {
    if (await ap.apply({ [field]: draft }, current, [fieldLabel])) setStep("done");
  };
  const close = () => { abort.current?.abort(); onOpenChange(false); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void write(); }
  };
  const tooLong = max !== undefined && draft.length > max;
  const canWrite = rec?.write ?? true;
  const approval = rec?.approval ?? false;

  const footer = step === "compose" ? (
    <>
      <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">⌘/Ctrl + Enter to write</span>
      <Button variant="outline" onClick={close}>Cancel</Button>
      <Button onClick={() => void write()} disabled={!connected || !instruction.trim() || instruction.length > limit} data-testid="ai-draft-write">
        <IconSparkle width={14} height={14} />Write draft
      </Button>
    </>
  ) : step === "review" ? (
    <>
      <Button variant="ghost" className="mr-auto" onClick={() => { setStep("compose"); setTimeout(() => instructionRef.current?.focus(), 0); }}>Back</Button>
      <Button variant="outline" onClick={() => void write()} disabled={!!ap.busy} data-testid="ai-draft-retry"><IconRefresh width={14} height={14} />Try again</Button>
      {canWrite ? (
        <Button onClick={() => void applyDraft()} disabled={!!ap.busy || !draft.trim() || tooLong} data-testid="ai-draft-apply">
          {ap.busy ? "Saving…" : approval ? "Send for approval" : `Use as ${fieldLabel.toLowerCase()}`}
        </Button>
      ) : (
        <Button onClick={() => void copy(draft)} data-testid="ai-draft-copy"><IconCopy width={14} height={14} />{copied === "done" ? "Copied" : "Copy draft"}</Button>
      )}
    </>
  ) : step === "done" ? <Button onClick={close} data-testid="ai-done">Done</Button> : null;

  return (
    <AiDialog open={open} onClose={close} busy={!!ap.busy} testId="ai-draft-dialog" footer={footer}
      title={`Draft ${fieldLabel.toLowerCase()}`}
      description={record.title ? <>For “{record.title}”</> : `For this ${label}`}>
      {!connected ? (
        <Notice testId="ai-not-connected">{NOT_CONNECTED_TEXT}</Notice>
      ) : step === "compose" ? (
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">What should it say?</span>
            <textarea ref={instructionRef} value={instruction} onChange={(e) => setInstruction(e.target.value)} onKeyDown={onKey} rows={3}
              maxLength={limit + 50} aria-invalid={instruction.length > limit} data-testid="ai-draft-instruction"
              placeholder="e.g. Thank them, confirm the refund, and say when it lands" className={cx(fieldClass, "resize-y")} />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => { setInstruction(s); instructionRef.current?.focus(); }}
                className={cx("rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground", ringClass)}>{s}</button>
            ))}
            <span className={cx("ml-auto text-xs tabular-nums", instruction.length > limit ? "text-destructive" : "text-muted-foreground")}>{instruction.length}/{limit}</span>
          </div>
          {!canWrite && <Notice tone="lock">{lockReason(label)} You can still copy the draft.</Notice>}
          {error && <Notice tone="error" testId="ai-draft-error">{error.message}</Notice>}
        </div>
      ) : step === "writing" ? (
        <div className="space-y-3">
          <p className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">“{instruction.trim()}”</p>
          <Working label="Writing a draft…" onCancel={stop} />
        </div>
      ) : step === "review" ? (
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="flex items-center gap-2 text-sm font-medium">Draft <span className="font-normal text-muted-foreground">— edit it before you use it</span>{stub && <TestModeBadge />}</span>
            <textarea ref={draftRef} value={draft} onChange={(e) => setDraft(e.target.value)} rows={9} data-testid="ai-draft-text"
              aria-invalid={tooLong} className={cx(fieldClass, "resize-y leading-relaxed")} />
          </label>
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>AI can make mistakes. Read it through.</span>
            {max !== undefined && <span className={cx("tabular-nums", tooLong && "text-destructive")}>{draft.length}/{max}</span>}
          </div>
          {showValue(current[field], spec) && (
            <details className="rounded-md border px-3 py-2 text-sm">
              <summary className={cx("cursor-pointer text-muted-foreground", ringClass)}>Current {fieldLabel.toLowerCase()}</summary>
              <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{showValue(current[field], spec)}</p>
            </details>
          )}
          {tooLong && <Notice tone="error">That's longer than {max} characters. Shorten it to use it.</Notice>}
          {!canWrite && <Notice tone="lock">{lockReason(label)}</Notice>}
          {ap.error && <Notice tone="error" testId="ai-apply-error">{ap.error.message}</Notice>}
        </div>
      ) : ap.applied ? (
        <AppliedPanel applied={ap.applied} undone={ap.undone} busy={ap.busy === "undo"} onUndo={() => void ap.undo()} label={label} error={ap.error} />
      ) : null}
    </AiDialog>
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// <ExtractDialog>
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

export interface ExtractDialogProps {
  client: AiClient;
  record: AiRecordRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied?: (result: AiApplyResult) => void;
}

/** Paste → read (progress, stoppable) → field-by-field current vs proposed, each with a checkbox → apply → undo. */
export function ExtractDialog({ client, record, open, onOpenChange, onApplied }: ExtractDialogProps) {
  const { info, rec, connected } = useRecordInfo(client, record.type);
  const label = rec?.label ?? record.type;
  const pasteLimit = info?.paste_limit ?? 8000;
  const fields = useMemo(() => (rec?.extract ?? []).map((n) => rec!.fields.find((f) => f.name === n)).filter(Boolean) as AiFieldInfo[], [rec]);
  const byName = (n: string) => rec?.fields.find((f) => f.name === n);
  const [step, setStep] = useState<"paste" | "reading" | "review" | "done">("paste");
  const [text, setText] = useState("");
  const [result, setResult] = useState<AiRunResult | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<AiError | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const ap = useApply(client, record, onApplied);

  useEffect(() => {
    if (!open) { abort.current?.abort(); return; }
    setStep("paste"); setError(null); setResult(null); ap.reset();
    setTimeout(() => pasteRef.current?.focus(), 0);
  }, [open]);

  const proposed = result ? fields.filter((f) => f.name in result.values) : [];
  const changes = proposed.filter((f) => !sameValue(result!.values[f.name], result!.current[f.name]));
  const chosen = changes.filter((f) => picked[f.name]);

  const read = async () => {
    if (!text.trim() || text.length > pasteLimit) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setStep("reading");
    setError(null);
    try {
      const r = await client.extract(record, text, ctl.signal);
      if (ctl.signal.aborted) return;
      setResult(r);
      setPicked(Object.fromEntries(Object.keys(r.values).map((k) => [k, !sameValue(r.values[k], r.current[k])])));
      setStep("review");
    } catch (e) {
      if (isAbort(e)) return;
      setError(asError(e));
      setStep("paste");
      setTimeout(() => pasteRef.current?.focus(), 0);
    }
  };
  const stop = () => { abort.current?.abort(); setStep("paste"); setTimeout(() => pasteRef.current?.focus(), 0); };
  const applyChosen = async () => {
    if (!result || !chosen.length) return;
    const values = Object.fromEntries(chosen.map((f) => [f.name, result.values[f.name]]));
    if (await ap.apply(values, result.current, chosen.map((f) => f.label))) setStep("done");
  };
  const close = () => { abort.current?.abort(); onOpenChange(false); };
  const canWrite = rec?.write ?? true;
  const approval = rec?.approval ?? false;
  const allOn = changes.length > 0 && chosen.length === changes.length;

  const footer = step === "paste" ? (
    <>
      <Button variant="outline" onClick={close}>Cancel</Button>
      <Button onClick={() => void read()} disabled={!connected || !text.trim() || text.length > pasteLimit} data-testid="ai-extract-read">
        <IconSparkle width={14} height={14} />Find fields
      </Button>
    </>
  ) : step === "review" ? (
    <>
      <Button variant="ghost" className="mr-auto" onClick={() => { setStep("paste"); setTimeout(() => pasteRef.current?.focus(), 0); }}>Back</Button>
      {canWrite && changes.length > 0 && (
        <Button onClick={() => void applyChosen()} disabled={!!ap.busy || !chosen.length} data-testid="ai-extract-apply">
          {ap.busy ? "Saving…" : `${approval ? "Send" : "Apply"} ${chosen.length} ${chosen.length === 1 ? "change" : "changes"}${approval ? " for approval" : ""}`}
        </Button>
      )}
    </>
  ) : step === "done" ? <Button onClick={close} data-testid="ai-done">Done</Button> : null;

  return (
    <AiDialog open={open} onClose={close} busy={!!ap.busy} testId="ai-extract-dialog" wide footer={footer}
      title="Fill fields from text"
      description={record.title ? <>Update “{record.title}” from an email, message or notes</> : `Update this ${label} from an email, message or notes`}>
      {!connected ? (
        <Notice testId="ai-not-connected">{NOT_CONNECTED_TEXT}</Notice>
      ) : step === "paste" ? (
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Paste the text</span>
            <textarea ref={pasteRef} value={text} onChange={(e) => setText(e.target.value)} rows={8} data-testid="ai-extract-text"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void read(); } }}
              aria-invalid={text.length > pasteLimit} placeholder="Paste an email, a chat message or meeting notes…" className={cx(fieldClass, "resize-y")} />
          </label>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Looks for</span>
            {fields.map((f) => <span key={f.name} className="rounded-full bg-muted px-2 py-0.5 text-foreground/80">{f.label}</span>)}
            <span className={cx("ml-auto tabular-nums", text.length > pasteLimit && "text-destructive")}>{text.length.toLocaleString()}/{pasteLimit.toLocaleString()}</span>
          </div>
          <p className="text-xs text-muted-foreground">Nothing changes until you review and apply.</p>
          {error && <Notice tone="error" testId="ai-extract-error">{error.message}</Notice>}
        </div>
      ) : step === "reading" ? (
        <Working label="Reading the text…" onCancel={stop} />
      ) : step === "review" && result ? (
        <div className="space-y-4">
          {result.problem ? (
            <Notice tone="error">{result.problem}</Notice>
          ) : proposed.length === 0 ? (
            <Empty>
              <p className="font-medium text-foreground">No fields found</p>
              <p className="mt-1">AI didn't find a {listWords(fields.map((f) => f.label.toLowerCase()))} in that text. Go back and paste a different part.</p>
            </Empty>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  {changes.length === 0 ? "Everything AI found already matches this " + label + "." : `AI suggests ${changes.length} ${changes.length === 1 ? "change" : "changes"}. Untick any you don't want.`}
                </p>
                {result.provider === "stub" && <TestModeBadge />}
              </div>
              <div role="table" aria-label="Suggested changes" className="overflow-hidden rounded-lg border" data-testid="ai-extract-diff">
                <div role="rowgroup" className="hidden border-b bg-muted/40 text-xs text-muted-foreground sm:block">
                  <div role="row" className="grid grid-cols-[2rem_8rem_1fr_1.25rem_1fr] items-center gap-2 px-3 py-2">
                    <span role="columnheader">
                      {canWrite && changes.length > 1 && (
                        <input type="checkbox" aria-label="Select all changes" checked={allOn}
                          onChange={() => setPicked(Object.fromEntries(changes.map((f) => [f.name, !allOn])))} className={cx("size-4 accent-primary", ringClass)} />
                      )}
                    </span>
                    <span role="columnheader">Field</span>
                    <span role="columnheader">Now</span>
                    <span aria-hidden />
                    <span role="columnheader">Suggested</span>
                  </div>
                </div>
                <div role="rowgroup">
                  {proposed.map((f) => {
                    const now = showValue(result.current[f.name], f);
                    const next = showValue(result.values[f.name], f);
                    const same = sameValue(result.values[f.name], result.current[f.name]);
                    const on = !same && !!picked[f.name];
                    return (
                      <div role="row" key={f.name} data-testid={`ai-extract-row-${f.name}`}
                        className={cx("grid grid-cols-[2rem_1fr] items-start gap-x-2 gap-y-1 border-b px-3 py-2.5 text-sm last:border-b-0 sm:grid-cols-[2rem_8rem_1fr_1.25rem_1fr] sm:items-center", on && "bg-primary/5")}>
                        <span role="cell" className="row-span-3 pt-0.5 sm:row-span-1 sm:pt-0">
                          {canWrite && (
                            <input type="checkbox" aria-label={`Apply ${f.label}`} checked={on} disabled={same || !!ap.busy}
                              onChange={(e) => setPicked((p) => ({ ...p, [f.name]: e.target.checked }))} className={cx("size-4 accent-primary", ringClass)} />
                          )}
                        </span>
                        <span role="rowheader" className="font-medium">{f.label}</span>
                        <span role="cell" className={cx("min-w-0 break-words text-muted-foreground", on && now && "line-through decoration-muted-foreground/50")}>
                          <span className="sr-only">Now: </span>{now || <span className="italic">Empty</span>}
                        </span>
                        <IconArrowRight aria-hidden width={14} height={14} className="hidden text-muted-foreground sm:block" />
                        <span role="cell" className="flex min-w-0 items-center gap-2 break-words">
                          <span className="sr-only">Suggested: </span>
                          <span className={cx(!same && "font-medium text-foreground")}>{next}</span>
                          {same && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">No change</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
          {result.dropped.length > 0 && (
            <details className="rounded-lg border px-3 py-2" open={result.dropped.length <= 3} data-testid="ai-extract-dropped">
              <summary className={cx("cursor-pointer text-sm text-muted-foreground", ringClass)}>
                {result.dropped.length} {result.dropped.length === 1 ? "suggestion wasn't" : "suggestions weren't"} used
              </summary>
              <ul className="mt-2 space-y-1.5">
                {result.dropped.map((d, i) => (
                  <li key={`${d.field}-${i}`} className="text-sm">
                    <span className="font-medium">{byName(d.field)?.label ?? d.field}</span>
                    {d.value && <span className="text-muted-foreground"> “{d.value}”</span>}
                    <span className="text-muted-foreground"> — {d.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!canWrite && proposed.length > 0 && <Notice tone="lock">{lockReason(label)}</Notice>}
          {ap.error && <Notice tone="error" testId="ai-apply-error">{ap.error.message}</Notice>}
        </div>
      ) : ap.applied ? (
        <AppliedPanel applied={ap.applied} undone={ap.undone} busy={ap.busy === "undo"} onUndo={() => void ap.undo()} label={label} error={ap.error} />
      ) : null}
    </AiDialog>
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// <AiActionMenu>
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

export interface AiActionMenuProps {
  client: AiClient;
  record: AiRecordRef;
  /** After an apply or an undo: refresh the record from `result.record`. */
  onApplied?: (result: AiApplyResult) => void;
  /** The button's text. Default "AI". Pass `null` for an icon-only button. */
  label?: string | null;
  className?: string;
}

type Item = { key: string; label: string; hint: string; icon: ReactNode; locked?: string; run: () => void };

/**
 * The sparkle menu for one record: Summarise, Draft <field>…, Fill fields from text…. Hidden when the
 * person can't use AI on this record type; locked items say why; "AI isn't connected" when there's no model.
 */
export function AiActionMenu({ client, record, onApplied, label = "AI", className }: AiActionMenuProps) {
  const { info, rec, connected, stub, loading, error, refresh } = useRecordInfo(client, record.type);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "summary" } | { kind: "draft"; field: string } | { kind: "extract" } | null>(null);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useRef(`ai-menu-${Math.random().toString(36).slice(2)}`).current;

  const close = (focus = true) => { setOpen(false); if (focus) button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (info && (!rec || !rec.read)) return null;
  const typeLabel = rec?.label ?? record.type;
  const writeLock = rec && !rec.write ? `You can't change this ${typeLabel}.` : undefined;
  const items: Item[] = rec ? [
    ...(rec.summarise ? [{ key: "summary", label: "Summarise", hint: `The gist of this ${typeLabel}`, icon: <IconSparkle width={14} height={14} />, run: () => setDialog({ kind: "summary" }) }] : []),
    ...rec.draft.map((name) => {
      const f = rec.fields.find((x) => x.name === name);
      return { key: `draft-${name}`, label: `Draft ${(f?.label ?? name).toLowerCase()}…`, hint: "Write it from an instruction", icon: <IconPencil width={14} height={14} />, locked: writeLock, run: () => setDialog({ kind: "draft", field: name }) };
    }),
    ...(rec.extract.length ? [{ key: "extract", label: "Fill fields from text…", hint: "Paste an email or notes", icon: <IconClipboard width={14} height={14} />, locked: writeLock, run: () => setDialog({ kind: "extract" }) }] : []),
  ] : [];
  // Drafting stays open to people who can't apply (they can copy); filling fields is pointless without write.
  const usable = (it: Item) => connected && !(it.locked && it.key === "extract");
  const enabled = items.map((it, i) => (usable(it) ? i : -1)).filter((i) => i >= 0);
  const focusItem = (i: number) => {
    setActive(i);
    setTimeout(() => menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[i]?.focus(), 0);
  };
  const openMenu = (at: "first" | "last" = "first") => {
    if (error) void refresh();
    setOpen(true);
    const target = at === "first" ? enabled[0] : enabled[enabled.length - 1];
    if (target !== undefined) focusItem(target);
    else setTimeout(() => menu.current?.focus(), 0);
  };
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openMenu("first"); }
    if (e.key === "ArrowUp") { e.preventDefault(); openMenu("last"); }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const pos = enabled.indexOf(active);
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") close(false);
    else if (e.key === "ArrowDown" && enabled.length) { e.preventDefault(); focusItem(enabled[(pos + 1) % enabled.length]!); }
    else if (e.key === "ArrowUp" && enabled.length) { e.preventDefault(); focusItem(enabled[(pos - 1 + enabled.length) % enabled.length]!); }
    else if (e.key === "Home" && enabled.length) { e.preventDefault(); focusItem(enabled[0]!); }
    else if (e.key === "End" && enabled.length) { e.preventDefault(); focusItem(enabled[enabled.length - 1]!); }
  };
  const choose = (it: Item) => { if (!usable(it)) return; setOpen(false); it.run(); };
  const left = info && info.limit.max > 0 ? Math.max(0, info.limit.max - info.limit.used) : null;
  const windowWords = info ? (info.limit.ttl === 3600 ? "this hour" : info.limit.ttl === 86400 ? "today" : "for now") : "";
  const endDialog = () => { setDialog(null); setTimeout(() => button.current?.focus(), 0); };

  return (
    <div className={cx("relative inline-flex", className)} data-testid="ai-menu">
      <button ref={button} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={label ? undefined : "AI actions"} aria-busy={loading} data-testid="ai-menu-button"
        onClick={() => (open ? close(false) : openMenu())} onKeyDown={onButtonKey}
        className={cx("inline-flex h-8 items-center gap-1.5 rounded-md border bg-background text-sm font-medium transition-colors hover:bg-muted", label ? "px-2.5" : "w-8 justify-center", ringClass)}>
        <IconSparkle width={14} height={14} className="text-primary" />{label}
      </button>
      {open && (
        <div ref={menu} id={menuId} role="menu" aria-label={`AI actions for this ${typeLabel}`} tabIndex={-1} onKeyDown={onMenuKey} data-testid="ai-menu-list"
          className="absolute top-full right-0 z-50 mt-1 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
          {!info && !error && (
            <div className="space-y-1 p-1" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />)}</div>
          )}
          {error && !info && <div className="p-1"><Notice tone="error">{error.message}</Notice></div>}
          {info && !connected && <div className="p-1" data-testid="ai-not-connected"><Notice>{NOT_CONNECTED_TEXT}</Notice></div>}
          {items.map((it, i) => {
            const can = usable(it);
            return (
              <button key={it.key} type="button" role="menuitem" tabIndex={i === active ? 0 : -1} aria-disabled={!can || undefined}
                data-testid={`ai-menu-${it.key}`} onClick={() => choose(it)} onMouseEnter={() => can && setActive(i)}
                className={cx("flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:bg-muted",
                  can ? "hover:bg-muted" : "cursor-not-allowed opacity-60")}>
                <span className="mt-0.5 text-muted-foreground">{it.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block">{it.label}</span>
                  <span className="block text-xs text-muted-foreground">{it.locked && it.key === "extract" ? it.locked : it.hint}</span>
                </span>
                {it.locked && <IconLock width={12} height={12} className="mt-1 text-muted-foreground" aria-label="Locked" />}
              </button>
            );
          })}
          {info && (left !== null || stub) && (
            <div className="mt-1 flex items-center gap-2 border-t px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">
              {stub && <TestModeBadge />}
              {left !== null && <span className="ml-auto tabular-nums" data-testid="ai-menu-left">{left === 0 ? `No AI left ${windowWords}` : `${left} left ${windowWords}`}</span>}
            </div>
          )}
        </div>
      )}
      {dialog?.kind === "summary" && (
        <AiDialog open title="Summary" description={record.title ? <>Of “{record.title}”</> : `Of this ${typeLabel}`} onClose={endDialog} testId="ai-summary-dialog"
          footer={<Button variant="outline" onClick={endDialog}>Close</Button>}>
          <AiSummary client={client} record={record} autoRun className="border-0 p-0" />
        </AiDialog>
      )}
      {dialog?.kind === "draft" && (
        <DraftDialog client={client} record={record} field={dialog.field} open onOpenChange={(o) => { if (!o) endDialog(); }} onApplied={onApplied} />
      )}
      {dialog?.kind === "extract" && (
        <ExtractDialog client={client} record={record} open onOpenChange={(o) => { if (!o) endDialog(); }} onApplied={onApplied} />
      )}
    </div>
  );
}
