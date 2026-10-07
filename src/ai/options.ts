/**
 * The `defineAiActions` option surface, and `resolveAiOptions`, the one place every option is checked
 * before a def is built (the same rule as `resolveOptions` for the chatbot).
 */
import type { AnyFunctionDef, AnyTableDef, Condition, LlmSettings, Statement, Value } from "@xano/sdk";
import type { ChatbotLlmOptions } from "../options.js";

/** The kinds of value an AI action may propose for a field. Each is validated on the server. */
export type AiFieldType = "text" | "enum" | "int" | "decimal" | "bool" | "date";

/** One field AI may fill or draft. The record's column of the same name receives it. */
export interface AiFieldSpec {
  type: AiFieldType;
  /** What people call it: "Due date". Default: the column name in sentence case. */
  label?: string;
  /** `enum` only: the allowed values, exactly as stored. */
  values?: readonly string[];
  /** `text`: the most characters. `int`/`decimal`: the largest value. */
  max?: number;
  /** `text`: the fewest characters. `int`/`decimal`: the smallest value. */
  min?: number;
  /** The field can't be cleared (an apply can't set it to empty). Default false. */
  required?: boolean;
  /** One line telling the model what belongs here: "When the work is due". */
  hint?: string;
}

/**
 * Who may use AI on a record, as conditions on the person's role, so an app passes its rbac checks rather
 * than a role list: `write: (role) => rbac.has(role, "notes.write")`. Each is optional; an omitted one
 * allows everyone signed in. They need a `role` column on the user table.
 */
export interface AiAccess {
  /** May run AI on a record they can see (summarise, draft, extract). */
  read?: (role: Value) => Condition;
  /** May apply AI's suggestions to the record. */
  write?: (role: Value) => Condition;
  /** May act on records they don't own (only with `owner`). Omitted: nobody may. */
  others?: (role: Value) => Condition;
}

/** One record type AI can work on. The key of `records` is its name on the wire: "note". */
export interface AiRecordType {
  /** The table the records live in. */
  table: AnyTableDef;
  /** What one record is called, lower case: "note". */
  label?: string;
  /** The column that names a record ("title"), for approval titles. Default: the first text field. */
  titleField?: string;
  /** The column holding the owner's user id. Set it and people only reach their own records (see `can.others`). */
  owner?: string;
  /**
   * What the model reads about the record: a list of columns (written as "Label: value" lines), or a
   * function taking `{ record_id, actor_id }` and returning the context as text (for joins, comments…).
   */
  context: readonly string[] | AnyFunctionDef;
  /** The fields AI may write, with their rules. Nothing outside this list is ever written. */
  fields: Record<string, AiFieldSpec>;
  /** Offer a summary. Default true. */
  summarise?: boolean;
  /** Text fields AI may draft (e.g. a reply or a body). Default none. */
  draft?: readonly string[];
  /** Fields AI may fill from pasted text. Default none. */
  extract?: readonly string[];
  /** Role conditions. See {@link AiAccess}. */
  can?: AiAccess;
  /**
   * Send applies for approval instead of writing them (needs the top-level `approvals`). Default: true
   * when `approvals` is set.
   */
  approval?: boolean;
  /** Where the record opens in the app, for an approval card: "/notes/{id}". */
  link?: string;
  /**
   * Turns on the module's generated Xano workflow tests for this type: a valid starting row (the owner column
   * is filled in), and a role every test person gets (must pass `can`).
   */
  test?: { row: Record<string, unknown>; role?: string };
}

export interface AiRateLimit {
  /** AI runs per person per window. Default {@link DEFAULT_AI_RATE_LIMIT.max}. */
  max?: number;
  /** The window in seconds. Default {@link DEFAULT_AI_RATE_LIMIT.ttl}. */
  ttl?: number;
}

