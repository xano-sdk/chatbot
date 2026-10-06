/**
 * A small typed client for the chat endpoints, for a signed-in person or a guest. Framework-free and
 * SDK-free at runtime (types only).
 *
 *   createChatClient({ apiBaseUrl: `${XANO_HOST}/api:chat`, getToken: () => session.token })   // signed in
 *   createChatClient({ apiBaseUrl: `${XANO_HOST}/api:chat`, guest: true })                      // guest
 *
 * Guest threads are reached with a `session_token` capability. The client keeps those tokens in memory
 * (never localStorage: a token there outlives the tab and anything on the origin can read it), or in
 * sessionStorage when you pass `guestStorage: "session"` so a reload keeps the thread.
 */
import type { ChatReply } from "../api/types.js";
import type { PublicConversation } from "../tables/conversation.js";
import type { PublicMessage } from "../tables/message.js";

export interface ChatClientOptions {
  /** Your backend URL + `/api:<canonical>` of the chat group, e.g. `https://x.xano.io/api:chat`. */
  apiBaseUrl: string;
  /** The `routePrefix` the chatbot was registered with. Default "chat". */
  routePrefix?: string;
  /** Signed-in mode: the person's auth token, read on every request. */
  getToken?: () => string | null | undefined;
  /** Guest mode: use the public guest endpoints (the chatbot must be registered with `guest: true`). */
  guest?: boolean;
  /** Where guest session tokens live: "memory" (default) or "session" (survives a reload of this tab). */
  guestStorage?: "memory" | "session";
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** A non-2xx answer: the status (0 = the network failed), the server's code, and a message for people. */
export class ChatError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ChatError";
  }
}

/** Plain words per status, from the chatbot's error table (README "Errors"). */
export function describeChatError(status: number, serverMessage?: string): string {
  switch (status) {
    case 0: return "We can't reach the server. Check your connection, then try again.";
    case 400: return serverMessage || "That message couldn't be sent. Check it and try again.";
    case 401: return "Your session ended. Sign in again to keep chatting.";
    case 403: return "This conversation now belongs to an account. Sign in to continue it.";
    case 404: return "This conversation isn't available any more.";
    case 429: return "You're sending messages quickly. Wait a moment, then try again.";
    default: return status >= 500 ? "The assistant couldn't answer just now. Try again." : serverMessage || `Something went wrong (${status}).`;
  }
}

export type ChatClient = ReturnType<typeof createChatClient>;
export type { ChatReply, PublicConversation, PublicMessage };

const STORE_KEY = "xano-sdk.chatbot.guest";

export function createChatClient(opts: ChatClientOptions) {
  const base = `${opts.apiBaseUrl.replace(/\/+$/, "")}/${(opts.routePrefix ?? "chat").replace(/^\/+|\/+$/g, "")}`;
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const guest = opts.guest === true;

  // Guest capabilities: conversation id → session_token (+ the conversation, for the list guests lack).
  const store = (): Storage | null => (opts.guestStorage === "session" && typeof sessionStorage !== "undefined" ? sessionStorage : null);
  const memory = new Map<number, { token: string; conversation: PublicConversation }>();
  const load = () => {
    try { for (const [id, v] of JSON.parse(store()?.getItem(STORE_KEY) ?? "[]") as [number, { token: string; conversation: PublicConversation }][]) memory.set(id, v); } catch { /* ignore */ }
  };
  const save = () => { try { store()?.setItem(STORE_KEY, JSON.stringify([...memory])); } catch { /* private mode */ } };
  load();
  const tokenFor = (id: number) => {
    const t = memory.get(id)?.token;
    if (!t) throw new ChatError(describeChatError(404), 404);
    return t;
  };

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = guest ? null : opts.getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new ChatError(describeChatError(0), 0);
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      throw new ChatError(describeChatError(res.status, j?.message), res.status, j?.code);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    mode: guest ? ("guest" as const) : ("user" as const),
    /** The person's conversations, most recent first. A guest sees the threads this client started. */
    async list(): Promise<PublicConversation[]> {
      if (guest) return [...memory.values()].map((v) => v.conversation).sort((a, b) => (b.last_message_at ?? b.created_at) - (a.last_message_at ?? a.created_at));
      return request("GET", "/conversations");
    },
    async create(title?: string): Promise<PublicConversation> {
      const body = title ? { title } : {};
      if (!guest) return request("POST", "/conversations/create", body);
      const made = await request<PublicConversation & { session_token: string }>("POST", "/guest/conversations/create", body);
      const { session_token, ...conversation } = made;
      memory.set(made.id, { token: session_token, conversation });
      save();
      return conversation;
    },
    async messages(id: number): Promise<PublicMessage[]> {
      if (!guest) return request("GET", `/conversations/${id}/messages`);
      return request("GET", `/guest/conversations/${id}/messages?session_token=${encodeURIComponent(tokenFor(id))}`);
    },
    async send(id: number, content: string): Promise<ChatReply> {
      const reply = guest
        ? await request<ChatReply>("POST", `/guest/conversations/${id}/send`, { content, session_token: tokenFor(id) })
        : await request<ChatReply>("POST", `/conversations/${id}/send`, { content });
      const kept = memory.get(id);
      if (kept) { kept.conversation = { ...kept.conversation, last_message_at: Date.now(), title: kept.conversation.title || content.slice(0, 60) }; save(); }
      return reply;
    },
    async remove(id: number): Promise<void> {
      if (!guest) { await request("DELETE", `/conversations/${id}`); return; }
      await request("POST", `/guest/conversations/${id}/delete`, { session_token: tokenFor(id) });
      memory.delete(id);
      save();
    },
    /** Guest threads this client holds, to claim after the person signs in. */
    guestThreads(): { id: number; session_token: string }[] {
      return [...memory].map(([id, v]) => ({ id, session_token: v.token }));
    },
    /** Signed in: take over a thread started as a guest. Its guest token stops working. */
    claim(id: number, sessionToken: string): Promise<PublicConversation> {
      return request("POST", `/conversations/${id}/claim`, { session_token: sessionToken });
    },
    /** Forget guest threads (after claiming them, or on sign-out). */
    forgetGuestThreads() {
      memory.clear();
      try { store()?.removeItem(STORE_KEY); } catch { /* ignore */ }
    },
  };
}
