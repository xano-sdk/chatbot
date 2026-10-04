/**
 * Shared fixtures and bundle-introspection helpers.
 *
 * The auth table every test points the package at lives here so the tests all
 * reference ONE table rather than each declaring its own — two `table()` defs
 * named `user` would derive the same guid and trip core's duplicate guard the
 * moment two tests registered into one workspace.
 */
import { createHash } from "node:crypto";
import { table, f, Xano } from "@xano/sdk";
import { createChatbot, registerChatbot, type ChatbotOptions } from "../src/index.js";

/** A conventional `auth: true` table — the happy path a consumer passes in. */
export const testUserTable = table({
  name: "test_user",
  auth: true,
  useXdo: false,
  schema: { email: f.email({ required: true, methods: ["trim", "lower"] }) },
});

/**
 * A uuid-keyed table, for the `userIdType` path. Core reads `idType` off the
 * handle, so this is what proves the FK column follows the referenced key type.
 */
export const uuidUserTable = table({
  name: "uuid_user",
  auth: true,
  useXdo: false,
  idType: "uuid",
  schema: { email: f.email({ required: true }) },
});

/**
 * A table the tests reference by BARE NAME, to exercise the roll-your-own path.
 * It still has to be registered: core treats an `auth` reference to an
 * unregistered table as a hard export ERROR, not a warning.
 */
export const membersTable = table({
  name: "members",
  auth: true,
  useXdo: false,
  schema: { email: f.email({ required: true }) },
});

/** A table WITHOUT `auth: true` — legal, per core's `resolveAuthRef`. */
export const unflaggedTable = table({
  name: "unflagged_user",
  auth: false,
  useXdo: false,
  schema: { email: f.email({ required: true }) },
});

/** `createChatbot` with the auth table already supplied. */
export const bot = (opts: ChatbotOptions = {}) =>
  createChatbot({ authTable: testUserTable, ...opts });

/**
 * Register into a fresh workspace and return the exported **payload** — the
 * section map (`dbo`, `query`, `function`, `toolset`, `app`, …). `export()` wraps
 * it in an envelope (`{ app, version, type, payload, sig }`); every assertion here
 * wants the inner map.
 *
 * `authTable` defaults to {@link testUserTable} and the table is registered
 * alongside, so the reference resolves to something the workspace holds.
 */
export const exportWith = (
  opts: ChatbotOptions = {},
  { name = "xts-chatbot-test", extraTables = [] as any[], extraTools = [] as any[] } = {},
) => {
  const authTable = (opts.authTable ?? testUserTable) as typeof testUserTable;
  const xano = new Xano().registerWorkspace({ name });
  // A bare-name authTable names no def to register, so the caller supplies the
  // real table via `extraTables` — core errors on an unregistered auth reference.
  const tables = typeof authTable === "string" ? extraTables : [authTable, ...extraTables];
  if (tables.length) xano.registerTables(tables);
  // A referenced tool must be registered or core ERRORS at export — the same
  // rule as an unregistered authTable.
  if (extraTools.length) xano.registerTools(extraTools);
  registerChatbot(xano, { authTable, ...opts });
  return (xano.export() as any).payload;
};

/**
 * Expected identities: `md5("<kind>:<name>")`, core's name-derivation.
 *
 * Computed here rather than imported from core. `deriveGuid` is only exported
 * from `@xano/sdk/internal`, a subpath that does not exist on every core in
 * this package's peer range — importing it would raise the peer FLOOR for every
 * consumer to satisfy a test, which is the wrong trade when `src` itself compiles
 * against the whole range.
 *
 * Re-stating the formula is safe because it is not the only check on it: the
 * golden fixture freezes every literal guid, so a change to core's derivation
 * fails `bundle.test.ts` regardless of what this helper computes. These
 * assertions prove the *referential* contract — that a statement's reference
 * resolves to the same identity its target emits — which holds under any formula.
 */
const derive = (kind: string, name: string) =>
  createHash("md5").update(`${kind}:${name}`).digest("hex");

export const guidFor = {
  table: (name: string) => derive("dbo", name),
  fn: (name: string) => derive("function", name),
  query: (name: string) => derive("query", name),
  group: (name: string) => derive("app", name),
  toolset: (name: string) => derive("toolset", name),
  tool: (name: string) => derive("tool", name),
};

/** Pull one payload section out of an exported payload map. */
export const section = (payload: any, key: string): any[] => payload[key] ?? [];

/** Find a payload row by its `name`. */
export const byName = (rows: any[], name: string) => rows.find((r) => r?.name === name);

/** Every query row, keyed by name. */
export const queriesByName = (payload: any): Record<string, any> =>
  Object.fromEntries(section(payload, "query").map((q) => [q.name, q]));

/** The `conversation` / `conversation_message` table rows. */
export const tableRow = (payload: any, name: string) => byName(section(payload, "dbo"), name);

/** A table row's column descriptor, by column name. */
export const column = (tableRow: any, name: string) =>
  (tableRow?.schema ?? []).find((col: any) => col?.name === name);
