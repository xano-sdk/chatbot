import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ChatClient } from "./client.js";
import { Sidebar } from "./chat.js";
import { Thread, type ThreadText } from "./thread.js";
import { useChat, type UseChatOptions } from "./use-chat.js";
import { IconChat, IconCollapse, IconDock, IconExpand, IconFloat, IconHistory, IconPlus, IconX } from "./icons.js";
import { Button, cx } from "./ui.js";

const TOGGLE = "xano-chat:toggle";
/** Open (or close) the ChatWidget from your own control: a header button, a menu item, a shortcut. */
export const openChatWidget = () => window.dispatchEvent(new Event(TOGGLE));

/** How the open widget sits: a floating panel, docked down the side of the page, or the whole screen. */
export type ChatWidgetSize = "panel" | "side" | "full";
type Layout = { size: ChatWidgetSize; w: number; h: number; side: number };
const STORE = "xano-chat:layout";
const PANEL = { w: 400, h: 640, minW: 340, minH: 420 };
const SIDE = { w: 440, min: 340 };
const STEP = 32;
// Within the window (the CSS also clamps, so a smaller window never cuts the panel off).
const fitW = (w: number, room: number) => Math.round(Math.max(PANEL.minW, Math.min(w, room)));
const fitH = (h: number) => Math.round(Math.max(PANEL.minH, Math.min(h, window.innerHeight - 48)));
const fitSide = (w: number) => Math.round(Math.max(SIDE.min, Math.min(w, window.innerWidth * 0.7)));

function readLayout(fallback: ChatWidgetSize): Layout {
  const base: Layout = { size: fallback, w: PANEL.w, h: PANEL.h, side: SIDE.w };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Layout> | null;
    if (!saved) return base;
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    return {
      size: saved.size === "panel" || saved.size === "side" || saved.size === "full" ? saved.size : fallback,
      w: n(saved.w, base.w), h: n(saved.h, base.h), side: n(saved.side, base.side),
    };
  } catch { return base; }
}
const saveLayout = (l: Layout) => { try { localStorage.setItem(STORE, JSON.stringify(l)); } catch { /* private mode: not remembered */ } };

/**
 * A floating assistant for any page: a launcher in the corner that opens a panel with the person's latest
 * chat. The panel resizes from its inner corner, docks down the side of the page (the page stays usable
 * beside it), or goes full screen with the chat list alongside. Their choice and sizes are remembered on
 * this device. A phone always gets the full screen. Escape leaves full screen, then closes.
 *
 * With `launcher="none"` there is no corner button: open it from your own control with
 * `openChatWidget()` (a header "Ask" button, say), so nothing floats over the page.
 *
 *   <ChatWidget client={chatClient} assistantName="Acme help" suggestions={["Track my order"]} />
 */
