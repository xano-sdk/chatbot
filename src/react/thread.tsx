import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Markdown } from "./markdown.js";
import type { ChatState, ChatTurn } from "./use-chat.js";
import { IconArrowDown, IconCheck, IconCopy, IconSend, IconSparkle, IconTool } from "./icons.js";
import { Button, cx } from "./ui.js";

export interface ThreadText {
  /** The assistant's name, shown on its turns and in the empty state: "Desk assistant". */
  assistantName?: string;
  /** What the empty state says under the name. */
  welcome?: string;
  /** One-click starters in the empty state. */
  suggestions?: string[];
  placeholder?: string;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" aria-label={done ? "Copied" : "Copy reply"} title={done ? "Copied" : "Copy"}
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => {})}
      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100">
      {done ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

function Turn({ turn, name }: { turn: ChatTurn; name: string }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end" data-testid="chat-turn-user">
        {/* The person's own words: plain text, never Markdown (README "Render the reply as Markdown"). */}
        <div className={cx("max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[0.875rem] whitespace-pre-wrap text-primary-foreground", turn.pending && "opacity-80")}>
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div className="group flex gap-3" data-testid="chat-turn-assistant">
      <div aria-hidden className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-muted text-foreground"><IconSparkle /></div>
      <div className="min-w-0 flex-1">
        <div className="sr-only">{name} said:</div>
        <Markdown text={turn.content} className="text-[0.875rem] break-words" />
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {(turn.tools ?? []).map((t, i) => (
            <span key={`${t}-${i}`} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] text-muted-foreground" data-testid="chat-tool">
              <IconTool width={12} height={12} />{t.replace(/_/g, " ")}
            </span>
          ))}
          <CopyButton text={turn.content} />
        </div>
      </div>
    </div>
  );
}

function Thinking({ name }: { name: string }) {
  return (
    <div className="flex gap-3" data-testid="chat-thinking" aria-label={`${name} is writing a reply`}>
      <div aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-muted"><IconSparkle /></div>
      <div className="flex items-center gap-1 py-2" aria-hidden>
        {[0, 150, 300].map((d) => <span key={d} className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${d}ms` }} />)}
      </div>
    </div>
  );
}

/** The transcript, the empty state and the composer for the open conversation. */
export function Thread({ chat, text = {}, autoFocus }: { chat: ChatState; text?: ThreadText; autoFocus?: boolean }) {
  const name = text.assistantName ?? "Assistant";
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Keep the newest turn in view unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [chat.turns, chat.sending, atBottom]);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus, chat.activeId]);
  // A failed send gives its text back, so nothing typed is lost.
  useEffect(() => { if (chat.problem?.retry && !draft) setDraft(chat.problem.retry); }, [chat.problem]);

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const submit = async (value = draft) => {
    if (!value.trim() || chat.sending) return;
    setDraft("");
    setAtBottom(true);
    const ok = await chat.send(value);
    if (!ok) input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };
  const empty = !chat.loadingThread && chat.turns.length === 0 && !chat.sending;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} role="log" aria-live="polite" aria-busy={chat.sending} data-testid="chat-transcript"
        onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }}
        className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {chat.loadingThread ? (
            <div className="space-y-4" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className={cx("h-10 animate-pulse rounded-2xl bg-muted", i % 2 ? "ml-auto w-1/2" : "w-2/3")} />)}</div>
          ) : empty ? (
            <div className="flex flex-col items-center gap-4 py-10 text-center" data-testid="chat-empty">
              <div aria-hidden className="grid size-11 place-items-center rounded-2xl bg-muted"><IconSparkle width={20} height={20} /></div>
              <div>
                <h2 className="text-base font-semibold tracking-tight">{name}</h2>
                <p className="mx-auto mt-1 max-w-sm text-[0.8125rem] text-muted-foreground">{text.welcome ?? "Ask a question to get started."}</p>
              </div>
              {!!text.suggestions?.length && (
                <div className="grid w-full max-w-lg gap-2 sm:grid-cols-2">
                  {text.suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => void submit(s)} data-testid="chat-suggestion"
                      className="rounded-xl border px-3 py-2.5 text-left text-[0.8125rem] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{s}</button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            chat.turns.map((t) => <Turn key={t.id} turn={t} name={name} />)
          )}
          {chat.sending && <Thinking name={name} />}
        </div>
        {!atBottom && (
          <button type="button" aria-label="Jump to the latest message" onClick={() => { setAtBottom(true); }}
            className="sticky bottom-3 left-1/2 mx-auto grid size-8 -translate-x-0 place-items-center rounded-full border bg-background shadow-sm">
            <IconArrowDown />
          </button>
        )}
      </div>

      <div className="border-t bg-background px-4 pt-3 pb-4">
        <div className="mx-auto w-full max-w-3xl">
          {chat.problem && (
            <div role="alert" className="mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[0.8125rem]" data-testid="chat-problem">
              <span className="flex-1">{chat.problem.message}</span>
              <button type="button" onClick={chat.dismiss} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }}
            className="flex items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring">
            <textarea ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={1}
              placeholder={text.placeholder ?? `Message ${name}…`} aria-label={`Message ${name}`} data-testid="chat-input"
              className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.875rem] outline-none placeholder:text-muted-foreground" />
            <Button type="submit" aria-label="Send" disabled={!draft.trim() || chat.sending} icon className="size-9 rounded-xl" data-testid="chat-send">
              <IconSend />
            </Button>
          </form>
          <p className="mt-1.5 text-center text-[0.6875rem] text-muted-foreground">Enter to send · Shift+Enter for a new line · {name} can make mistakes.</p>
        </div>
      </div>
    </div>
  );
}
