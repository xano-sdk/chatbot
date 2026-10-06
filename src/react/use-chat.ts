import { useCallback, useEffect, useRef, useState } from "react";
import { ChatError, describeChatError, type ChatClient, type PublicConversation, type PublicMessage } from "./client.js";

/** A transcript row as the UI shows it: stored messages, plus the turn in flight and the tools a reply used. */
export type ChatTurn = PublicMessage & { pending?: boolean; tools?: string[] };
export type ChatProblem = { message: string; status: number; retry?: string };

export interface UseChatOptions {
  /** Open the most recent conversation on load (the widget does; the full page starts on a new chat). */
  openLatest?: boolean;
  /** Called on a 401, so the app can sign the person out. */
  onUnauthorized?: () => void;
}

/**
 * The state of one person's chats: the list, the open thread, and sending. Sends are serialized: one per
 * thread at a time, as the chatbot requires. The person's turn shows at once; if the send fails the
 * transcript is re-read (the server may already have stored the turn) and the problem is shown in plain
 * words, with the text kept for a retry.
 */
export function useChat(client: ChatClient, opts: UseChatOptions = {}) {
  const [conversations, setConversations] = useState<PublicConversation[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<ChatProblem | null>(null);
  const inFlight = useRef(false);
  const tools = useRef(new Map<number, string[]>());
  const onUnauthorized = useRef(opts.onUnauthorized);
  onUnauthorized.current = opts.onUnauthorized;

  const fail = useCallback((e: unknown, retry?: string) => {
    const err = e instanceof ChatError ? e : new ChatError(describeChatError(0), 0);
    if (err.status === 401) onUnauthorized.current?.();
    setProblem({ message: err.message, status: err.status, ...(retry !== undefined ? { retry } : {}) });
    return err;
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const list = await client.list();
      setConversations(list);
      return list;
    } catch (e) {
      fail(e);
      setConversations((c) => c ?? []);
      return [];
    }
  }, [client, fail]);

  const open = useCallback(async (id: number | null) => {
    setProblem(null);
    setActiveId(id);
    setTurns([]);
    if (id === null) return;
    setLoadingThread(true);
    try {
      const msgs = await client.messages(id);
      setTurns(msgs.map((m) => ({ ...m, tools: tools.current.get(m.id) })));
    } catch (e) {
      const err = fail(e);
      if (err.status === 404) { setActiveId(null); void refreshList(); }
    } finally {
      setLoadingThread(false);
    }
  }, [client, fail, refreshList]);

  useEffect(() => {
    void refreshList().then((list) => { if (opts.openLatest && list[0]) void open(list[0].id); });
  }, [client]);

  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || inFlight.current) return false;
    inFlight.current = true;
    setSending(true);
    setProblem(null);
    const temp: ChatTurn = { id: -Date.now(), created_at: Date.now(), conversation_id: activeId ?? 0, role: "user", content, pending: true };
    setTurns((t) => [...t, temp]);
    let id = activeId;
    try {
      if (id === null) {
        const made = await client.create();
        id = made.id;
        setActiveId(id);
        setConversations((c) => [made, ...(c ?? [])]);
      }
      const reply = await client.send(id, content);
      tools.current.set(reply.message_id, reply.tool_calls ?? []);
      setTurns((t) => [
        ...t.map((x) => (x === temp ? { ...x, pending: false, conversation_id: id! } : x)),
        { id: reply.message_id, created_at: Date.now(), conversation_id: id!, role: "assistant", content: String(reply.reply ?? ""), tools: reply.tool_calls ?? [] },
      ]);
      void refreshList();
      return true;
    } catch (e) {
      const err = fail(e, content);
      if (err.status === 404) { setActiveId(null); setTurns([]); void refreshList(); }
      else if (id !== null && err.status !== 401) {
        // The server may have stored the person's turn before failing: show what it has.
        try { setTurns((await client.messages(id)).map((m) => ({ ...m, tools: tools.current.get(m.id) }))); }
        catch { setTurns((t) => t.filter((x) => x !== temp)); }
      } else setTurns((t) => t.filter((x) => x !== temp));
      return false;
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }, [activeId, client, fail, refreshList]);

  const remove = useCallback(async (id: number) => {
    try {
      await client.remove(id);
      setConversations((c) => (c ?? []).filter((x) => x.id !== id));
      if (id === activeId) { setActiveId(null); setTurns([]); }
    } catch (e) {
      fail(e);
    }
  }, [activeId, client, fail]);

  return {
    conversations, activeId, turns, loadingThread, sending, problem,
    open, newChat: () => void open(null), send, remove, refreshList, dismiss: () => setProblem(null),
  };
}

export type ChatState = ReturnType<typeof useChat>;
