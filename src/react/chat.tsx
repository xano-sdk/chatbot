import { useMemo, useState } from "react";
import type { ChatClient, PublicConversation } from "./client.js";
import { Thread, type ThreadText } from "./thread.js";
import { useChat, type UseChatOptions } from "./use-chat.js";
import { IconMenu, IconPlus, IconTrash } from "./icons.js";
import { Ago, Button, ConfirmDialog, cx } from "./ui.js";

const label = (c: PublicConversation) => c.title?.trim() || "New conversation";

/** The chat list: New chat, search past five, pick, delete. Shared by <Chat> and the widget. */
export function Sidebar({ chat, onPick, onNew }: { chat: ReturnType<typeof useChat>; onPick: (id: number) => void; onNew: () => void }) {
  const [q, setQ] = useState("");
  const [deleting, setDeleting] = useState<PublicConversation | null>(null);
  const shown = useMemo(() => (chat.conversations ?? []).filter((c) => label(c).toLowerCase().includes(q.trim().toLowerCase())), [chat.conversations, q]);
  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col gap-3 p-3" data-testid="chat-sidebar">
      <Button onClick={onNew} variant="outline" className="w-full justify-start" data-testid="chat-new"><IconPlus />New chat</Button>
      {(chat.conversations?.length ?? 0) > 5 && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats"
          className="h-8 rounded-md border bg-background px-2.5 text-[0.8125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      )}
      <ul className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1">
        {chat.conversations === null ? [0, 1, 2].map((i) => <li key={i} className="h-9 animate-pulse rounded-md bg-muted" />)
          : shown.length === 0 ? <li className="px-2 py-1.5 text-xs text-muted-foreground">{q ? "No chats match." : "Your chats will show up here."}</li>
          : shown.map((c) => (
            <li key={c.id} className="group relative">
              <button type="button" onClick={() => onPick(c.id)} aria-current={c.id === chat.activeId ? "true" : undefined} data-testid="chat-conversation"
                className={cx("flex w-full flex-col rounded-md px-2 py-1.5 pr-8 text-left text-[0.8125rem] transition-colors",
                  c.id === chat.activeId ? "bg-muted font-medium" : "hover:bg-muted/60")}>
                <span className="truncate">{label(c)}</span>
                <Ago ms={c.last_message_at ?? c.created_at} className="text-[0.6875rem] font-normal text-muted-foreground" />
              </button>
              <button type="button" aria-label={`Delete ${label(c)}`} onClick={() => setDeleting(c)} data-testid="chat-delete"
                className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100">
                <IconTrash width={14} height={14} />
              </button>
            </li>
          ))}
      </ul>
      <ConfirmDialog open={!!deleting} title="Delete this chat?" confirmLabel="Delete"
        onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void chat.remove(deleting.id); setDeleting(null); }}>
        <p>“{deleting ? label(deleting) : ""}” and its messages are removed for good.</p>
      </ConfirmDialog>
    </nav>
  );
}

/**
 * The full-page assistant: your chats down the side (a drawer on a phone), the conversation, and the
 * composer. Give it a client and words; everything else is handled.
 *
 *   <Chat client={chatClient} assistantName="Desk assistant" welcome="Ask about your queue." suggestions={[…]} />
 */
export function Chat({ client, className, onUnauthorized, ...text }: ThreadText & Pick<UseChatOptions, "onUnauthorized"> & {
  client: ChatClient;
  className?: string;
}) {
  const chat = useChat(client, { onUnauthorized });
  const [drawer, setDrawer] = useState(false);
  const active = chat.conversations?.find((c) => c.id === chat.activeId);
  const pick = (id: number) => { void chat.open(id); setDrawer(false); };
  const fresh = () => { chat.newChat(); setDrawer(false); };
  return (
    <div className={cx("flex h-full min-h-0 w-full overflow-hidden bg-background text-foreground", className)} data-testid="chat">
      <aside className="hidden w-64 shrink-0 border-r md:block">{<Sidebar chat={chat} onPick={pick} onNew={fresh} />}</aside>
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Conversations">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85%] border-r bg-background shadow-lg"><Sidebar chat={chat} onPick={pick} onNew={fresh} /></div>
        </div>
      )}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <Button variant="ghost" icon className="md:hidden" aria-label="Show chats" onClick={() => setDrawer(true)}><IconMenu /></Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="chat-title">{active ? label(active) : text.assistantName ?? "Assistant"}</h1>
          <Button variant="ghost" icon className="md:hidden" aria-label="New chat" onClick={fresh}><IconPlus /></Button>
        </header>
        <Thread chat={chat} text={text} autoFocus />
      </section>
    </div>
  );
}
