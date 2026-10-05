import { useEffect, useState } from "react";
import type { ChatClient } from "./client.js";
import { Thread, type ThreadText } from "./thread.js";
import { useChat, type UseChatOptions } from "./use-chat.js";
import { IconChat, IconPlus, IconX } from "./icons.js";
import { Button, cx } from "./ui.js";

/**
 * A floating assistant for any page: a launcher in the corner that opens a panel with the person's latest
 * chat (full screen on a phone). Escape closes it.
 *
 *   <ChatWidget client={chatClient} assistantName="Acme help" suggestions={["Track my order"]} />
 */
export function ChatWidget({ client, onUnauthorized, position = "right", ...text }: ThreadText & Pick<UseChatOptions, "onUnauthorized"> & {
  client: ChatClient;
  position?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const chat = useChat(client, { onUnauthorized, openLatest: true });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const side = position === "left" ? "left-4 sm:left-6" : "right-4 sm:right-6";
  return (
    <>
      {open && (
        <div role="dialog" aria-label={text.assistantName ?? "Assistant"} data-testid="chat-widget-panel"
          className={cx("fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground shadow-2xl sm:inset-auto sm:bottom-24 sm:h-[min(640px,calc(100vh-8rem))] sm:w-[400px] sm:rounded-2xl sm:border", side)}>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{text.assistantName ?? "Assistant"}</h2>
            <Button variant="ghost" icon aria-label="New chat" onClick={chat.newChat}><IconPlus /></Button>
            <Button variant="ghost" icon aria-label="Close" onClick={() => setOpen(false)}><IconX /></Button>
          </header>
          <Thread chat={chat} text={text} autoFocus />
        </div>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Close the assistant" : `Open ${text.assistantName ?? "the assistant"}`}
        data-testid="chat-widget-launcher"
        className={cx("fixed bottom-4 z-50 grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:bottom-6", side, open && "max-sm:hidden")}>
        {open ? <IconX width={20} height={20} /> : <IconChat width={22} height={22} />}
      </button>
    </>
  );
}
