/**
 * `defineAiActions` — AI inside the workflow, on one record: summarise it, draft a field, or fill fields
 * from pasted text. With the assistant's safety rules:
 *
 * - **Actions never write.** summarise/draft/extract only read and answer. Writing is `ai/apply`, a
 *   separate call that takes only allowlisted fields, re-validates them, and runs under the person's own
 *   permission (or is sent for approval through `@xano-sdk/agents`).
 * - **The model's output is validated on the server** against each field's rules (type, enum values,
 *   length, range, real dates). Anything invalid or outside the allowlist is dropped and reported.
 * - **Per-person rate limit and a usage log** (`ai_usage`), counted from the log itself.
 * - **The provider is the chatbot's** (`llm`), with a deterministic `stub` for the local engine and tests,
 *   and an "AI isn't connected" answer when a keyed provider has no key.
 *
 * Logic lives in functions that take the person's id (`actor_id`), because a Xano workflow test can't pass
 * an endpoint's auth; the endpoints add sign-in and nothing else.
 */
import {
  agent, and, apiGroup, auth, c, caught, col, cond, defineFunction, env, expr, f, fl, guard, inp, input, obj, or, query, ref, s,
  table, withFilters,
  type Condition, type Statement, type Value, type Xano,
} from "@xano/sdk";
import { columnsOf, INSTRUCTION_LIMIT, resolveAiOptions, type AiActionsOptions, type ResolvedAiOptions, type ResolvedRecordType } from "./options.js";
import { validateFn } from "./validate.js";
import { aiWorkflowTests } from "./tests.js";
import { AI_CONTRACT, type AiApplyResult, type AiInfo, type AiRunResult, type AiUsageEntry } from "./types.js";

/** What the actions say when there's no model to call. The React parts recognise it. */
export const NOT_CONNECTED = "AI isn't connected yet. Ask an admin to add the AI provider key.";
export const MODEL_FAILED = "The AI couldn't answer just now. Try again in a moment.";
/** The engine's answer when the keyless model isn't available (the local engine). */
const NO_FREE_MODEL = "not available in this process";
/** A stub answer's marker, so a test-mode answer is never mistaken for a model's. */
export const STUB_PREFIX = "Test mode: ";

/** A line of pasted text the stub reads as "field: value". */
const STUB_LINE = /^\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*[:=]\s*(.+?)\s*$/;
const FALSE = expr(c.int(1), "=", c.int(0));
const node = (cnd: Condition) => (Array.isArray(cnd) ? and(...cnd) : cnd);
const plural = (label: string) => (label.endsWith("s") ? label : `${label}s`);
const windowWords = (ttl: number) =>
  ttl === 3600 ? "hour" : ttl === 86400 ? "day" : ttl % 3600 === 0 ? `${ttl / 3600} hours` : ttl % 60 === 0 ? `${ttl / 60} minutes` : `${ttl} seconds`;

/** Text built from parts at runtime: `concat("a", ref("b"), "c")`. */
const concat = (...parts: (string | Value)[]) => {
  const [first, ...rest] = parts.map((p) => (typeof p === "string" ? c.text(p) : p));
  return rest.length ? withFilters(first!, ...rest.map((p) => fl.concat(p))) : first!;
};

