// @vitest-environment happy-dom
/** The optional frontend, rendered in a DOM with `fetch` stubbed at the network boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Chat, ChatWidget, createChatClient } from "../src/react/index.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.now();
const conv = (id: number, title = "", at = NOW) => ({ id, created_at: at, title, last_message_at: at });
const msg = (id: number, role: "user" | "assistant", content: string, conversation_id = 1) => ({ id, created_at: NOW + id, conversation_id, role, content });

type Call = { url: string; method: string; body?: any; auth?: string | null };
type Route = (c: Call) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;
function stubFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string>)?.authorization ?? null };
    calls.push(call);
    const path = new URL(url).pathname.replace(/^\/api:[^/]+\/chat/, "");
    const key = Object.keys(routes).sort((a, b) => Number(b.includes(" ")) - Number(a.includes(" ")))
      .find((k) => { const [v, p] = k.includes(" ") ? k.split(" ") : [null, k]; return (!v || v === call.method) && p === path; });
    const r = key ? await routes[key]!(call) : { status: 404, body: { code: "ERROR_CODE_NOT_FOUND", message: `no route ${path}` } };
    return new Response(r.body === undefined ? "null" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return { fetch: f as unknown as typeof fetch, calls };
}
const client = (f: typeof fetch, extra: object = {}) => createChatClient({ apiBaseUrl: "https://x.test/api:chat", getToken: () => "tok", fetch: f, ...extra });

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; });
async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  await settle();
  return host;
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const $ = (el: Element, id: string) => el.querySelector(`[data-testid="${id}"]`);
const $$ = (el: Element, id: string) => [...el.querySelectorAll(`[data-testid="${id}"]`)];
async function type(el: Element, text: string) {
  const input = $(el, "chat-input") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
const press = (input: Element, key: string, shiftKey = false) =>
  act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); });

describe("the client", () => {
  it("routes under the prefix, sends the token, and names each failure in plain words", async () => {
    const { fetch, calls } = stubFetch({ "GET /conversations": () => ({ status: 429, body: { code: "ERROR_CODE_TOO_MANY_REQUESTS" } }) });
    await expect(client(fetch).list()).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/sending messages quickly/) });
    expect(calls[0]).toMatchObject({ url: "https://x.test/api:chat/chat/conversations", auth: "Bearer tok" });
  });
  it("guest mode keeps each thread's session_token in memory and sends it, never an Authorization header", async () => {
    const { fetch, calls } = stubFetch({
      "POST /guest/conversations/create": () => ({ status: 200, body: { ...conv(5), session_token: "cap-5" } }),
      "POST /guest/conversations/5/send": () => ({ status: 200, body: { conversation_id: 5, reply: "Hi", message_id: 9, tool_calls: [] } }),
      "GET /guest/conversations/5/messages": () => ({ status: 200, body: [] }),
    });
    const c = createChatClient({ apiBaseUrl: "https://x.test/api:chat", guest: true, fetch });
    const made = await c.create();
    expect(made).not.toHaveProperty("session_token");      // the capability stays inside the client
    await c.send(5, "hello");
    await c.messages(5);
    expect(calls[1]!.body).toEqual({ content: "hello", session_token: "cap-5" });
    expect(calls[2]!.url).toContain("?session_token=cap-5");
    expect(calls.every((x) => x.auth === null)).toBe(true);
    expect(c.guestThreads()).toEqual([{ id: 5, session_token: "cap-5" }]);
    expect((await c.list()).map((x) => x.id)).toEqual([5]);
  });
  it("claims a guest thread with its token once signed in", async () => {
    const { fetch, calls } = stubFetch({ "POST /conversations/5/claim": () => ({ status: 200, body: conv(5) }) });
    await client(fetch).claim(5, "cap-5");
    expect(calls[0]).toMatchObject({ body: { session_token: "cap-5" }, auth: "Bearer tok" });
  });
});

describe("<Chat />", () => {
  it("starts on a welcome with suggestions; a suggestion creates the thread and sends it", async () => {
    const { fetch, calls } = stubFetch({
      "GET /conversations": () => ({ status: 200, body: [] }),
      "POST /conversations/create": () => ({ status: 200, body: conv(1) }),
      "POST /conversations/1/send": () => ({ status: 200, body: { conversation_id: 1, reply: "Your queue has **3** open tickets.", message_id: 2, tool_calls: ["desk_queue_summary"] } }),
    });
    const el = await render(<Chat client={client(fetch)} assistantName="Desk assistant" suggestions={["Summarise my queue"]} />);
    expect($(el, "chat-empty")!.textContent).toContain("Desk assistant");
    await act(async () => { ($(el, "chat-suggestion") as HTMLButtonElement).click(); });
    await settle();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url.replace("https://x.test/api:chat", ""))).toEqual(["/chat/conversations/create", "/chat/conversations/1/send"]);
    expect(calls.find((c) => c.url.endsWith("/send"))!.body).toEqual({ content: "Summarise my queue" });
    expect($(el, "chat-turn-user")!.textContent).toBe("Summarise my queue");
    const reply = $(el, "chat-turn-assistant")!;
    expect(reply.querySelector("strong")!.textContent).toBe("3");            // Markdown for the assistant
    expect($(el, "chat-tool")!.textContent).toContain("desk queue summary"); // which tools ran
  });

  it("shows the person's turn at once, a thinking indicator, and allows one send at a time", async () => {
    let release!: () => void;
    const { fetch, calls } = stubFetch({
      "GET /conversations": () => ({ status: 200, body: [conv(1, "Refunds")] }),
      "GET /conversations/1/messages": () => ({ status: 200, body: [] }),
      "POST /conversations/1/send": () => new Promise((r) => { release = () => r({ status: 200, body: { conversation_id: 1, reply: "Done.", message_id: 3, tool_calls: [] } }); }),
    });
    const el = await render(<Chat client={client(fetch)} />);
    await act(async () => { ($$(el, "chat-conversation")[0] as HTMLButtonElement).click(); });
    await settle();
    const input = await type(el, "**literal** <b>text</b>");
    await press(input, "Enter");
    await settle();
    expect($(el, "chat-turn-user")!.textContent).toBe("**literal** <b>text</b>");    // plain text for the person
    expect($(el, "chat-turn-user")!.querySelector("strong, b")).toBeNull();
    expect($(el, "chat-thinking")).not.toBeNull();
    expect(($(el, "chat-send") as HTMLButtonElement).disabled).toBe(true);
    await type(el, "second");
    await press($(el, "chat-input")!, "Enter");
    expect(calls.filter((c) => c.url.endsWith("/send"))).toHaveLength(1);              // serialized
    await act(async () => { release(); });
    await settle();
    expect($(el, "chat-thinking")).toBeNull();
    expect($(el, "chat-turn-assistant")!.textContent).toContain("Done.");
  });

  it("Shift+Enter adds a line instead of sending", async () => {
    const { fetch, calls } = stubFetch({ "GET /conversations": () => ({ status: 200, body: [] }) });
    const el = await render(<Chat client={client(fetch)} />);
    const input = await type(el, "line one");
    await press(input, "Enter", true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("after a 500 it re-reads the transcript (the turn may be stored) and gives the text back", async () => {
    const { fetch } = stubFetch({
      "GET /conversations": () => ({ status: 200, body: [conv(1, "T")] }),
      "GET /conversations/1/messages": () => ({ status: 200, body: [msg(1, "user", "hello")] }),
      "POST /conversations/1/send": () => ({ status: 500, body: { message: "agent failed" } }),
    });
    const el = await render(<Chat client={client(fetch)} />);
    await act(async () => { ($$(el, "chat-conversation")[0] as HTMLButtonElement).click(); });
    await settle();
    await press(await type(el, "again"), "Enter");
    await settle();
    expect($(el, "chat-problem")!.textContent).toMatch(/couldn't answer/);
    expect(($(el, "chat-input") as HTMLTextAreaElement).value).toBe("again");
    expect($$(el, "chat-turn-user").map((t) => t.textContent)).toEqual(["hello"]);
  });

  it("a 401 calls onUnauthorized", async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = stubFetch({ "GET /conversations": () => ({ status: 401, body: {} }) });
    const el = await render(<Chat client={client(fetch)} onUnauthorized={onUnauthorized} />);
    expect(onUnauthorized).toHaveBeenCalled();
    expect($(el, "chat-problem")!.textContent).toMatch(/session ended/);
  });

  it("deleting a chat asks first", async () => {
    const { fetch, calls } = stubFetch({
      "GET /conversations": () => ({ status: 200, body: [conv(1, "Old thread")] }),
      "DELETE /conversations/1": () => ({ status: 200, body: null }),
    });
    const el = await render(<Chat client={client(fetch)} />);
    await act(async () => { ($(el, "chat-delete") as HTMLButtonElement).click(); });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect([...el.querySelectorAll("dialog")].some((d) => d.textContent!.includes("Old thread"))).toBe(true);
    await act(async () => { ($(el, "confirm-action") as HTMLButtonElement).click(); });
    await settle();
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/conversations/1"))).toBe(true);
    expect($$(el, "chat-conversation")).toHaveLength(0);
  });
});

describe("<ChatWidget />", () => {
  it("opens on the latest chat and closes on Escape", async () => {
    const { fetch } = stubFetch({
      "GET /conversations": () => ({ status: 200, body: [conv(2, "Latest"), conv(1, "Older", NOW - 1000)] }),
      "GET /conversations/2/messages": () => ({ status: 200, body: [msg(1, "user", "hi", 2), msg(2, "assistant", "Hello!", 2)] }),
    });
    const el = await render(<ChatWidget client={client(fetch)} assistantName="Acme help" />);
    expect($(el, "chat-widget-panel")).toBeNull();
    await act(async () => { ($(el, "chat-widget-launcher") as HTMLButtonElement).click(); });
    await settle();
    expect($(el, "chat-widget-panel")!.getAttribute("aria-label")).toBe("Acme help");
    expect($(el, "chat-turn-assistant")!.textContent).toContain("Hello!");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect($(el, "chat-widget-panel")).toBeNull();
  });
});

describe("useChat", () => {
  it("serializes sends itself, whatever the UI does (two calls at once → one request)", async () => {
    const { useChat } = await import("../src/react/index.js");
    let release!: () => void;
    const { fetch, calls } = stubFetch({
      "GET /conversations": () => ({ status: 200, body: [conv(1, "T")] }),
      "GET /conversations/1/messages": () => ({ status: 200, body: [] }),
      "POST /conversations/1/send": () => new Promise((r) => { release = () => r({ status: 200, body: { conversation_id: 1, reply: "ok", message_id: 2, tool_calls: [] } }); }),
    });
    let chat!: ReturnType<typeof useChat>;
    const c = client(fetch);
    function Probe() { chat = useChat(c, { openLatest: true }); return null; }
    await render(<Probe />);
    let results!: boolean[];
    await act(async () => {
      const both = Promise.all([chat.send("one"), chat.send("two")]);
      await new Promise((r) => setTimeout(r, 10));
      release();
      results = await both;
    });
    expect(calls.filter((x) => x.url.endsWith("/send"))).toHaveLength(1);
    expect(results.sort()).toEqual([false, true]);
  });
});
