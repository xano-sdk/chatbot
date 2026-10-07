/**
 * The load-bearing parts of the AI actions' compiled output — each assertion pins one safety rule, and
 * names it. The behaviour itself is proven on a local engine by `npm run test:live`; these catch a
 * refactor that drops a rule without anyone deploying.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Xano, f, table } from "@xano/sdk";
import { buildAiFixture } from "./ai-fixture.js";
import { defineAiActions, NOT_CONNECTED, type AiActionsOptions } from "../src/index.js";

const payload = () => (buildAiFixture().xano.export() as any).payload;
const md5 = (x: string) => createHash("md5").update(x).digest("hex");
/** Every statement anywhere inside `x`, nested blocks included. */
const walk = (x: any, out: any[] = []): any[] => {
  if (Array.isArray(x)) x.forEach((y) => walk(y, out));
  else if (x && typeof x === "object") {
    if (typeof x.name === "string" && x.name.startsWith("mvp:")) out.push(x);
    Object.values(x).forEach((y) => walk(y, out));
  }
  return out;
};
const fnOf = (p: any, name: string) => p.function.find((x: any) => x.name === name);
const guidOf = (p: any, kind: "dbo" | "function", name: string) => p[kind].find((x: any) => x.name === name).guid;
const WRITES = ["mvp:dbo_add", "mvp:dbo_edit", "mvp:dbo_patch", "mvp:dbo_delete", "mvp:dbo_add_or_edit", "mvp:dbo_bulk_add", "mvp:dbo_bulk_patch", "mvp:dbo_bulk_update", "mvp:dbo_bulk_delete"];

describe("actions never write", () => {
  it("ai/run writes only the usage log, and calls only load, validate and the limit", () => {
    const p = payload();
    const st = walk(fnOf(p, "ai/run").run);
    const usage = guidOf(p, "dbo", "ai_usage");
    const writes = st.filter((x) => WRITES.includes(x.name) || /dbo_(add|edit|patch|del|bulk)/.test(x.name));
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.context.dbo.id).toBe(usage);
    const called = new Set(st.filter((x) => x.name === "mvp:function").map((x) => x.context.function.id));
    const allowed = new Set(["ai/limit", "ai/note/load", "ai/ticket/load", "ai/note/validate", "ai/ticket/validate"].map((n) => guidOf(p, "function", n)));
    for (const id of called) expect(allowed.has(id)).toBe(true);
  });
});

describe("applies write only allowlisted, validated values", () => {
  it("ai/<type>/apply validates first, refuses anything dropped, and patches exactly the validated values", () => {
    const p = payload();
    for (const type of ["note", "ticket"]) {
      const run = fnOf(p, `ai/${type}/apply`).run;
      const st = walk(run);
      const calls = st.filter((x) => x.name === "mvp:function").map((x) => x.context.function.id);
      expect(calls.slice(0, 2)).toEqual([guidOf(p, "function", `ai/${type}/load`), guidOf(p, "function", `ai/${type}/validate`)]);
      // load runs with write: true
      expect(JSON.stringify(run[0].input)).toContain('"name":"write","value":"true"');
      const patches = st.filter((x) => x.name === "mvp:dbo_patch");
      expect(patches).toHaveLength(1);
      expect(patches[0].context.dbo.id).toBe(guidOf(p, "dbo", type));
      expect(JSON.stringify(patches[0])).toContain('"checked.values"');
      // the refusal comes before the write
      const order = run.map((x: any) => x.name);
      expect(order.indexOf("mvp:conditional")).toBeLessThan(order.indexOf("mvp:dbo_patch"));
      expect(JSON.stringify(run[order.indexOf("mvp:conditional")])).toContain('"error_type":"badrequest"');
    }
  });
  it("the validator only ever copies a value under an allowlisted field name", () => {
    const p = payload();
    const allow: Record<string, string[]> = { note: ["title", "body", "priority", "due_on", "stage"], ticket: ["subject", "reply", "urgency"] };
    for (const [type, fields] of Object.entries(allow)) {
      const st = walk(fnOf(p, `ai/${type}/validate`).run);
      const intoOut = st.filter((x) => x.name === "mvp:update_var" && x.context.name === "out");
      expect(intoOut.length).toBeGreaterThanOrEqual(fields.length);
      for (const u of intoOut) {
        const set = u.context.filters.find((fl: any) => fl.name === "set");
        expect(set.arg[0].tag).toBe("const");
        expect(fields).toContain(set.arg[0].value);
      }
    }
  });
  it("ships unit tests on every validator (accepts, refuses, outside the allowlist)", () => {
    const p = payload();
    const names = fnOf(p, "ai/note/validate").test.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["title refuses an invalid value", "priority accepts a valid value", "a field outside the allowlist is refused"]));
  });
});

