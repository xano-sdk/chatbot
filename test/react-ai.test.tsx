// @vitest-environment happy-dom
/** The AI parts, rendered in a DOM with `fetch` stubbed at the network boundary: states, keyboard, names. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AiActionMenu, AiSummary, DraftDialog, ExtractDialog, createAiClient, type AiInfo } from "../src/react/index.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const noteInfo = (over: Partial<AiInfo["records"]["note"]> = {}) => ({
  label: "note",
  fields: [
    { name: "title", label: "Title", type: "text", required: true, max: 80 },
    { name: "body", label: "Body", type: "text", required: false, max: 40 },
    { name: "priority", label: "Priority", type: "int", required: false, min: 0, max: 5 },
    { name: "due_on", label: "Due date", type: "date", required: false },
  ],
  summarise: true, draft: ["body"], extract: ["title", "priority", "due_on"], approval: false, read: true, write: true, ...over,
});
const info = (over: Partial<AiInfo> = {}, note: Partial<AiInfo["records"]["note"]> = {}): AiInfo => ({
  contract: 1, connected: true, provider: "model", limit: { max: 30, ttl: 3600, used: 4 }, paste_limit: 8000, instruction_limit: 500,
  records: { note: noteInfo(note) as AiInfo["records"]["note"] }, ...over,
});
const run = (over: Record<string, unknown> = {}) => ({
  action: "summarise", record_type: "note", record_id: 5, provider: "model", text: "", field: "", values: {}, dropped: [],
  current: { title: "Launch checklist", body: "Steps.", priority: 2, due_on: null }, problem: "", ...over,
});

type Call = { path: string; method: string; body?: any; auth?: string | null };
type Route = (c: Call) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;
function stubFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace(/^\/api:ai\/ai/, "");
    const call: Call = { path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>)?.authorization ?? null };
    calls.push(call);
    const route = routes[`${call.method} ${path}`];
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const r = route ? await route(call) : { status: 404, body: { message: `no route ${path}` } };
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return new Response(r.body === undefined ? "null" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return { fetch: f as unknown as typeof fetch, calls };
}
const clientWith = (routes: Record<string, Route>) => {
  const s = stubFetch({ "GET /info": () => ({ status: 200, body: info() }), ...routes });
  return { client: createAiClient({ apiBaseUrl: "https://x.test/api:ai", getToken: () => "tok", fetch: s.fetch }), calls: s.calls };
};
const NOTE = { type: "note", id: 5, title: "Launch checklist" };

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true }); });
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
const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); await settle(); };
async function typeInto(el: Element | null, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (text: string | RegExp) =>
  [...document.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;

describe("the AI client", () => {
  it("routes under /ai, sends the token, and names each failure in plain words", async () => {
    const { client, calls } = clientWith({
      "POST /summarise": () => ({ status: 429, body: { message: "You've used AI 30 times in the last hour. Try again a little later." } }),
      "POST /extract": () => ({ status: 400, body: { message: "AI isn't connected yet. Ask an admin to add the AI provider key." } }),
    });
    await expect(client.summarise(NOTE)).rejects.toMatchObject({ status: 429, kind: "rate_limited", message: expect.stringMatching(/Try again a little later/) });
    await expect(client.extract(NOTE, "x")).rejects.toMatchObject({ kind: "not_connected" });
    expect(calls[0]).toMatchObject({ path: "/summarise", method: "POST", auth: "Bearer tok", body: { record_type: "note", record_id: 5 } });
  });
  it("reads an empty object sent as [] as an object", async () => {
    const { client } = clientWith({ "POST /extract": () => ({ status: 200, body: { ...run({ action: "extract" }), values: [], current: [] } }) });
    const r = await client.extract(NOTE, "x");
    expect(r.values).toEqual({});
    expect(r.current).toEqual({});
  });
  it("says so when the network fails", async () => {
    const client = createAiClient({ apiBaseUrl: "https://x.test/api:ai", getToken: () => null, fetch: (async () => { throw new TypeError("offline"); }) as never });
    await expect(client.info()).rejects.toMatchObject({ status: 0, kind: "network", message: expect.stringMatching(/can't reach the server/) });
  });
});

describe("<AiActionMenu>", () => {
  it("opens from the keyboard, moves with the arrows, and Escape gives focus back to the button", async () => {
    const { client } = clientWith({});
    await render(<AiActionMenu client={client} record={NOTE} />);
    const btn = $("ai-menu-button")!;
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    btn.focus();
    await key(btn, "ArrowDown");
    const menu = $("ai-menu-list")!;
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-label")).toBe("AI actions for this note");
    expect([...menu.querySelectorAll("[role=menuitem]")].map((m) => m.querySelector("span span")?.textContent)).toEqual(["Summarise", "Draft body…", "Fill fields from text…"]);
    expect(document.activeElement).toBe($("ai-menu-summary"));
    await key(menu, "ArrowDown");
    expect(document.activeElement).toBe($("ai-menu-draft-body"));
    await key(menu, "End");
    expect(document.activeElement).toBe($("ai-menu-extract"));
    expect($("ai-menu-left")!.textContent).toBe("26 left this hour");
    await key(menu, "Escape");
    expect($("ai-menu-list")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("is hidden when the person can't use AI on this record type", async () => {
    const s = stubFetch({ "GET /info": () => ({ status: 200, body: info({}, { read: false }) }) });
    const client = createAiClient({ apiBaseUrl: "https://x.test/api:ai", getToken: () => "t", fetch: s.fetch });
    await render(<AiActionMenu client={client} record={NOTE} />);
    expect($("ai-menu")).toBeNull();
  });

  it("locks filling fields for someone who can't change the record, and says why", async () => {
    const s = stubFetch({ "GET /info": () => ({ status: 200, body: info({}, { write: false }) }) });
    const client = createAiClient({ apiBaseUrl: "https://x.test/api:ai", getToken: () => "t", fetch: s.fetch });
    await render(<AiActionMenu client={client} record={NOTE} />);
    await click($("ai-menu-button"));
    const extract = $("ai-menu-extract")!;
    expect(extract.getAttribute("aria-disabled")).toBe("true");
    expect(extract.textContent).toContain("You can't change this note.");
    await click(extract);
    expect($("ai-extract-dialog")).toBeNull();
    expect($("ai-menu-draft-body")!.getAttribute("aria-disabled")).toBeNull();
  });

  it("says AI isn't connected, and every action is off", async () => {
    const s = stubFetch({ "GET /info": () => ({ status: 200, body: info({ connected: false }) }) });
    const client = createAiClient({ apiBaseUrl: "https://x.test/api:ai", getToken: () => "t", fetch: s.fetch });
    await render(<AiActionMenu client={client} record={NOTE} />);
    await click($("ai-menu-button"));
    expect($("ai-not-connected")!.textContent).toMatch(/AI isn't connected yet/);
    expect([...document.querySelectorAll("[role=menuitem]")].every((m) => m.getAttribute("aria-disabled") === "true")).toBe(true);
  });

  it("Summarise opens a dialog that summarises at once; closing it returns focus to the button", async () => {
    const { client, calls } = clientWith({ "POST /summarise": () => ({ status: 200, body: run({ text: "Three steps left before launch.", provider: "stub" }) }) });
    await render(<AiActionMenu client={client} record={NOTE} />);
    await click($("ai-menu-button"));
    await click($("ai-menu-summary"));
    expect($("ai-summary-dialog")!.getAttribute("aria-labelledby")).toBeTruthy();
    expect($("ai-summary-text")!.textContent).toBe("Three steps left before launch.");
    expect($("ai-test-mode")).not.toBeNull();
    expect(calls.filter((c) => c.path === "/summarise")).toHaveLength(1);
    await click(button("Close"));
    await settle();
    expect($("ai-summary-dialog")).toBeNull();
    expect(document.activeElement).toBe($("ai-menu-button"));
  });
});

describe("<AiSummary>", () => {
  it("starts with a first action, shows loading, then the text with copy and regenerate", async () => {
    let release!: () => void;
    let n = 0;
    const { client, calls } = clientWith({
      "POST /summarise": () => { n += 1; return n === 1 ? new Promise((r) => { release = () => r({ status: 200, body: run({ text: "First take." }) }); }) : { status: 200, body: run({ text: "Second take." }) }; },
    });
    await render(<AiSummary client={client} record={NOTE} />);
    expect($("ai-summary")!.getAttribute("aria-label")).toBe("AI summary of this note");
    expect($("ai-summary")!.textContent).toContain("Get the gist of this note");
    await click($("ai-summary-run"));
    expect($("ai-summary-loading")).not.toBeNull();
    expect($("ai-summary")!.getAttribute("aria-busy")).toBe("true");
    await act(async () => { release(); });
    await settle();
    expect($("ai-summary-text")!.textContent).toBe("First take.");
    await click($("ai-summary-copy"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("First take.");
    expect($("ai-summary-copy")!.getAttribute("aria-label")).toBe("Copied");
    await click($("ai-summary-regenerate"));
    expect($("ai-summary-text")!.textContent).toBe("Second take.");
    expect(calls.filter((c) => c.path === "/summarise")).toHaveLength(2);
  });

  it("an error offers Try again; a rate limit explains and doesn't", async () => {
    let status = 500;
    const { client } = clientWith({ "POST /summarise": () => (status === 200 ? { status, body: run({ text: "Fine now." }) } : { status, body: { message: "You've used AI 30 times in the last hour. Try again a little later." } }) });
    await render(<AiSummary client={client} record={NOTE} />);
    await click($("ai-summary-run"));
    expect($("ai-summary-error")!.getAttribute("role")).toBe("alert");
    expect($("ai-summary-error")!.textContent).toMatch(/couldn't answer just now/);
    status = 429;
    await click(button("Try again"));
    expect($("ai-summary-error")!.textContent).toMatch(/30 times in the last hour/);
    expect(button("Try again")).toBeUndefined();
  });
});

describe("<DraftDialog>", () => {
  it("instruction → draft → edit → apply, then undo restores the old text", async () => {
    const onApplied = vi.fn();
    const { client, calls } = clientWith({
      "POST /draft": () => ({ status: 200, body: run({ action: "draft", field: "body", text: "Hi! Here are the steps." }) }),
      "POST /apply": (c) => ({ status: 200, body: { status: "applied", applied: Object.keys(c.body.values), record: { id: 5, ...c.body.values }, approval_id: null } }),
    });
    await render(<DraftDialog client={client} record={NOTE} field="body" open onOpenChange={() => {}} onApplied={onApplied} />);
    const dialog = $("ai-draft-dialog")!;
    expect(dialog.querySelector("h2")!.textContent).toBe("Draft body");
    expect(($("ai-draft-write") as HTMLButtonElement).disabled).toBe(true);
    await typeInto($("ai-draft-instruction"), "Make it friendlier");
    await click($("ai-draft-write"));
    expect(calls.find((c) => c.path === "/draft")!.body).toEqual({ record_type: "note", record_id: 5, field: "body", instruction: "Make it friendlier" });
    const text = $("ai-draft-text") as HTMLTextAreaElement;
    expect(text.value).toBe("Hi! Here are the steps.");
    await typeInto(text, "Hi! Edited.");
    await click($("ai-draft-apply"));
    expect(calls.find((c) => c.path === "/apply")!.body).toEqual({ record_type: "note", record_id: 5, values: { body: "Hi! Edited." } });
    expect($("ai-applied")!.textContent).toContain("Updated Body on this note.");
    await click($("ai-undo"));
    expect(calls.filter((c) => c.path === "/apply")[1]!.body.values).toEqual({ body: "Steps." });
    expect($("ai-applied")!.textContent).toContain("Undone");
    expect(onApplied).toHaveBeenCalledTimes(2);
  });

  it("won't apply a draft longer than the field allows, and shows the count", async () => {
    const { client } = clientWith({ "POST /draft": () => ({ status: 200, body: run({ action: "draft", text: "x".repeat(41) }) }) });
    await render(<DraftDialog client={client} record={NOTE} field="body" open onOpenChange={() => {}} />);
    await typeInto($("ai-draft-instruction"), "Longer");
    await click($("ai-draft-write"));
    expect(($("ai-draft-apply") as HTMLButtonElement).disabled).toBe(true);
    expect($("ai-draft-dialog")!.textContent).toContain("41/40");
  });

  it("shows progress that can be stopped, and keeps the instruction", async () => {
    const { client } = clientWith({ "POST /draft": () => new Promise(() => {}) });
    await render(<DraftDialog client={client} record={NOTE} field="body" open onOpenChange={() => {}} />);
    await typeInto($("ai-draft-instruction"), "Shorter please");
    await click($("ai-draft-write"));
    expect($("ai-working")!.getAttribute("role")).toBe("status");
    expect($("ai-working")!.textContent).toContain("Writing a draft…");
    await click(button("Stop"));
    expect(($("ai-draft-instruction") as HTMLTextAreaElement).value).toBe("Shorter please");
  });

  it("an approval-gated type sends the draft for approval, with no undo", async () => {
    const s = stubFetch({
      "GET /info": () => ({ status: 200, body: info({}, { approval: true }) }),
      "POST /draft": () => ({ status: 200, body: run({ action: "draft", text: "Reply." }) }),
      "POST /apply": () => ({ status: 200, body: { status: "pending", applied: ["body"], record: null, approval_id: 12 } }),
    });
    const client = createAiClient({ apiBaseUrl: "https://x.test/api:ai", getToken: () => "t", fetch: s.fetch });
    await render(<DraftDialog client={client} record={NOTE} field="body" open onOpenChange={() => {}} />);
    await typeInto($("ai-draft-instruction"), "Reply kindly");
    await click($("ai-draft-write"));
    expect($("ai-draft-apply")!.textContent).toBe("Send for approval");
    await click($("ai-draft-apply"));
    expect($("ai-applied")!.textContent).toContain("Sent for approval");
    expect($("ai-undo")).toBeNull();
  });

  it("an apply the server refuses keeps the draft and says why", async () => {
    const { client } = clientWith({
      "POST /draft": () => ({ status: 200, body: run({ action: "draft", text: "Fine." }) }),
      "POST /apply": () => ({ status: 403, body: { message: "You can't change this note." } }),
    });
    await render(<DraftDialog client={client} record={NOTE} field="body" open onOpenChange={() => {}} />);
    await typeInto($("ai-draft-instruction"), "x");
    await click($("ai-draft-write"));
    await click($("ai-draft-apply"));
    expect($("ai-apply-error")!.textContent).toBe("You can't change this note.");
    expect(($("ai-draft-text") as HTMLTextAreaElement).value).toBe("Fine.");
  });
});

describe("<ExtractDialog>", () => {
  const extracted = run({
    action: "extract",
    values: { title: "Ship the beta", priority: 2, due_on: "2026-11-03" },
    dropped: [{ field: "owner_id", value: "9", reason: "AI can't change this field." }, { field: "priority", value: "urgent", reason: "Must be a whole number." }],
  });

  it("shows current vs proposed per field with checkboxes, the refused values, and applies only what's ticked", async () => {
    const onApplied = vi.fn();
    const { client, calls } = clientWith({
      "POST /extract": () => ({ status: 200, body: extracted }),
      "POST /apply": (c) => ({ status: 200, body: { status: "applied", applied: Object.keys(c.body.values), record: { id: 5 }, approval_id: null } }),
    });
    await render(<ExtractDialog client={client} record={NOTE} open onOpenChange={() => {}} onApplied={onApplied} />);
    expect($("ai-extract-dialog")!.textContent).toContain("Looks for");
    await typeInto($("ai-extract-text"), "Title: Ship the beta\npriority: urgent\nDue: 2026-11-03");
    await click($("ai-extract-read"));
    expect(calls.find((c) => c.path === "/extract")!.body.text).toContain("Ship the beta");
    const title = $("ai-extract-row-title")!;
    expect(title.textContent).toContain("Launch checklist");
    expect(title.textContent).toContain("Ship the beta");
    const prio = $("ai-extract-row-priority")!;
    expect(prio.textContent).toContain("No change");
    expect((prio.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect($("ai-extract-row-due_on")!.textContent).toContain("Empty");
    expect($("ai-extract-dropped")!.textContent).toContain("Priority “urgent” — Must be a whole number.");
    expect($("ai-extract-dropped")!.textContent).toContain("owner_id “9” — AI can't change this field.");
    expect($("ai-extract-apply")!.textContent).toBe("Apply 2 changes");
    await click(document.querySelector('[aria-label="Apply Due date"]'));
    expect($("ai-extract-apply")!.textContent).toBe("Apply 1 change");
    await click($("ai-extract-apply"));
    expect(calls.find((c) => c.path === "/apply")!.body.values).toEqual({ title: "Ship the beta" });
    expect($("ai-applied")!.textContent).toContain("Updated Title on this note.");
    await click($("ai-undo"));
    expect(calls.filter((c) => c.path === "/apply")[1]!.body.values).toEqual({ title: "Launch checklist" });
    expect(onApplied).toHaveBeenCalledTimes(2);
  });

  it("says when nothing was found, with a way back", async () => {
    const { client } = clientWith({ "POST /extract": () => ({ status: 200, body: run({ action: "extract" }) }) });
    await render(<ExtractDialog client={client} record={NOTE} open onOpenChange={() => {}} />);
    await typeInto($("ai-extract-text"), "Thanks!");
    await click($("ai-extract-read"));
    expect($("ai-empty")!.textContent).toContain("No fields found");
    expect($("ai-extract-apply")).toBeNull();
    await click(button("Back"));
    expect(($("ai-extract-text") as HTMLTextAreaElement).value).toBe("Thanks!");
  });

  it("a failed read keeps the pasted text and explains", async () => {
    const { client } = clientWith({ "POST /extract": () => ({ status: 400, body: { message: "That's more than 8000 characters. Paste a shorter part." } }) });
    await render(<ExtractDialog client={client} record={NOTE} open onOpenChange={() => {}} />);
    await typeInto($("ai-extract-text"), "Some text");
    await click($("ai-extract-read"));
    expect($("ai-extract-error")!.textContent).toMatch(/Paste a shorter part/);
    expect(($("ai-extract-text") as HTMLTextAreaElement).value).toBe("Some text");
  });

  it("Escape closes through onOpenChange", async () => {
    const onOpenChange = vi.fn();
    const { client } = clientWith({});
    await render(<ExtractDialog client={client} record={NOTE} open onOpenChange={onOpenChange} />);
    await act(async () => { $("ai-extract-dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