export function defineAiActions(opts: AiActionsOptions) {
  const o = resolveAiOptions(opts);
  const installed = new WeakSet<object>();
  const keys = o.records.map((r) => r.key) as [string, ...string[]];
  const userCols = columnsOf(o.user);
  /** The model is reachable unless the stub answers everything (stub with a keyless provider). */
  const modelPath = !(o.stub && !o.keyEnv);

  const usage = table({
    name: "ai_usage",
    description: "Every AI action on a record: who ran it, on what, and how it went. Rows are only added; the rate limit counts them.",
    useXdo: false,
    tags: o.tags,
    schema: {
      user_id: f.tableRef(o.user, { required: true }),
      action: f.enum(["summarise", "draft", "extract", "apply"], { required: true }),
      record_type: f.text(),
      record_id: f.int(),
      field: f.text(),
      status: f.enum(["started", "ok", "failed"], { required: true }),
      provider: f.text(),
      chars_in: f.int(),
      chars_out: f.int(),
      dropped: f.int(),
      error: f.text(),
    },
    index: [{ type: "btree", fields: [{ name: "user_id", op: "asc" }, { name: "created_at", op: "desc" }] }],
  });

  const aiAgent = agent({
    name: "ai_actions_agent",
    description: "Runs one AI action on one record: a summary, a draft, or values pulled from pasted text.",
    tags: o.tags,
    llm: o.llm,
  });

  // ── Per record type: load (with permission), validate, apply ─────────────────────────────────────────
  const perType = o.records.map((rt) => {
    const validate = validateFn(o, rt);
    const notFound = `This ${rt.label} isn't available.`;
    const contextStatements: Statement[] = Array.isArray(rt.context)
      ? [s.set_var("context", concat(c.text(""), ...(rt.context as readonly string[]).flatMap((col_, i) => {
          const type = columnsOf(rt.table)[col_]?.type;
          const value = type === "json" || type === "object" || (typeof type === "string" && type.endsWith("[]"))
            ? withFilters(ref(`record.${col_}`), fl.json_encode())
            : type === "timestamp" ? withFilters(ref(`record.${col_}`), fl.epochms_date(c.text("Y-m-d H:i")))
            : withFilters(ref(`record.${col_}`), fl.to_text());
          const label = rt.fields[col_]?.label ?? col_.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
          return [`${i ? "\n" : ""}${label}: `, value];
        })))]
      : [
          s.function.run({
            fn: rt.context as never,
            input: {
              record_id: inp("record_id"),
              ...("actor_id" in ((rt.context as { input?: object }).input ?? {}) ? { actor_id: inp("actor_id") } : {}),
            } as Record<string, Value>,
            as: "ctx",
          }),
          s.set_var("context", withFilters(ref("ctx"), fl.json_encode())),
          s.conditional({ when: expr(withFilters(ref("ctx"), fl.is_text()), "=", c.bool(true)), then: [s.update_var("context", ref("ctx"))] }),
        ];

    const load = defineFunction({
      name: `ai/${rt.key}/load`,
      description: `Loads a ${rt.label} for an AI action, refusing people who may not use it. Returns the record and its context as text.`,
      tags: o.tags,
      input: {
        actor_id: input.int({ required: true }),
        record_id: input.int({ required: true }),
        write: input.bool({ description: "Also require permission to change the record." }),
      },
      stack: [
        s.db.get({ table: o.user, fieldValue: inp("actor_id"), output: o.roleColumn ? ["id", "role"] : ["id"], as: "me" }),
        guard.found("me", { errorType: "unauthorized", message: "Sign in again." }),
        s.db.get({ table: rt.table, fieldValue: inp("record_id"), as: "record" }),
        guard.found("record", { errorType: "notfound", message: notFound }),
        // Someone else's record answers exactly like a missing one, so ids can't be probed.
        ...(rt.owner
          ? [guard.require(
              rt.can.others
                ? or(expr(ref(`record.${rt.owner}`), "=", inp("actor_id")), node(rt.can.others(ref("me.role"))))
                : expr(ref(`record.${rt.owner}`), "=", inp("actor_id")),
              { errorType: "notfound", message: notFound },
            )]
          : []),
        ...(rt.can.read ? [guard.require(rt.can.read(ref("me.role")), { errorType: "accessdenied", message: `You can't use AI on ${plural(rt.label)}.` })] : []),
        ...(rt.can.write
          ? [guard.require(or(expr(inp("write"), "!=", c.bool(true)), node(rt.can.write(ref("me.role")))), { errorType: "accessdenied", message: `You can't change this ${rt.label}.` })]
          : []),
        ...contextStatements,
        s.update_var("context", withFilters(ref("context"), fl.substr(c.int(0), c.int(o.contextLimit)))),
      ],
      response: { record: ref("record"), context: ref("context") },
      responseShape: {} as { record: Record<string, unknown>; context: string },
    });

    const fieldNames = Object.keys(rt.fields);
    const returned = [...new Set(["id", ...(rt.titleField ? [rt.titleField] : []), ...fieldNames])];
    const refuseDropped = (checked: string) => [
      s.conditional({
        when: expr(withFilters(ref(`${checked}.dropped`), fl.count()), ">", c.int(0)),
        then: [
          s.set_var("refusal", concat("Can't save “", ref(`${checked}.dropped.0.field`, { safe: true }), "”: ", ref(`${checked}.dropped.0.reason`, { safe: true }))),
          s.precondition({ expr: FALSE, error_type: "badrequest", error: ref("refusal") }),
        ],
      }),
      guard.require(expr(withFilters(ref(`${checked}.fields`), fl.count()), ">", c.int(0)), { errorType: "badrequest", message: "There's nothing to apply." }),
    ];

    const apply = defineFunction({
      name: `ai/${rt.key}/apply`,
      description: `Writes AI-suggested values to a ${rt.label}: only its allowlisted fields, re-validated, as the person (who must be allowed to change it).`,
      tags: o.tags,
      input: {
        actor_id: input.int({ required: true }),
        record_id: input.int({ required: true }),
        values: input.json({ description: "Field → value. Only the allowlisted fields can be written." }),
      },
      stack: [
        s.function.run({ fn: load, input: { actor_id: inp("actor_id"), record_id: inp("record_id"), write: c.bool(true) }, as: "loaded" }),
        s.function.run({ fn: validate, input: { values: inp("values"), allow_clear: c.bool(true) }, as: "checked" }),
        // Refuse the whole write when anything is off, rather than write part of what the person saw.
        ...refuseDropped("checked"),
        s.db.patch({ table: rt.table, fieldValue: inp("record_id"), data: ref("checked.values"), output: returned as never, as: "updated" }),
        s.db.add({ table: usage, row: {
          created_at: c.now(), user_id: inp("actor_id"), action: c.text("apply"), record_type: c.text(rt.key), record_id: inp("record_id"),
          field: withFilters(ref("checked.fields"), fl.join(c.text(","))), status: c.text("ok"), provider: c.text(""),
          chars_in: c.int(0), chars_out: c.int(0), dropped: c.int(0), error: c.text(""),
        } }),
        ...(opts.onApply?.({ type: rt.key, id: inp("record_id"), actor: inp("actor_id") }) ?? []),
      ],
      response: { status: c.text("applied"), applied: ref("checked.fields"), record: ref("updated"), approval_id: c.null() },
      responseShape: {} as AiApplyResult,
    });

    return { rt, load, validate, apply, refuseDropped, fieldNames };
  });

  // ── The approvals action: apply as the approver ──────────────────────────────────────────────────────
  const recordType = () => input.enum(keys, { required: true, description: "The record type, as named in records." });

  const applyFn = defineFunction({
    name: "ai/apply",
    description: "Writes AI-suggested values to a record as `actor_id`, under their permission. The approvals action for AI changes.",
    tags: o.tags,
    input: { actor_id: input.int({ required: true }), record_type: recordType(), record_id: input.int({ required: true }), values: input.json() },
    stack: [
      s.set_var("result", c.null()),
      s.switch({
        on: inp("record_type"),
        cases: perType.map(({ rt, apply }) => ({
          when: c.text(rt.key),
          break: true,
          body: [
            s.function.run({ fn: apply, input: { actor_id: inp("actor_id"), record_id: inp("record_id"), values: inp("values") }, as: "applied" }),
            s.update_var("result", ref("applied")),
          ],
        })),
      }),
    ],
    response: ref("result"),
    responseShape: {} as AiApplyResult,
  });

  /** Apply now, or (for an approval-gated type) record a request and write nothing. */
  const requestApplyFn = defineFunction({
    name: "ai/request_apply",
    description: "The apply endpoint's logic: writes now, or sends the change for approval when the record type is gated.",
    tags: o.tags,
    input: { actor_id: input.int({ required: true }), record_type: recordType(), record_id: input.int({ required: true }), values: input.json() },
    stack: [
      s.set_var("result", c.null()),
      s.switch({
        on: inp("record_type"),
        cases: perType.map(({ rt, load, validate, refuseDropped }) => ({
          when: c.text(rt.key),
          break: true,
          body: rt.approval && o.approvals
            ? [
                // The person asking must be able to see the record; the approver's own permission to change it
                // is checked when they approve (ai/apply runs as them).
                s.function.run({ fn: load, input: { actor_id: inp("actor_id"), record_id: inp("record_id"), write: c.bool(false) }, as: "loaded" }),
                s.function.run({ fn: validate, input: { values: inp("values"), allow_clear: c.bool(true) }, as: "checked" }),
                ...refuseDropped("checked"),
                s.set_var("preview", c.text("")),
                ...Object.entries(rt.fields).map(([name, spec]) => s.conditional({
                  when: expr(withFilters(ref("checked.values"), fl.has(c.text(name))), "=", c.bool(true)),
                  then: [s.update_var("preview", concat(ref("preview"), `${spec.label}: `, withFilters(ref("checked.values"), fl.get(c.text(name)), fl.to_text(), fl.substr(c.int(0), c.int(200))), "\n"))],
                })),
                s.function.run({
                  fn: "approvals/request",
                  input: {
                    user_id: inp("actor_id"),
                    source: c.text("assistant"),
                    agent_label: c.text(o.approvals.label),
                    connection_id: c.int(0),
                    action: c.text(o.approvals.action),
                    title: rt.titleField
                      ? concat(`Apply AI changes to the ${rt.label} “`, withFilters(ref(`loaded.record.${rt.titleField}`), fl.to_text()), "”")
                      : c.text(`Apply AI changes to a ${rt.label}`),
                    preview: withFilters(ref("preview"), fl.trim()),
                    link: rt.link ? withFilters(c.text(rt.link), fl.string_replace(c.text("{id}"), withFilters(inp("record_id"), fl.to_text()))) : c.text(""),
                    payload: obj({ record_type: c.text(rt.key), record_id: inp("record_id"), values: ref("checked.values") }),
                  },
                  as: "approval",
                }),
                s.update_var("result", obj({ status: c.text("pending"), applied: ref("checked.fields"), record: c.null(), approval_id: ref("approval.approval_id") })),
              ]
            : [
                s.function.run({ fn: applyFn, input: { actor_id: inp("actor_id"), record_type: c.text(rt.key), record_id: inp("record_id"), values: inp("values") }, as: "applied" }),
                s.update_var("result", ref("applied")),
              ],
        })),
      }),
    ],
    response: ref("result"),
    responseShape: {} as AiApplyResult,
  });

  // ── Running an action ───────────────────────────────────────────────────────────────────────────────
  const rl = o.rateLimit;
  const usedCount = (who: Value): Statement[] => rl
    ? [
        s.set_var("window_start", withFilters(c.now(), fl.sub(c.int(rl.ttl * 1000)))),
        s.db.query({
          table: usage,
          where: [expr(col("user_id"), "=", who), expr(col("action"), "!=", c.text("apply")), expr(col("created_at"), ">", ref("window_start"))],
          returnType: "count",
          as: "used",
        }),
      ]
    : [s.set_var("used", c.int(0))];

  /**
   * The rate-limit decision, as a function so a workflow test can check it: a 429 precondition does NOT
   * raise inside a workflow test on the local engine (it is swallowed and the stack carries on), so the
   * guard in ai/run can only be proven over HTTP. test/encode.test.ts pins that guard instead.
   */
  const limitFn = defineFunction({
    name: "ai/limit",
    description: "How many AI runs the person has used in the window, and whether they're over the limit.",
    tags: o.tags,
    input: { actor_id: input.int({ required: true }) },
    stack: [
      ...usedCount(inp("actor_id")),
      s.set_var("over", c.bool(false)),
      ...(rl ? [s.conditional({ when: expr(ref("used"), ">=", c.int(rl.max)), then: [s.update_var("over", c.bool(true))] })] : []),
    ],
    response: { used: ref("used"), max: c.int(rl ? rl.max : 0), over: ref("over") },
    responseShape: {} as { used: number; max: number; over: boolean },
  });

  /** "stub" or "model", decided per request. */
  const providerStatements: Statement[] = [
    s.set_var("provider", c.text(o.stub ? "stub" : "model")),
    ...(o.stub && o.keyEnv ? [s.conditional({ when: cond.notEmpty(env(o.keyEnv)), then: [s.update_var("provider", c.text("model"))] })] : []),
  ];

  const typeSetup = ({ rt, load }: (typeof perType)[number]): Statement[] => {
    const allowed = [...(rt.summarise ? ["summarise"] : []), ...(rt.draft.length ? ["draft"] : []), ...(rt.extract.length ? ["extract"] : [])];
    const spec = rt.extract.map((name) => {
      const fs = rt.fields[name]!;
      const rule = fs.type === "enum" ? `one of: ${fs.values!.join(", ")}`
        : fs.type === "date" ? "a date as YYYY-MM-DD"
        : fs.type === "bool" ? "true or false"
        : fs.type === "int" ? `a whole number${fs.min !== undefined ? ` from ${fs.min}` : ""}${fs.max !== undefined ? ` up to ${fs.max}` : ""}`
        : fs.type === "decimal" ? "a number"
        : `text${fs.max !== undefined ? `, at most ${fs.max} characters` : ""}`;
      return `- "${name}" (${fs.label}): ${rule}${fs.hint ? `. ${fs.hint}` : ""}`;
    }).join("\n");
    return [
      guard.require(cond.in(inp("action"), c.array(allowed)), { errorType: "badrequest", message: `That AI action isn't available for ${plural(rt.label)}.` }),
      guard.require(or(expr(inp("action"), "!=", c.text("draft")), cond.in(inp("field"), c.array(rt.draft))), { errorType: "badrequest", message: `AI can't draft that part of a ${rt.label}.` }),
      s.function.run({ fn: load, input: { actor_id: inp("actor_id"), record_id: inp("record_id"), write: c.bool(false) }, as: "loaded" }),
      s.update_var("context", ref("loaded.context")),
      s.update_var("current", obj(Object.fromEntries(Object.keys(rt.fields).map((n) => [n, ref(`loaded.record.${n}`, { safe: true })])))),
      s.update_var("label", c.text(rt.label)),
      s.update_var("draft_max", withFilters(c.obj(Object.fromEntries(rt.draft.map((d) => [d, rt.fields[d]!.max ?? 5000]))), fl.get(inp("field"), c.int(5000)))),
      s.update_var("field_label", withFilters(c.obj(Object.fromEntries(rt.draft.map((d) => [d, rt.fields[d]!.label.toLowerCase()]))), fl.get(inp("field"), c.text("text")))),
      s.update_var("extract_spec", c.text(spec)),
    ];
  };

  const stubStatements: Statement[] = [
    s.set_var("flat", withFilters(c.regex(/\s+/), fl.regex_replace(c.text(" "), ref("context")), fl.trim())),
    s.conditional({
      when: expr(inp("action"), "=", c.text("summarise")),
      then: [s.update_var("answer", concat(STUB_PREFIX, "a short summary of this ", ref("label"), ". ", withFilters(ref("flat"), fl.substr(c.int(0), c.int(240)))))],
      elif: [{
        when: expr(inp("action"), "=", c.text("draft")),
        then: [s.update_var("answer", concat(STUB_PREFIX, withFilters(inp("instruction"), fl.trim()), "\n\n", withFilters(ref("flat"), fl.substr(c.int(0), c.int(160)))))],
      }],
      // Extract: every "field: value" line of the pasted text, as the model would propose it — invalid
      // values included, so the server's validation is exercised exactly as with a real model.
      else: [s.foreach({
        list: withFilters(inp("text"), fl.split(c.text("\n"))),
        as: "line",
        body: [
          s.set_var("m", withFilters(c.regex(STUB_LINE), fl.regex_match(ref("line")))),
          s.conditional({
            when: expr(withFilters(ref("m"), fl.count()), "=", c.int(3)),
            then: [
              s.set_var("k", withFilters(c.regex(/[\s-]+/), fl.regex_replace(c.text("_"), withFilters(ref("m"), fl.get(c.text("1")), fl.trim(), fl.lower())))),
              s.update_var("raw_values", withFilters(ref("raw_values"), fl.set(ref("k"), withFilters(ref("m"), fl.get(c.text("2")), fl.trim())))),
            ],
          }),
        ],
      })],
    }),
  ];

  const record = (inner: Value) => concat("\n\n<record>\n", inner, "\n</record>");
  const modelStatements: Statement[] = [
    s.set_var("today", withFilters(c.now(), fl.epochms_date(c.text("l j F Y")))),
    s.conditional({
      when: expr(inp("action"), "=", c.text("summarise")),
      then: [s.update_var("prompt", concat(
        "Summarise this ", ref("label"), " in two to four short sentences for a busy teammate. Lead with what matters most. Plain text only.",
        record(ref("context")),
      ))],
      elif: [{
        when: expr(inp("action"), "=", c.text("draft")),
        then: [s.update_var("prompt", concat(
          "Write the ", ref("field_label"), " for this ", ref("label"), ". The person asks: ", withFilters(inp("instruction"), fl.trim()),
          "\nReply with only the new ", ref("field_label"), ", at most ", withFilters(ref("draft_max"), fl.to_text()),
          " characters, with no preamble or quotes. Today is ", ref("today"), ".",
          record(ref("context")),
        ))],
      }],
      else: [s.update_var("prompt", concat(
        "Read the pasted text and pull out values for these fields of a ", ref("label"), ":\n", ref("extract_spec"),
        "\nReply with ONLY a JSON object using those keys. Leave out any field the text doesn't clearly state; never guess. ",
        "Resolve relative dates against today, ", ref("today"), ".\n\n<pasted>\n", inp("text"), "\n</pasted>",
      ))],
    }),
    s.ai.agent.run({ agent: aiAgent, args: obj({ prompt: ref("prompt") }), as: "run" }),
    s.update_var("answer", withFilters(ref("run.result"), fl.to_text(), fl.trim())),
    s.conditional({
      when: expr(inp("action"), "=", c.text("extract")),
      then: [s.try_catch({
        try: [s.update_var("raw_values", withFilters(c.regex(/^\s*```[a-z]*\s*|\s*```\s*$/i), fl.regex_replace(c.text(""), ref("answer")), fl.json_decode()))],
        catch: [s.update_var("problem", c.text("The AI's answer couldn't be read. Try again."))],
      })],
    }),
  ];

  const providerRun: Statement[] = !modelPath
    ? stubStatements
    : !o.stub
      ? modelStatements
      : [s.conditional({ when: expr(ref("provider"), "=", c.text("stub")), then: stubStatements, else: modelStatements })];

  const runFn = defineFunction({
    name: "ai/run",
    description: "Runs one AI action (summarise, draft, extract) on a record for `actor_id`. Writes nothing to the record.",
    tags: o.tags,
    input: {
      actor_id: input.int({ required: true }),
      record_type: recordType(),
      record_id: input.int({ required: true }),
      action: input.enum(["summarise", "draft", "extract"], { required: true }),
      field: input.text({ description: "draft: the field to write." }),
      instruction: input.text({ description: "draft: what the person wants." }),
      text: input.text({ description: "extract: the pasted text." }),
    },
    stack: [
      // 1. The limit comes first, so probing ids spends the prober's own budget.
      s.function.run({ fn: limitFn, input: { actor_id: inp("actor_id") }, as: "limit" }),
      ...(rl ? [guard.require(expr(ref("limit.over"), "=", c.bool(false)), {
        errorType: "toomanyrequests",
        message: `You've used AI ${rl.max} times in the last ${windowWords(rl.ttl)}. Try again a little later.`,
      })] : []),
      // 2. The inputs each action needs.
      guard.require(or(expr(inp("action"), "!=", c.text("draft")), expr(withFilters(inp("instruction"), fl.trim()), "!=", c.text(""))), { errorType: "badrequest", message: "Say what the draft should do." }),
      guard.require(or(expr(inp("action"), "!=", c.text("draft")), expr(withFilters(inp("instruction"), fl.strlen()), "<=", c.int(INSTRUCTION_LIMIT))), { errorType: "badrequest", message: `Keep the instruction under ${INSTRUCTION_LIMIT} characters.` }),
      guard.require(or(expr(inp("action"), "!=", c.text("extract")), expr(withFilters(inp("text"), fl.trim()), "!=", c.text(""))), { errorType: "badrequest", message: "Paste some text for AI to read." }),
      guard.require(or(expr(inp("action"), "!=", c.text("extract")), expr(withFilters(inp("text"), fl.strlen()), "<=", c.int(o.pasteLimit))), { errorType: "badrequest", message: `That's more than ${o.pasteLimit} characters. Paste a shorter part.` }),
      // 3. The record, as the person may see it.
      s.set_var("context", c.text("")),
      s.set_var("current", c.obj({})),
      s.set_var("label", c.text("")),
      s.set_var("draft_max", c.int(0)),
      s.set_var("field_label", c.text("")),
      s.set_var("extract_spec", c.text("")),
      s.switch({ on: inp("record_type"), cases: perType.map((p) => ({ when: c.text(p.rt.key), break: true, body: typeSetup(p) })) }),
      // 4. Is there a model to ask?
      ...providerStatements,
      ...(!o.stub && o.keyEnv ? [guard.require(cond.notEmpty(env(o.keyEnv)), { errorType: "badrequest", message: NOT_CONNECTED })] : []),
      // 5. Logged before the call, so a run that dies half-way still counts toward the limit.
      s.db.add({ table: usage, as: "log", row: {
        created_at: c.now(), user_id: inp("actor_id"), action: inp("action"), record_type: inp("record_type"), record_id: inp("record_id"),
        field: inp("field"), status: c.text("started"), provider: ref("provider"),
        chars_in: withFilters(ref("context"), fl.strlen(), fl.add(withFilters(inp("text"), fl.strlen()))), chars_out: c.int(0), dropped: c.int(0), error: c.text(""),
      } }),
      s.set_var("prompt", c.text("")),
      s.set_var("answer", c.text("")),
      s.set_var("raw_values", c.obj({})),
      s.set_var("problem", c.text("")),
      s.try_catch({
        try: providerRun,
        catch: [
          s.set_var("err", withFilters(caught("message"), fl.to_text())),
          s.db.patch({ table: usage, fieldValue: ref("log.id"), data: obj({ status: c.text("failed"), error: withFilters(ref("err"), fl.substr(c.int(0), c.int(200))) }) }),
          s.conditional({ when: cond.contains(ref("err"), c.text(NO_FREE_MODEL)), then: [s.precondition({ expr: FALSE, error_type: "badrequest", error: c.text(NOT_CONNECTED) })] }),
          s.precondition({ expr: FALSE, error_type: "standard", error: c.text(MODEL_FAILED) }),
        ],
      }),
      // 6. Shape the answer. A draft never exceeds its field; extract values pass the field rules or are dropped.
      s.set_var("text", c.text("")),
      s.set_var("values", c.obj({})),
      s.set_var("dropped", c.array([])),
      s.conditional({
        when: expr(inp("action"), "=", c.text("summarise")),
        then: [s.update_var("text", withFilters(ref("answer"), fl.substr(c.int(0), c.int(2000))))],
        elif: [{ when: expr(inp("action"), "=", c.text("draft")), then: [s.update_var("text", withFilters(ref("answer"), fl.substr(c.int(0), ref("draft_max"))))] }],
        else: [s.switch({
          on: inp("record_type"),
          cases: perType.map(({ rt, validate }) => ({
            when: c.text(rt.key),
            break: true,
            body: [
              // A field's label is as good as its name ("Due date:" for due_on).
              ...rt.extract.flatMap((n) => {
                const slug = rt.fields[n]!.label.toLowerCase().replace(/[\s-]+/g, "_");
                return slug === n ? [] : [s.conditional({
                  when: and(expr(withFilters(ref("raw_values"), fl.has(c.text(slug))), "=", c.bool(true)), expr(withFilters(ref("raw_values"), fl.has(c.text(n))), "!=", c.bool(true))),
                  then: [s.update_var("raw_values", withFilters(ref("raw_values"), fl.set(c.text(n), withFilters(ref("raw_values"), fl.get(c.text(slug)))), fl.unpick(c.text(slug))))],
                })];
              }),
              // Only the fields this type extracts are proposed; validation then keeps the valid ones.
              s.set_var("asked", withFilters(ref("raw_values"), ...Object.keys(rt.fields).filter((n) => !rt.extract.includes(n)).map((n) => fl.unpick(c.text(n))))),
              s.function.run({ fn: validate, input: { values: ref("asked"), allow_clear: c.bool(false) }, as: "checked" }),
              s.update_var("values", ref("checked.values")),
              s.update_var("dropped", ref("checked.dropped")),
            ],
          })),
        })],
      }),
      s.conditional({
        when: and(expr(inp("action"), "!=", c.text("extract")), expr(ref("text"), "=", c.text(""))),
        then: [s.update_var("problem", c.text("The AI came back empty. Try again."))],
      }),
      s.db.patch({ table: usage, fieldValue: ref("log.id"), data: obj({
        status: c.text("ok"),
        chars_out: withFilters(ref("answer"), fl.strlen()),
        dropped: withFilters(ref("dropped"), fl.count()),
      }) }),
    ],
    response: {
      action: inp("action"), record_type: inp("record_type"), record_id: inp("record_id"), provider: ref("provider"),
      text: ref("text"), field: inp("field"), values: ref("values"), dropped: ref("dropped"), current: ref("current"), problem: ref("problem"),
    },
    responseShape: {} as AiRunResult,
  });

  // ── Endpoints ───────────────────────────────────────────────────────────────────────────────────────
  // History off: these requests carry record content and pasted text.
  const group = apiGroup({ name: "ai", description: "Inline AI actions on records: summarise, draft, fill from text, apply.", tags: o.tags, ...(o.canonical ? { canonical: o.canonical } : {}), history: false });
  const base = { apiGroup: group, auth: o.user, tags: o.tags } as const;

  const can = (rt: ResolvedRecordType, k: "read" | "write"): Statement[] => {
    const v = `can_${rt.key}_${k}`;
    const check = rt.can[k];
    return check ? [s.set_var(v, c.bool(true)), s.conditional({ when: node(check(ref("me.role"))), then: [], else: [s.update_var(v, c.bool(false))] })] : [s.set_var(v, c.bool(true))];
  };

  const info = query({
    ...base,
    name: "ai/info",
    verb: "GET",
    description: "Whether AI is connected, the person's usage against the limit, and what they may do with each record type.",
    input: {},
    stack: [
      s.db.get({ table: o.user, fieldValue: auth("id"), output: o.roleColumn ? ["id", "role"] : ["id"], as: "me" }),
      guard.found("me", { errorType: "unauthorized", message: "Sign in again." }),
      ...usedCount(auth("id")),
      ...providerStatements,
      s.set_var("connected", c.bool(true)),
      ...(!o.stub && o.keyEnv ? [s.conditional({ when: cond.empty(env(o.keyEnv)), then: [s.update_var("connected", c.bool(false))] })] : []),
      ...o.records.flatMap((rt) => [...can(rt, "read"), ...can(rt, "write")]),
    ],
    response: {
      contract: c.int(AI_CONTRACT),
      connected: ref("connected"),
      provider: ref("provider"),
      limit: obj({ max: c.int(rl ? rl.max : 0), ttl: c.int(rl ? rl.ttl : 0), used: ref("used") }),
      paste_limit: c.int(o.pasteLimit),
      instruction_limit: c.int(INSTRUCTION_LIMIT),
      records: obj(Object.fromEntries(o.records.map((rt) => [rt.key, obj({
        label: c.text(rt.label),
        fields: c.array(Object.entries(rt.fields).map(([name, fs]) => ({
          name, label: fs.label, type: fs.type, required: fs.required,
          ...(fs.values ? { values: [...fs.values] } : {}), ...(fs.min !== undefined ? { min: fs.min } : {}), ...(fs.max !== undefined ? { max: fs.max } : {}),
        }))),
        summarise: c.bool(rt.summarise),
        draft: c.array(rt.draft),
        extract: c.array(rt.extract),
        approval: c.bool(rt.approval && !!o.approvals),
        read: ref(`can_${rt.key}_read`),
        write: ref(`can_${rt.key}_write`),
      })]))),
    },
    responseShape: {} as AiInfo,
  });

  const runQuery = (action: "summarise" | "draft" | "extract", extra: Record<string, ReturnType<typeof input.text>>, description: string) =>
    query({
      ...base,
      name: `ai/${action}`,
      verb: "POST",
      description,
      input: { record_type: recordType(), record_id: input.int({ required: true }), ...extra },
      stack: [
        s.function.run({
          fn: runFn,
          as: "result",
          input: {
            actor_id: auth("id"), record_type: inp("record_type"), record_id: inp("record_id"), action: c.text(action),
            field: "field" in extra ? inp("field") : c.text(""),
            instruction: "instruction" in extra ? inp("instruction") : c.text(""),
            text: "text" in extra ? inp("text") : c.text(""),
          },
        }),
      ],
      response: ref("result"),
      responseShape: {} as AiRunResult,
    });

  const summarise = runQuery("summarise", {}, "Summarise a record. Writes nothing.");
  const draft = runQuery("draft", {
    field: input.text({ required: true, description: "The field to draft." }),
    instruction: input.text({ required: true, methods: ["trim"], description: "What the draft should do." }),
  }, "Draft text for one field of a record. Writes nothing: apply it with ai/apply.");
  const extract = runQuery("extract", {
    text: input.text({ required: true, description: "The pasted text to read." }),
  }, "Propose values for a record's fields from pasted text, validated against each field's rules. Writes nothing.");

  const applyQuery = query({
    ...base,
    name: "ai/apply",
    verb: "POST",
    description: "Write AI-suggested values (allowlisted fields only, re-validated) as the signed-in person, or send them for approval.",
    input: { record_type: recordType(), record_id: input.int({ required: true }), values: input.json({ description: "Field → value." }) },
    stack: [
      s.function.run({ fn: requestApplyFn, as: "result", input: { actor_id: auth("id"), record_type: inp("record_type"), record_id: inp("record_id"), values: inp("values") } }),
    ],
    response: ref("result"),
    responseShape: {} as AiApplyResult,
  });

  const usageQuery = query({
    ...base,
    name: "ai/usage",
    verb: "GET",
    description: "The signed-in person's own recent AI use, newest first.",
    input: {},
    stack: [
      s.db.query({
        table: usage,
        where: expr(col("user_id"), "=", auth("id")),
        sort: [{ sortBy: "created_at", dir: "desc" }, { sortBy: "id", dir: "desc" }],
        output: ["id", "created_at", "action", "record_type", "record_id", "field", "status", "provider", "chars_in", "chars_out", "dropped"],
        paging: { per_page: 50, metadata: false },
        as: "rows",
      }),
    ],
    response: ref("rows"),
    responseShape: [] as AiUsageEntry[],
  });

  const queries = { info, summarise, draft, extract, apply: applyQuery, usage: usageQuery };
  const functions = [
    ...perType.flatMap((p) => [p.validate, p.load, p.apply]),
    limitFn, applyFn, requestApplyFn, runFn,
  ];
  const tests = aiWorkflowTests(o, { usage, runFn, limitFn, applyFn, requestApplyFn, perType, userCols });

  return {
    options: o,
    usage,
    agent: modelPath ? aiAgent : undefined,
    group,
    /** Per record type: `load`, `validate`, `apply` functions. */
    records: Object.fromEntries(perType.map((p) => [p.rt.key, { load: p.load, validate: p.validate, apply: p.apply }])),
    /** The approvals action: `defineApprovals({ actions: { apply_ai: { fn: ai.applyFn, label: "Apply AI changes" } } })`. */
    applyFn,
    requestApplyFn,
    runFn,
    limitFn,
    functions,
    queries,
    tests,
    register<X extends Xano>(xano: X): X {
      if (installed.has(xano)) throw new Error("ai.register: already registered on this Xano instance. A second call would duplicate every def.");
      installed.add(xano);
      xano.registerTables([usage]);
      if (modelPath) xano.registerAgents([aiAgent]);
      xano.registerFunctions(functions);
      xano.registerApiGroups([group]);
      xano.registerQueries(Object.values(queries));
      if (tests.length) xano.registerWorkflowTests(tests);
      return xano;
    },
  };
}

/** `defineAiActions(opts).register(xano)`, returning the handle. */
export function registerAiActions<X extends Xano>(xano: X, opts: AiActionsOptions) {
  const ai = defineAiActions(opts);
  ai.register(xano);
  return { ...ai, xano };
}

export type AiActions = ReturnType<typeof defineAiActions>;
export type { ResolvedAiOptions };