describe("permission", () => {
  it("load answers someone else's record as not found, then checks the role conditions", () => {
    const p = payload();
    const pre = walk(fnOf(p, "ai/ticket/load").run).filter((x) => x.name === "mvp:precondition").map((x) => JSON.stringify(x.context));
    expect(pre.some((x) => x.includes("record.requester_id") && x.includes('"error_type":"notfound"'))).toBe(true);
    expect(pre.some((x) => x.includes("You can't use AI on tickets") && x.includes('"error_type":"accessdenied"'))).toBe(true);
    expect(pre.some((x) => x.includes("You can't change this ticket") && x.includes('"error_type":"accessdenied"'))).toBe(true);
    // note has no can.read
    const notePre = walk(fnOf(p, "ai/note/load").run).filter((x) => x.name === "mvp:precondition").map((x) => JSON.stringify(x.context));
    expect(notePre.some((x) => x.includes("You can't use AI on notes"))).toBe(false);
  });
  it("every endpoint needs sign-in, and request history is off", () => {
    const p = payload();
    const group = p.app.find((a: any) => a.name === "ai");
    expect(group.history).toMatchObject({ inherit: false, query_enabled: false });
    const qs = p.query.filter((q: any) => q.name.startsWith("ai/"));
    expect(qs).toHaveLength(6);
    for (const q of qs) expect(q.auth?.id ?? q.auth).toBeTruthy();
  });
});

describe("the rate limit", () => {
  it("ai/run refuses with 429 on ai/limit's answer before anything else", () => {
    // A 429 precondition doesn't raise inside a Xano workflow test, so this is the guard's only test.
    const p = payload();
    const run = fnOf(p, "ai/run").run;
    expect(run[0].context.function.id).toBe(guidOf(p, "function", "ai/limit"));
    expect(run[1].name).toBe("mvp:precondition");
    expect(run[1].context.error_type).toBe("toomanyrequests");
    expect(JSON.stringify(run[1].context.expr)).toContain('"limit.over"');
  });
});

describe("approvals", () => {
  it("a gated type asks approvals/request (by name) instead of applying; an ungated one applies", () => {
    const p = payload();
    const st = walk(fnOf(p, "ai/request_apply").run);
    const ids = st.filter((x) => x.name === "mvp:function").map((x) => x.context.function.id);
    expect(ids).toContain(md5("function:approvals/request"));
    expect(ids).toContain(guidOf(p, "function", "ai/apply"));
    expect(guidOf(p, "function", "approvals/request")).toBe(md5("function:approvals/request"));
  });
});

describe("the provider", () => {
  const person = table({ name: "pv_person", auth: true, useXdo: false, schema: { email: f.email() } });
  const doc = table({ name: "pv_doc", useXdo: false, schema: { title: f.text() } });
  const build = (extra: Partial<AiActionsOptions>) => {
    const xano = new Xano().registerWorkspace({ name: "pv", env: { OPENAI_KEY: "" } } as never).registerTables([person, doc]);
    defineAiActions({ user: person, records: { doc: { table: doc, context: ["title"], fields: { title: { type: "text" } }, extract: ["title"] } }, ...extra }).register(xano);
    return (xano.export() as any).payload;
  };
  it("a keyed provider says AI isn't connected when its key is empty", () => {
    const p = build({ llm: { type: "openai", apiKey: "{{ $env.OPENAI_KEY }}", model: "gpt-4o-mini" } });
    const run = JSON.stringify(fnOf(p, "ai/run").run);
    expect(run).toContain(JSON.stringify(NOT_CONNECTED).slice(1, -1).replace(/'/g, "'"));
    expect(run).toContain("OPENAI_KEY");
    expect(p.toolset[0].agent_settings.prompt).toBe("{{ $args.prompt }}");
  });
  it("stub with a keyless provider never ships an agent", () => {
    const p = build({ stub: true });
    expect(p.toolset ?? []).toHaveLength(0);
    expect(JSON.stringify(fnOf(p, "ai/run").run)).not.toContain("mvp:agent");
  });
  it("the keyless model maps the engine's 'not available' to AI isn't connected", () => {
    const run = JSON.stringify(fnOf(build({}), "ai/run").run);
    expect(run).toContain("not available in this process");
  });
});
