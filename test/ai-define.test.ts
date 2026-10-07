/** `defineAiActions`: what the factory refuses, and the handle it returns. */
import { describe, expect, it } from "vitest";
import { Xano, c, defineFunction, expr, f, input, s, table } from "@xano/sdk";
import { defineAiActions, registerAiActions, resolveAiOptions, type AiActionsOptions } from "../src/index.js";

const person = table({ name: "ai_person", auth: true, useXdo: false, schema: { name: f.text(), email: f.email(), role: f.enum(["admin", "member"]) } });
const noRole = table({ name: "ai_norole", auth: true, useXdo: false, schema: { email: f.email() } });
const doc = table({ name: "ai_doc", useXdo: false, schema: { owner_id: f.int(), title: f.text(), body: f.text(), level: f.enum(["a", "b"]), score: f.int(), on: f.date() } });

const base = (): AiActionsOptions => ({
  user: person,
  records: { doc: { table: doc, owner: "owner_id", context: ["title", "body"], fields: { title: { type: "text", max: 80 }, body: { type: "text" }, level: { type: "enum" } }, draft: ["body"], extract: ["title", "level"] } },
});
const tweak = (fn: (o: AiActionsOptions) => void) => {
  const o = base();
  fn(o);
  return () => defineAiActions(o);
};
const doc$ = (o: AiActionsOptions) => o.records.doc!;

