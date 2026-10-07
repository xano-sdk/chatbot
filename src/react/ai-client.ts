/**
 * A small typed client for the AI action endpoints (`defineAiActions`), and `useAiInfo`, which reads
 * `GET ai/info` once per client and shares it with every menu on the page. SDK-free at runtime.
 *
 *   const ai = createAiClient({ apiBaseUrl: `${XANO_HOST}/api:ai`, getToken: () => session.token });
 */
import { useEffect, useState } from "react";
import type { AiApplyResult, AiInfo, AiRunResult, AiUsageEntry } from "../ai/types.js";

export type { AiApplyResult, AiInfo, AiRunResult, AiUsageEntry };
export type { AiDropped, AiFieldInfo, AiRecordInfo } from "../ai/types.js";

/** The wire contract this frontend was built for (`GET ai/info` → contract). */
export const AI_CLIENT_CONTRACT = 1;

export interface AiClientOptions {
  /** Your backend URL + `/api:<canonical>` of the ai group, e.g. `https://x.xano.io/api:ai`. */
  apiBaseUrl: string;
  /** The person's auth token, read on every request. */
  getToken: () => string | null | undefined;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** The record an AI action works on. `type` is its name in `records` ("note"). */
export interface AiRecordRef {
  type: string;
  id: number;
  /** Shown in dialog titles: "Launch checklist". */
  title?: string;
}

export type AiErrorKind = "network" | "session" | "forbidden" | "not_found" | "rate_limited" | "not_connected" | "invalid" | "server";

/** A failed call, with a message for people and a kind for the UI to branch on. */
export class AiError extends Error {
  constructor(message: string, readonly status: number, readonly kind: AiErrorKind, readonly code?: string) {
    super(message);
    this.name = "AiError";
  }
}

/** Plain words per status. The server's own message wins where it says something specific. */
export function describeAiError(status: number, serverMessage?: string): { message: string; kind: AiErrorKind } {
  if (status === 0) return { kind: "network", message: "We can't reach the server. Check your connection, then try again." };
  if (status === 401) return { kind: "session", message: "Your session ended. Sign in again to use AI." };
  if (status === 403) return { kind: "forbidden", message: serverMessage || "You don't have access to this." };
  if (status === 404) return { kind: "not_found", message: serverMessage || "This record isn't available any more." };
  if (status === 429) return { kind: "rate_limited", message: serverMessage || "You've used AI a lot just now. Try again a little later." };
  if (status === 400 && serverMessage && /isn't connected/i.test(serverMessage)) return { kind: "not_connected", message: serverMessage };
  if (status >= 400 && status < 500) return { kind: "invalid", message: serverMessage || "That couldn't be done. Check it and try again." };
  return { kind: "server", message: "The AI couldn't answer just now. Try again in a moment." };
}

export type AiClient = ReturnType<typeof createAiClient>;

export function createAiClient(opts: AiClientOptions) {
  const base = `${opts.apiBaseUrl.replace(/\/+$/, "")}/ai`;
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = opts.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      const d = describeAiError(0);
      throw new AiError(d.message, 0, d.kind);
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
      const d = describeAiError(res.status, j?.message);
      throw new AiError(d.message, res.status, d.kind, j?.code);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }
  /** An empty JSON object can arrive as `[]`; the UI always gets an object. */
  const objectOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const normal = (r: AiRunResult): AiRunResult => ({
    ...r, text: r.text ?? "", values: objectOf(r.values), current: objectOf(r.current), dropped: Array.isArray(r.dropped) ? r.dropped : [], problem: r.problem ?? "",
  });
  const run = async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    const r = normal(await request<AiRunResult>("POST", path, body, signal));
    bumpUsed(client);
    return r;
  };

  const client = {
    /** Whether AI is connected, the person's usage, and what they may do per record type. */
    info: () => request<AiInfo>("GET", "/info"),
    summarise: (record: AiRecordRef, signal?: AbortSignal) => run("/summarise", { record_type: record.type, record_id: record.id }, signal),
    draft: (record: AiRecordRef, field: string, instruction: string, signal?: AbortSignal) =>
      run("/draft", { record_type: record.type, record_id: record.id, field, instruction }, signal),
    extract: (record: AiRecordRef, text: string, signal?: AbortSignal) => run("/extract", { record_type: record.type, record_id: record.id, text }, signal),
    /** Write values (allowlisted fields only, checked again on the server), or send them for approval. An empty string clears a field. */
    apply: (record: AiRecordRef, values: Record<string, unknown>) =>
      request<AiApplyResult>("POST", "/apply", { record_type: record.type, record_id: record.id, values }),
    /** The person's own recent AI use. */
    usage: () => request<AiUsageEntry[]>("GET", "/usage"),
  };
  return client;
}

// ── Shared info ──────────────────────────────────────────────────────────────────────────────────────
type Entry = { info: AiInfo | null; error: AiError | null; promise: Promise<void> | null; listeners: Set<() => void> };
const cache = new WeakMap<object, Entry>();
const entryOf = (client: object): Entry => {
  let e = cache.get(client);
  if (!e) { e = { info: null, error: null, promise: null, listeners: new Set() }; cache.set(client, e); }
  return e;
};
const notify = (e: Entry) => e.listeners.forEach((l) => l());
function load(client: AiClient, force = false) {
  const e = entryOf(client);
  if (e.promise && !force) return e.promise;
  e.promise = client.info().then(
    (info) => { e.info = info; e.error = null; notify(e); },
    (err) => { e.error = err instanceof AiError ? err : new AiError(describeAiError(0).message, 0, "network"); e.promise = null; notify(e); },
  );
  return e.promise;
}
/** Count a run against the shown limit without another request. */
function bumpUsed(client: object) {
  const e = cache.get(client);
  if (e?.info) { e.info = { ...e.info, limit: { ...e.info.limit, used: e.info.limit.used + 1 } }; notify(e); }
}

/** `GET ai/info`, fetched once per client and shared. `refresh()` reads it again. */
export function useAiInfo(client: AiClient) {
  const e = entryOf(client);
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    e.listeners.add(l);
    void load(client);
    return () => { e.listeners.delete(l); };
  }, [client, e]);
  return {
    info: e.info,
    error: e.error,
    loading: !e.info && !e.error,
    refresh: () => load(client, true),
    /** The frontend and the endpoints disagree on the wire contract: update one of them. */
    outdated: !!e.info && e.info.contract !== AI_CLIENT_CONTRACT,
  };
}