export interface AiActionsOptions {
  /** The auth table: whose ids `actor_id` and the usage log hold. Needs a `role` column to use `can`. */
  user: AnyTableDef;
  /** The record types AI can work on, by wire name. */
  records: Record<string, AiRecordType>;
  /**
   * The model, exactly as the chatbot takes it (`llm` there). Default `{ type: "xano-free" }`. A keyed
   * provider names its key as `apiKey: "{{ $env.OPENAI_KEY }}"`: when that variable is empty the actions
   * say "AI isn't connected" rather than failing.
   */
  llm?: ChatbotLlmOptions;
  /**
   * Answer with a deterministic test provider whenever no provider key is set — for the local engine
   * (which has no model) and for tests. With `xano-free`, which has no key, it always answers. Default false.
   * The answers are marked as test mode in the UI. Never turn it on in production.
   */
  stub?: boolean;
  /** Per-person runs per window, counted from the usage log. Default 30 per hour. `false` turns it off. */
  rateLimit?: AiRateLimit | false;
  /**
   * Gate applies through `@xano-sdk/agents` approvals. `action` is the key you gave `ai.applyFn` in
   * `defineApprovals({ actions })`. Referenced by name, so this package doesn't depend on agents.
   */
  approvals?: { action: string; label?: string };
  /** Pin the API group's URL segment: /api:<canonical>/ai/... */
  canonical?: string;
  /** Characters of record context the model is given, at most. Default 6000. */
  contextLimit?: number;
  /** Characters a person may paste for extract, at most. Default 8000. */
  pasteLimit?: number;
  /** Tags on every def. Default ["xano:chatbot", "xano:ai-actions"]. */
  tags?: string[];
  /**
   * Statements to run after an apply writes, e.g. the base app's realtime publish:
   * `onApply: ({ type, id }) => [changed(type, id)]`. Given the record type, its id and the person's id.
   */
  onApply?: (e: { type: string; id: Value; actor: Value }) => Statement[];
}

export const DEFAULT_AI_RATE_LIMIT = { max: 30, ttl: 3600 } as const;
export const DEFAULT_CONTEXT_LIMIT = 6000;
export const DEFAULT_PASTE_LIMIT = 8000;
/** The longest instruction a draft takes. */
export const INSTRUCTION_LIMIT = 500;

/** What the model is told on every AI action. The per-action instruction follows in the run prompt. */
export const AI_ACTIONS_SYSTEM_PROMPT =
  "You help people work on one record in a business app. Do exactly what the instruction asks. " +
  "Use only the record and the text you are given: never invent names, numbers, dates or facts. " +
  "Write plain text without Markdown headings, and never output HTML.";

export const AI_ACTIONS = ["summarise", "draft", "extract"] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

export interface ResolvedRecordType {
  key: string;
  table: AnyTableDef;
  label: string;
  titleField: string | undefined;
  owner: string | undefined;
  context: readonly string[] | AnyFunctionDef;
  fields: Record<string, Required<Pick<AiFieldSpec, "type" | "label" | "required">> & AiFieldSpec>;
  summarise: boolean;
  draft: string[];
  extract: string[];
  can: AiAccess;
  approval: boolean;
  link: string | undefined;
  test: { row: Record<string, unknown>; role?: string } | undefined;
}

export interface ResolvedAiOptions {
  user: AnyTableDef;
  roleColumn: boolean;
  records: ResolvedRecordType[];
  llm: LlmSettings;
  /** The env var holding the provider key, when the key is `{{ $env.NAME }}`. */
  keyEnv: string | undefined;
  stub: boolean;
  rateLimit: { max: number; ttl: number } | false;
  approvals: { action: string; label: string } | undefined;
  canonical: string | undefined;
  contextLimit: number;
  pasteLimit: number;
  tags: string[];
}

type Column = { type?: string; values?: readonly string[]; options?: { values?: readonly string[] } };
/** A table def's columns, read without widening the def's own type. */
export const columnsOf = (t: AnyTableDef): Record<string, Column> =>
  (t as unknown as { schema?: Record<string, Column> }).schema ?? {};
const tableName = (t: AnyTableDef) => (t as unknown as { name?: string }).name ?? "?";