describe("defineAiActions refuses", () => {
  it.each([
    ["no user table", (o: AiActionsOptions) => { (o as { user?: unknown }).user = undefined; }, /`user` must be your auth table/],
    ["no record types", (o: AiActionsOptions) => { o.records = {}; }, /at least one record type/],
    ["a record type name that isn't a wire name", (o: AiActionsOptions) => { o.records = { "Bad-Name": doc$(o) }; }, /lower case/],
    ["no fields", (o: AiActionsOptions) => { doc$(o).fields = {}; doc$(o).draft = []; doc$(o).extract = []; }, /names no fields/],
    ["a field the table doesn't have", (o: AiActionsOptions) => { doc$(o).fields.nope = { type: "text" }; }, /has no column "nope"/],
    ["the owner column as a field", (o: AiActionsOptions) => { doc$(o).fields.owner_id = { type: "int" }; }, /can never be written by AI/],
    ["the primary key as a field", (o: AiActionsOptions) => { doc$(o).fields.id = { type: "int" }; }, /can never be written by AI/],
    ["an unknown field type", (o: AiActionsOptions) => { doc$(o).fields.title = { type: "html" as never }; }, /type must be one of/],
    ["an enum with no values anywhere", (o: AiActionsOptions) => { doc$(o).fields.title = { type: "enum" }; }, /needs `values`/],
    ["values on a non-enum", (o: AiActionsOptions) => { doc$(o).fields.title = { type: "text", values: ["x"] }; }, /only an enum field takes/],
    ["a negative text length", (o: AiActionsOptions) => { doc$(o).fields.title = { type: "text", max: -1 }; }, /is not valid/],
    ["min above max", (o: AiActionsOptions) => { doc$(o).fields.score = { type: "int", min: 5, max: 1 }; }, /min is above max/],
    ["a range on a date", (o: AiActionsOptions) => { doc$(o).fields.on = { type: "date", max: 3 }; }, /takes no max/],
    ["drafting a field that isn't allowlisted", (o: AiActionsOptions) => { doc$(o).draft = ["level_x"]; }, /isn't in fields/],
    ["drafting a non-text field", (o: AiActionsOptions) => { doc$(o).draft = ["level"]; }, /Only text fields can be drafted/],
    ["extracting a field that isn't allowlisted", (o: AiActionsOptions) => { doc$(o).extract = ["owner_id"]; }, /isn't in fields/],
    ["every action off", (o: AiActionsOptions) => { doc$(o).summarise = false; doc$(o).draft = []; doc$(o).extract = []; }, /turns every action off/],
    ["a context column that doesn't exist", (o: AiActionsOptions) => { doc$(o).context = ["nope"]; }, /has no column "nope"/],
    ["a context function without record_id", (o: AiActionsOptions) => { doc$(o).context = defineFunction({ name: "ctx", input: { id: input.int() }, stack: [], response: c.text("") }); }, /must take a `record_id`/],
    ["can without a role column", (o: AiActionsOptions) => { o.user = noRole; doc$(o).can = { write: (r) => expr(r, "=", c.text("admin")) }; }, /needs a `role` column/],
    ["can.others without an owner", (o: AiActionsOptions) => { doc$(o).owner = undefined; doc$(o).can = { others: (r) => expr(r, "=", c.text("admin")) }; }, /only means something with `owner`/],
    ["approval without approvals", (o: AiActionsOptions) => { doc$(o).approval = true; }, /needs the top-level `approvals/],
    ["a link that isn't an app path", (o: AiActionsOptions) => { doc$(o).link = "https://x.test/{id}"; }, /must be an app path/],
    ["a bad rate limit", (o: AiActionsOptions) => { o.rateLimit = { max: 0 }; }, /positive integers/],
    ["a caller-supplied run prompt", (o: AiActionsOptions) => { o.llm = { prompt: "x" } as never; }, /llm.prompt is not configurable/],
    ["a bad canonical", (o: AiActionsOptions) => { o.canonical = "a b"; }, /not a valid URL segment/],
    ["generated tests with can but no test role", (o: AiActionsOptions) => { doc$(o).can = { write: (r) => expr(r, "=", c.text("admin")) }; doc$(o).test = { row: { title: "x" } }; }, /test.role/],
  ])("%s", (_name, mutate, message) => {
    expect(tweak(mutate)).toThrow(message);
  });
});

describe("resolveAiOptions", () => {
  it("fills labels, reads enum values off the column, and defaults the title field", () => {
    const r = resolveAiOptions(base()).records[0]!;
    expect(r.fields.level).toMatchObject({ label: "Level", values: ["a", "b"], required: false });
    expect(r.titleField).toBe("title");
    expect(r.summarise).toBe(true);
    expect(r.approval).toBe(false);
  });
  it("finds the provider key's env var, and owns the run prompt", () => {
    const o = resolveAiOptions({ ...base(), llm: { type: "openai", apiKey: "{{ $env.OPENAI_KEY }}", model: "gpt-4o-mini" } });
    expect(o.keyEnv).toBe("OPENAI_KEY");
    expect((o.llm as { prompt?: string }).prompt).toBe("{{ $args.prompt }}");
    expect(resolveAiOptions(base()).keyEnv).toBeUndefined();
  });
  it("gates every type through approvals once approvals is set, unless a type opts out", () => {
    const o = base();
    o.approvals = { action: "apply_ai" };
    expect(resolveAiOptions(o).records[0]!.approval).toBe(true);
    doc$(o).approval = false;
    expect(resolveAiOptions(o).records[0]!.approval).toBe(false);
  });
});

describe("the handle", () => {
  it("makes fresh defs per call and refuses a second register on one instance", () => {
    const a = defineAiActions(base());
    const b = defineAiActions(base());
    expect(a.usage).not.toBe(b.usage);
    const xano = new Xano().registerWorkspace({ name: "ai-twice" }).registerTables([person, doc]);
    a.register(xano);
    expect(() => a.register(xano)).toThrow(/already registered/);
  });
  it("names the endpoints, the per-type functions and the approvals action", () => {
    const ai = defineAiActions(base());
    expect(Object.values(ai.queries).map((q) => `${q.verb} ${q.name}`)).toEqual([
      "GET ai/info", "POST ai/summarise", "POST ai/draft", "POST ai/extract", "POST ai/apply", "GET ai/usage",
    ]);
    expect(ai.functions.map((f) => f.name)).toEqual([
      "ai/doc/validate", "ai/doc/load", "ai/doc/apply", "ai/limit", "ai/apply", "ai/request_apply", "ai/run",
    ]);
    expect(ai.applyFn.name).toBe("ai/apply");
  });
  it("has no agent when the stub answers everything (stub with a keyless provider)", () => {
    expect(defineAiActions({ ...base(), stub: true }).agent).toBeUndefined();
    expect(defineAiActions(base()).agent).toBeDefined();
    expect(defineAiActions({ ...base(), stub: true, llm: { type: "openai", apiKey: "{{ $env.K }}" } }).agent).toBeDefined();
  });
  it("registerAiActions registers and returns the handle with the instance", () => {
    const xano = new Xano().registerWorkspace({ name: "ai-reg" }).registerTables([person, doc]);
    const ai = registerAiActions(xano, base());
    expect(ai.xano).toBe(xano);
    expect(() => xano.export()).not.toThrow();
  });
  it("generates workflow tests only for types with `test`, and run tests only with the stub", () => {
    const withTest = (stub: boolean) => {
      const o = base();
      o.stub = stub;
      doc$(o).test = { row: { title: "T" } };
      return defineAiActions(o).tests.map((t) => t.name);
    };
    expect(defineAiActions(base()).tests).toEqual([]);
    expect(withTest(false).some((n) => n.includes("never write"))).toBe(false);
    expect(withTest(true)).toEqual(expect.arrayContaining([
      "ai: doc — apply writes only the allowlisted fields",
      "ai: doc — actions answer and never write",
      "ai: doc — extract keeps valid values and reports the rest",
      "ai: each person has their own rate limit",
    ]));
  });
  it("runs onApply's statements after the write", () => {
    const ai = defineAiActions({ ...base(), onApply: ({ id }) => [s.set_var("published", id)] });
    const xano = new Xano().registerWorkspace({ name: "ai-hook" }).registerTables([person, doc]);
    ai.register(xano);
    const fn = (xano.export() as any).payload.function.find((x: any) => x.name === "ai/doc/apply");
    expect(JSON.stringify(fn.run)).toContain('"as":"published"');
  });
});