export function ChatWidget({ client, onUnauthorized, position = "right", launcher = "floating", defaultSize = "panel", ...text }: ThreadText & Pick<UseChatOptions, "onUnauthorized"> & {
  client: ChatClient;
  position?: "left" | "right";
  launcher?: "floating" | "none";
  /** The size it first opens at, before the person picks one. */
  defaultSize?: ChatWidgetSize;
}) {
  const [open, setOpen] = useState(false);
  const [layout, setLayoutState] = useState<Layout>(() => readLayout(defaultSize));
  // Where "Exit full screen" goes back to.
  const [before, setBefore] = useState<Exclude<ChatWidgetSize, "full">>(() => (layout.size === "side" ? "side" : "panel"));
  const [history, setHistory] = useState(false);
  const setLayout = (next: Partial<Layout>) => setLayoutState((l) => { const v = { ...l, ...next }; saveLayout(v); return v; });
  const setSize = (size: ChatWidgetSize) => {
    if (size === "full" && layout.size !== "full") setBefore(layout.size as Exclude<ChatWidgetSize, "full">);
    setHistory(false);
    setLayout({ size });
  };

  useEffect(() => {
    const on = () => setOpen((o) => !o);
    window.addEventListener(TOGGLE, on);
    return () => window.removeEventListener(TOGGLE, on);
  }, []);
  const chat = useChat(client, { onUnauthorized, openLatest: true });
  const { size } = layout;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (history) setHistory(false);
      else if (size === "full") setSize(before);
      else setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, history, size, before]);

  // Docked: tell the page how much room to leave (`--chat-dock`; the README shows the one CSS rule).
  const docked = open && size === "side";
  useEffect(() => {
    if (!docked) return;
    const root = document.documentElement;
    root.style.setProperty("--chat-dock", `${layout.side}px`);
    root.dataset.chatDock = position;
    return () => { root.style.removeProperty("--chat-dock"); delete root.dataset.chatDock; };
  }, [docked, layout.side, position]);

  // Resizing. The panel grows from its inner corner (the one away from the screen edge); the dock from its
  // inner edge. Pointer drag, or the arrow keys on the focused handle; a double-click resets.
  const drag = useRef<{ x: number; y: number; w: number; h: number; side: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inward = position === "right" ? -1 : 1;
  const room = () => window.innerWidth - 48;
  const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, w: layout.w, h: layout.h, side: layout.side };
    setDragging(true);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) * inward, dy = d.y - e.clientY;
    setLayoutState((l) => (size === "side" ? { ...l, side: fitSide(d.side + dx) } : { ...l, w: fitW(d.w + dx, room()), h: fitH(d.h + dy) }));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    setLayoutState((l) => { saveLayout(l); return l; });
  };
  // The arrows move the handle: towards the page grows the width, up grows the panel's height.
  const keyResize = (e: ReactKeyboardEvent<HTMLElement>) => {
    const dw = e.key === "ArrowLeft" ? -inward : e.key === "ArrowRight" ? inward : 0;
    const dh = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (!dw && !dh) return;
    e.preventDefault();
    if (size === "side") { if (dw) setLayout({ side: fitSide(layout.side + dw * STEP) }); }
    else setLayout({ w: fitW(layout.w + dw * STEP, room()), h: fitH(layout.h + dh * STEP) });
  };
  const resetSize = () => setLayout(size === "side" ? { side: SIDE.w } : { w: PANEL.w, h: PANEL.h });

  const name = text.assistantName ?? "Assistant";
  const left = position === "left";
  const side = left ? "left-4 sm:left-6" : "right-4 sm:right-6";
  const pick = (id: number) => { void chat.open(id); setHistory(false); };
  const fresh = () => { chat.newChat(); setHistory(false); };
  // An in-app link leaves the chat, except when docked: the page is right there beside it.
  const navigate = text.onNavigate && ((href: string) => { if (size !== "side") setOpen(false); setHistory(false); text.onNavigate!(href); });
  const vars = { "--chat-w": `${layout.w}px`, "--chat-h": `${layout.h}px`, "--chat-side": `${layout.side}px` } as CSSProperties;

  return (
    <>
      {open && (
        <div role="dialog" aria-label={name} data-testid="chat-widget-panel" data-size={size} style={vars}
          className={cx("fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground", dragging && "select-none",
            size === "panel" && cx("shadow-2xl sm:inset-auto sm:h-[min(var(--chat-h),calc(100dvh-8rem))] sm:w-[min(var(--chat-w),calc(100vw-3rem))] sm:rounded-2xl sm:border",
              launcher === "none" ? "sm:bottom-6 sm:h-[min(var(--chat-h),calc(100dvh-3rem))]" : "sm:bottom-24", side),
            size === "side" && cx("sm:inset-y-0 sm:w-[min(var(--chat-side),70vw)] sm:shadow-xl", left ? "sm:right-auto sm:border-r" : "sm:left-auto sm:border-l"))}>
          {size !== "full" && (
            <div role="separator" aria-orientation={size === "side" ? "vertical" : undefined} aria-label={size === "side" ? "Resize the assistant's width" : "Resize the assistant"}
              aria-valuenow={size === "side" ? layout.side : undefined} tabIndex={0} title="Drag to resize · double-click to reset" data-testid="chat-widget-resize"
              onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={keyResize} onDoubleClick={resetSize}
              className={cx("absolute z-20 hidden touch-none focus-visible:outline-none sm:block",
                size === "side"
                  ? cx("inset-y-0 w-2 cursor-col-resize after:absolute after:inset-y-0 after:w-0.5 after:bg-primary/50 after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100", left ? "-right-1 after:right-1" : "-left-1 after:left-1", dragging && "after:opacity-100")
                  : cx("top-0 size-4 after:absolute after:top-1.5 after:size-2 after:rounded-full after:bg-muted-foreground/40 after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100 focus-visible:after:bg-primary",
                    left ? "right-0 cursor-nesw-resize after:right-1.5" : "left-0 cursor-nwse-resize after:left-1.5", dragging && "after:opacity-100"))} />
          )}
          <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
            <Button variant="ghost" icon aria-label={history ? "Back to the chat" : "Your chats"} aria-pressed={history} onClick={() => setHistory((h) => !h)}
              className={cx(size === "full" && "md:hidden")} data-testid="chat-widget-history"><IconHistory /></Button>
            <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{name}</h2>
            <Button variant="ghost" icon aria-label="New chat" className={cx(size === "full" && "md:hidden")} onClick={fresh}><IconPlus /></Button>
            {size === "full" ? (
              <Button variant="ghost" icon aria-label="Exit full screen" title="Exit full screen (Esc)" className="max-sm:hidden" onClick={() => setSize(before)} data-testid="chat-widget-exit-full"><IconCollapse /></Button>
            ) : (
              <>
                {size === "panel"
                  ? <Button variant="ghost" icon aria-label="Dock to the side" title="Dock to the side" className="max-sm:hidden" onClick={() => setSize("side")} data-testid="chat-widget-dock"><IconDock className={cx(left && "-scale-x-100")} /></Button>
                  : <Button variant="ghost" icon aria-label="Float as a panel" title="Float as a panel" className="max-sm:hidden" onClick={() => setSize("panel")} data-testid="chat-widget-float"><IconFloat className={cx(left && "-scale-x-100")} /></Button>}
                <Button variant="ghost" icon aria-label="Full screen" title="Full screen" className="max-sm:hidden" onClick={() => setSize("full")} data-testid="chat-widget-full"><IconExpand /></Button>
              </>
            )}
            <Button variant="ghost" icon aria-label="Close" title="Close (Esc)" onClick={() => setOpen(false)}><IconX /></Button>
          </header>
          <div className="relative flex min-h-0 flex-1">
            {size === "full" && <aside className="hidden w-64 shrink-0 border-r md:block"><Sidebar chat={chat} onPick={pick} onNew={fresh} /></aside>}
            <section className="flex min-w-0 flex-1 flex-col">
              <Thread chat={chat} text={{ ...text, onNavigate: navigate }} autoFocus />
            </section>
            {history && <div className="absolute inset-0 z-10 bg-background" data-testid="chat-widget-chats"><Sidebar chat={chat} onPick={pick} onNew={fresh} /></div>}
          </div>
        </div>
      )}
      {launcher === "floating" && <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Close the assistant" : `Open ${text.assistantName ?? "the assistant"}`}
        data-testid="chat-widget-launcher"
        className={cx("fixed bottom-[calc(1rem+var(--chat-offset,0px))] z-50 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:bottom-[calc(1.5rem+var(--chat-offset,0px))]", side, open && (size === "panel" ? "max-sm:hidden" : "hidden"))}>
        {open ? <IconX width={20} height={20} /> : <IconChat width={22} height={22} />}
      </button>}
    </>
  );
}
