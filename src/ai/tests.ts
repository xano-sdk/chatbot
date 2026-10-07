/**
 * Xano workflow tests generated from the app's own config, registered with the module (like
 * `@xano-sdk/rbac`'s): `deploy --test` runs them. Each pins one rule and fails when the rule is removed.
 *
 * Generated per record type that sets `test: { row, role? }`. The ones that run an action need a model,
 * so they're generated only with `stub: true` (the local engine has no model).
 *
 * They run in an EMPTY database, so each makes its own people and records. A `to_throw` body can't see
 * variables bound outside it, so it re-reads the person by email (or name) and the record as the newest row.
 */
import { c, expr, col, fl, ref, s, withFilters, workflowTest, type AnyTableDef, type ObjectRef, type Statement, type Value } from "@xano/sdk";
import type { ResolvedAiOptions, ResolvedRecordType } from "./options.js";
import { invalidFor, sampleFor, toConst, REASONS } from "./validate.js";

type PerType = { rt: ResolvedRecordType; load: ObjectRef; validate: ObjectRef; apply: ObjectRef };
type Column = { type?: string };

export function aiWorkflowTests(
  o: ResolvedAiOptions,
  d: { usage: AnyTableDef; runFn: ObjectRef; limitFn: ObjectRef; applyFn: ObjectRef; requestApplyFn: ObjectRef; perType: PerType[]; userCols: Record<string, Column> },
) {
  const cols = d.userCols;
  const idCol = "email" in cols ? "email" : "name" in cols ? "name" : undefined;
  if (!idCol) return [];
  const tag = (key: string) => (idCol === "email" ? c.text(`${key}@ai-test.example`) : c.text(`AI test ${key}`));
  const person$ = (key: string, role?: string) => s.db.add({ table: o.user, as: key, row: {
    ...("name" in cols ? { name: c.text(`AI test ${key}`) } : {}),
    ...("email" in cols ? { email: c.text(`${key}@ai-test.example`) } : {}),
    ...("password" in cols ? { password: c.text("Ai-test-1234") } : {}),
    ...(role ? { role: c.text(role) } : {}),
  } as never });
  const find$ = (key: string) => s.db.get({ table: o.user, fieldName: idCol as never, fieldValue: tag(key), as: key });
  const latest$ = (rt: ResolvedRecordType, as = "rows") =>
    s.db.query({ table: rt.table, sort: [{ sortBy: "id", dir: "desc" }], paging: { per_page: 1, metadata: false }, as });
  const row$ = (rt: ResolvedRecordType, owner: string, as = "rec") =>
    s.db.add({ table: rt.table, as, row: { ...rt.test!.row, ...(rt.owner ? { [rt.owner]: ref(`${owner}.id`) } : {}) } as never });
  const run$ = (as: string, actor: Value, rt: ResolvedRecordType, recordId: Value, action: string, extra: { field?: string; instruction?: string; text?: string } = {}) =>
    s.function.call({ fn: d.runFn, as, input: {
      actor_id: actor, record_type: c.text(rt.key), record_id: recordId, action: c.text(action),
      field: c.text(extra.field ?? ""), instruction: c.text(extra.instruction ?? ""), text: c.text(extra.text ?? ""),
    } });
  const apply$ = (as: string, actor: Value, rt: ResolvedRecordType, recordId: Value, values: Value) =>
    s.function.call({ fn: d.applyFn, as, input: { actor_id: actor, record_type: c.text(rt.key), record_id: recordId, values } });
  const same = (a: Value, b: Value) => s.expect.to_equal({ expr: a, value: b });

  const tests: ReturnType<typeof workflowTest>[] = [];
  for (const p of d.perType) {
    const rt = p.rt;
    if (!rt.test) continue;
    const role = rt.test.role;
    const names = Object.keys(rt.fields);
    const first = names[0]!;
    const sample = sampleFor(rt.fields[first]!);
    const outsider = rt.owner ?? "created_at";
    const unchanged = (as: string) => names.map((n) => same(ref(`${as}.${n}`), ref(`rec.${n}`)));

    tests.push(workflowTest({
      name: `ai: ${rt.key} — apply writes only the allowlisted fields`,
      description: "A value for a field outside the allowlist refuses the whole write; allowlisted values are written as the person.",
      stack: [
        person$("owner", role),
        row$(rt, "owner"),
        s.expect.to_throw({ exception: c.text(REASONS.notAllowed), body: [
          find$("owner"), latest$(rt),
          apply$("x", ref("owner.id"), rt, ref("rows.0.id"), withFilters(c.obj({ [first]: sample.input } as never), fl.set(c.text(outsider), c.int(999999)))),
        ] }),
        s.db.get({ table: rt.table, fieldValue: ref("rec.id"), as: "after" }),
        ...unchanged("after"),
        ...(rt.owner ? [same(ref(`after.${rt.owner}`), ref("owner.id"))] : []),
        apply$("applied", ref("owner.id"), rt, ref("rec.id"), c.obj({ [first]: sample.input } as never)),
        same(ref("applied.status"), c.text("applied")),
        s.db.get({ table: rt.table, fieldValue: ref("rec.id"), as: "written" }),
        same(ref(`written.${first}`), toConst(sample.expected)),
        s.db.query({ table: d.usage, where: [expr(col("user_id"), "=", ref("owner.id")), expr(col("action"), "=", c.text("apply"))], returnType: "count", as: "applies" }),
        same(ref("applies"), c.int(1)),
      ],
    }));

    const badField = names.find((n) => !Array.isArray(invalidFor(rt.fields[n]!).input)) ?? first;
    const bad = invalidFor(rt.fields[badField]!);
    tests.push(workflowTest({
      name: `ai: ${rt.key} — apply refuses an invalid value and writes nothing`,
      description: `"${badField}" gets a value its rules refuse; the record stays as it was.`,
      stack: [
        person$("owner", role),
        row$(rt, "owner"),
        s.expect.to_throw({ exception: c.text(bad.reason), body: [
          find$("owner"), latest$(rt),
          apply$("x", ref("owner.id"), rt, ref("rows.0.id"), c.obj({ [badField]: bad.input } as never)),
        ] }),
        s.db.get({ table: rt.table, fieldValue: ref("rec.id"), as: "after" }),
        ...unchanged("after"),
      ],
    }));

    if (rt.owner) {
      const strangerRuns: Statement[] = o.stub && rt.summarise
        ? [s.expect.to_throw({ exception: c.text("isn't available"), body: [find$("stranger"), latest$(rt), run$("x", ref("stranger.id"), rt, ref("rows.0.id"), "summarise")] })]
        : [];
      tests.push(workflowTest({
        name: `ai: ${rt.key} — someone else's ${rt.label} isn't available`,
        description: "A person who doesn't own the record can't load, run AI on, or apply to it; it answers as if missing.",
        stack: [
          person$("owner", role),
          person$("stranger", role),
          row$(rt, "owner"),
          s.expect.to_throw({ exception: c.text("isn't available"), body: [
            find$("stranger"), latest$(rt),
            s.function.call({ fn: p.load, as: "x", input: { actor_id: ref("stranger.id"), record_id: ref("rows.0.id"), write: c.bool(false) } }),
          ] }),
          s.expect.to_throw({ exception: c.text("isn't available"), body: [
            find$("stranger"), latest$(rt),
            apply$("x", ref("stranger.id"), rt, ref("rows.0.id"), c.obj({ [first]: sample.input } as never)),
          ] }),
          ...strangerRuns,
          s.db.get({ table: rt.table, fieldValue: ref("rec.id"), as: "after" }),
          ...unchanged("after"),
        ],
      }));
    }

    if (!o.stub) continue;
    const extractLines = rt.extract.map((n) => `${n}: ${String(sampleFor(rt.fields[n]!).input).trim()}`);
    tests.push(workflowTest({
      name: `ai: ${rt.key} — actions answer and never write`,
      description: "summarise, draft and extract return suggestions; the record is unchanged after all three.",
      stack: [
        person$("owner", role),
        row$(rt, "owner"),
        ...(rt.summarise ? [
          run$("summary", ref("owner.id"), rt, ref("rec.id"), "summarise"),
          s.expect.to_start_with({ expr: ref("summary.text"), value: c.text("Test mode: ") }),
          same(ref("summary.provider"), c.text("stub")),
        ] : []),
        ...(rt.draft.length ? [
          run$("drafted", ref("owner.id"), rt, ref("rec.id"), "draft", { field: rt.draft[0]!, instruction: "Make it friendlier" }),
          s.expect.to_contain({ expr: ref("drafted.text"), value: c.text("Make it friendlier") }),
        ] : []),
        ...(rt.extract.length ? [
          run$("found", ref("owner.id"), rt, ref("rec.id"), "extract", { text: extractLines.join("\n") }),
          ...rt.extract.map((n) => same(ref(`found.values.${n}`), toConst(sampleFor(rt.fields[n]!).expected))),
        ] : []),
        s.db.get({ table: rt.table, fieldValue: ref("rec.id"), as: "after" }),
        ...unchanged("after"),
      ],
    }));

    if (rt.extract.length) {
      const scalarBad = rt.extract.find((n) => !Array.isArray(invalidFor(rt.fields[n]!).input));
      const good = rt.extract.find((n) => n !== scalarBad) ?? rt.extract[0]!;
      const lines = [
        `${good}: ${String(sampleFor(rt.fields[good]!).input).trim()}`,
        ...(scalarBad && scalarBad !== good ? [`${scalarBad}: ${String(invalidFor(rt.fields[scalarBad]!).input)}`] : []),
        `${outsider}: 7`,
        "Thanks, talk soon",
      ];
      const droppedCount = scalarBad && scalarBad !== good ? 2 : 1;
      tests.push(workflowTest({
        name: `ai: ${rt.key} — extract keeps valid values and reports the rest`,
        description: "The model's proposals are checked on the server: an invalid value and a field outside the allowlist are dropped, with reasons.",
        stack: [
          person$("owner", role),
          row$(rt, "owner"),
          run$("found", ref("owner.id"), rt, ref("rec.id"), "extract", { text: lines.join("\n") }),
          same(ref(`found.values.${good}`), toConst(sampleFor(rt.fields[good]!).expected)),
          same(withFilters(ref("found.dropped"), fl.count()), c.int(droppedCount)),
          ...(droppedCount === 2 ? [s.expect.to_not_be_defined({ expr: ref(`found.values.${scalarBad}`) })] : []),
          same(ref(`found.dropped.${droppedCount - 1}.field`), c.text(outsider)),
          same(ref(`found.dropped.${droppedCount - 1}.reason`), c.text(REASONS.notAllowed)),
        ],
      }));
    }
  }

  const firstTested = d.perType.find((p) => p.rt.test && (p.rt.summarise || p.rt.draft.length || p.rt.extract.length));
  if (o.stub && firstTested) {
    const rt = firstTested.rt;
    const role = rt.test!.role;
    const action = rt.summarise ? "summarise" : rt.draft.length ? "draft" : "extract";
    const extra = action === "draft" ? { field: rt.draft[0]!, instruction: "Shorter" } : action === "extract" ? { text: "nothing to see" } : {};
    tests.push(workflowTest({
      name: "ai: every run is logged for the person",
      description: "A run adds one usage row: who, which action, on what, and that it went fine.",
      stack: [
        person$("owner", role),
        row$(rt, "owner"),
        run$("r", ref("owner.id"), rt, ref("rec.id"), action, extra),
        s.db.query({ table: d.usage, where: [expr(col("user_id"), "=", ref("owner.id")), expr(col("action"), "=", c.text(action))], paging: { per_page: 5, metadata: false }, as: "logged" }),
        same(withFilters(ref("logged"), fl.count()), c.int(1)),
        same(ref("logged.0.status"), c.text("ok")),
        same(ref("logged.0.record_id"), ref("rec.id")),
        same(ref("logged.0.provider"), c.text("stub")),
      ],
    }));
    if (o.rateLimit) {
      const { max } = o.rateLimit;
      tests.push(workflowTest({
        name: "ai: each person has their own rate limit",
        description: `After ${max} runs in the window a person is refused; someone else still can run.`,
        stack: [
          person$("busy", role),
          person$("other", role),
          row$(rt, "busy", "rec"),
          row$(rt, "other", "rec2"),
          s.for({ as: "i", count: c.int(max), body: [
            s.db.add({ table: d.usage, row: { created_at: c.now(), user_id: ref("busy.id"), action: c.text(action), record_type: c.text(rt.key), record_id: ref("rec.id"), status: c.text("ok") } as never }),
          ] }),
          s.db.query({ table: d.usage, where: expr(col("user_id"), "=", ref("busy.id")), returnType: "count", as: "logged" }),
          same(ref("logged"), c.int(max)),
          // ⚠ A 429 precondition does not raise inside a workflow test (verified on the local engine: it is
          // swallowed and the stack carries on; over HTTP it is a real 429). So the decision is checked here,
          // and test/encode.test.ts pins that ai/run refuses on it.
          s.function.call({ fn: d.limitFn, as: "busy_limit", input: { actor_id: ref("busy.id") } }),
          same(ref("busy_limit.over"), c.bool(true)),
          s.function.call({ fn: d.limitFn, as: "other_limit", input: { actor_id: ref("other.id") } }),
          same(ref("other_limit.over"), c.bool(false)),
          same(ref("other_limit.used"), c.int(0)),
          run$("ok", ref("other.id"), rt, ref("rec2.id"), action, extra),
          same(ref("ok.provider"), c.text("stub")),
        ],
      }));
    }
  }
  return tests;
}