/** "due_on" → "Due on". */
export const sentenceCase = (name: string) => {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const WIRE_NAME = /^[a-z][a-z0-9_]*$/;
const fail = (msg: string): never => {
  throw new Error(`defineAiActions: ${msg}`);
};
const positiveInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

export function resolveAiOptions(opts: AiActionsOptions): ResolvedAiOptions {
  if (!opts || typeof opts !== "object") fail("pass { user, records }.");
  if (!opts.user || typeof opts.user !== "object") {
    fail("`user` must be your auth table's handle (the table people sign in with). It is undefined here — usually a circular import.");
  }
  const roleColumn = "role" in columnsOf(opts.user);
  const entries = Object.entries(opts.records ?? {});
  if (!entries.length) fail("name at least one record type: records: { note: { table: note, context: [...], fields: {...} } }.");

  const records = entries.map(([key, r]): ResolvedRecordType => {
    const where = `records.${key}`;
    if (!WIRE_NAME.test(key)) fail(`record type "${key}" must be lower case letters, digits and _ (it is a wire name).`);
    if (!r || !r.table) fail(`${where}.table is missing.`);
    const cols = columnsOf(r.table);
    const has = (c: string) => c === "id" || c === "created_at" || c in cols;
    const fieldsIn = Object.entries(r.fields ?? {});
    if (!fieldsIn.length) fail(`${where}.fields names no fields. List the columns AI may write, with their rules.`);
    const fields: ResolvedRecordType["fields"] = {};
    for (const [name, spec] of fieldsIn) {
      const at = `${where}.fields.${name}`;
      if (!has(name)) fail(`${at}: table "${tableName(r.table)}" has no column "${name}".`);
      if (name === "id" || name === "created_at" || name === r.owner) fail(`${at}: "${name}" can never be written by AI.`);
      const types: AiFieldType[] = ["text", "enum", "int", "decimal", "bool", "date"];
      if (!spec || !types.includes(spec.type)) fail(`${at}.type must be one of ${types.join(", ")}.`);
      if (spec.type === "enum") {
        const values = spec.values ?? cols[name]?.options?.values ?? cols[name]?.values;
        if (!values?.length) fail(`${at}: an enum field needs \`values\` (or an enum column to read them from).`);
        if (values!.some((v) => typeof v !== "string" || !v.length)) fail(`${at}.values must be non-empty strings.`);
        fields[name] = { ...spec, values: [...values!], label: spec.label ?? sentenceCase(name), required: spec.required ?? false };
        continue;
      }
      if (spec.values !== undefined) fail(`${at}: only an enum field takes \`values\`.`);
      for (const k of ["min", "max"] as const) {
        const v = spec[k];
        if (v === undefined) continue;
        if (spec.type === "bool" || spec.type === "date") fail(`${at}: a ${spec.type} field takes no ${k}.`);
        if (spec.type === "text" ? !(Number.isInteger(v) && v >= 0) : typeof v !== "number" || !Number.isFinite(v)) {
          fail(`${at}.${k} ${JSON.stringify(v)} is not valid${spec.type === "text" ? " (a character count)" : ""}.`);
        }
      }
      if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) fail(`${at}: min is above max.`);
      fields[name] = { ...spec, label: spec.label ?? sentenceCase(name), required: spec.required ?? false };
    }
    const draft = [...(r.draft ?? [])];
    for (const d of draft) {
      if (!fields[d]) fail(`${where}.draft names "${d}", which isn't in fields. AI only writes fields you list.`);
      if (fields[d]!.type !== "text") fail(`${where}.draft names "${d}", a ${fields[d]!.type} field. Only text fields can be drafted.`);
    }
    const extract = [...(r.extract ?? [])];
    for (const x of extract) if (!fields[x]) fail(`${where}.extract names "${x}", which isn't in fields.`);
    if (new Set(draft).size !== draft.length || new Set(extract).size !== extract.length) fail(`${where}: a field is listed twice.`);
    const summarise = r.summarise ?? true;
    if (!summarise && !draft.length && !extract.length) fail(`${where} turns every action off. Offer at least one.`);

    if (Array.isArray(r.context)) {
      if (!r.context.length) fail(`${where}.context names no columns.`);
      for (const c of r.context) if (!has(c)) fail(`${where}.context: table "${tableName(r.table)}" has no column "${c}".`);
    } else if (!r.context || typeof r.context !== "object") {
      fail(`${where}.context must be a list of columns or a function def.`);
    } else {
      const inputs = Object.keys((r.context as { input?: object }).input ?? {});
      if (!inputs.includes("record_id")) fail(`${where}.context: the function must take a \`record_id\` input (and may take \`actor_id\`).`);
    }

    if (r.owner !== undefined && !has(r.owner)) fail(`${where}.owner: table "${tableName(r.table)}" has no column "${r.owner}".`);
    const can = r.can ?? {};
    for (const k of ["read", "write", "others"] as const) {
      if (can[k] !== undefined && typeof can[k] !== "function") fail(`${where}.can.${k} must be a function of the role: (role) => rbac.has(role, "…").`);
    }
    if ((can.read || can.write || can.others) && !roleColumn) {
      fail(`${where}.can needs a \`role\` column on the user table, which "${tableName(opts.user)}" doesn't have.`);
    }
    if (can.others && r.owner === undefined) fail(`${where}.can.others only means something with \`owner\`.`);
    const titleField = r.titleField ?? Object.keys(fields).find((f) => fields[f]!.type === "text");
    if (r.titleField !== undefined && !has(r.titleField)) fail(`${where}.titleField: no column "${r.titleField}".`);
    if (r.approval && !opts.approvals) fail(`${where}.approval needs the top-level \`approvals: { action }\`.`);
    if (r.link !== undefined && (typeof r.link !== "string" || !r.link.startsWith("/"))) fail(`${where}.link must be an app path like "/notes/{id}".`);
    if (r.test !== undefined) {
      if (!r.test.row || typeof r.test.row !== "object") fail(`${where}.test.row must be a starting row.`);
      if (r.test.role !== undefined && !roleColumn) fail(`${where}.test.role needs a role column on the user table.`);
      if (r.test.role === undefined && (can.read || can.write)) fail(`${where}.test.role: name a role that passes \`can\`, so the generated tests' people may use AI.`);
    }
    return {
      key, table: r.table, label: r.label ?? key.replace(/_/g, " "), titleField, owner: r.owner, context: r.context, fields,
      summarise, draft, extract, can, approval: r.approval ?? opts.approvals !== undefined, link: r.link, test: r.test,
    };
  });

  let rateLimit: ResolvedAiOptions["rateLimit"] = false;
  if (opts.rateLimit !== false) {
    const rl = opts.rateLimit ?? {};
    const max = rl.max ?? DEFAULT_AI_RATE_LIMIT.max;
    const ttl = rl.ttl ?? DEFAULT_AI_RATE_LIMIT.ttl;
    if (!positiveInt(max) || !positiveInt(ttl)) fail("rateLimit.max and rateLimit.ttl must be positive integers (or pass rateLimit: false).");
    rateLimit = { max, ttl };
  }

  const llmIn = (opts.llm ?? {}) as Record<string, unknown>;
  for (const k of ["prompt", "messages"]) {
    if (llmIn[k] !== undefined) fail(`llm.${k} is not configurable: each action writes its own prompt. Put standing instructions in llm.systemPrompt.`);
  }
  const llm = {
    type: "xano-free",
    ...llmIn,
    systemPrompt: (llmIn.systemPrompt as string | undefined) ?? AI_ACTIONS_SYSTEM_PROMPT,
    prompt: "{{ $args.prompt }}",
  } as LlmSettings;
  const apiKey = typeof llmIn.apiKey === "string" ? llmIn.apiKey : "";
  const keyEnv = /\{\{\s*\$env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/.exec(apiKey)?.[1];

  if (opts.approvals !== undefined) {
    if (!opts.approvals || typeof opts.approvals.action !== "string" || !opts.approvals.action) {
      fail('approvals.action must name the key you gave ai.applyFn in defineApprovals({ actions: { apply_ai: { fn: ai.applyFn, … } } }).');
    }
  }
  if (opts.canonical !== undefined && !/^[A-Za-z0-9_-]+$/.test(opts.canonical)) {
    fail(`canonical ${JSON.stringify(opts.canonical)} is not a valid URL segment; use [A-Za-z0-9_-]+.`);
  }
  const contextLimit = opts.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const pasteLimit = opts.pasteLimit ?? DEFAULT_PASTE_LIMIT;
  if (!positiveInt(contextLimit) || !positiveInt(pasteLimit)) fail("contextLimit and pasteLimit must be positive integers.");

  return {
    user: opts.user, roleColumn, records, llm, keyEnv, stub: opts.stub === true, rateLimit,
    approvals: opts.approvals ? { action: opts.approvals.action, label: opts.approvals.label ?? "AI actions" } : undefined,
    canonical: opts.canonical, contextLimit, pasteLimit, tags: opts.tags ?? ["xano:chatbot", "xano:ai-actions"],
  };
}
