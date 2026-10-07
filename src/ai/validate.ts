/**
 * Server-side validation of proposed values against a record type's field rules — the one gate between
 * what a model (or a client) proposes and what can be written.
 *
 * Built per record type at build time: each allowlisted field gets its own unrolled checks, so the
 * allowlist is the STRUCTURE of the function (a key that isn't a field has no statement that could copy
 * it into the output). Anything else is reported in `dropped`, in plain words, never silently kept.
 */
import { and, c, defineFunction, expect, expr, fl, inp, input, obj, or, ref, resp, s, withFilters, type Statement, type Value } from "@xano/sdk";
import type { ResolvedRecordType, ResolvedAiOptions } from "./options.js";
import type { AiDropped } from "./types.js";

type Field = ResolvedRecordType["fields"][string];

/** Plain-language reasons, shared by the server and the tests that pin them. */
export const REASONS = {
  notAllowed: "AI can't change this field.",
  text: "Must be text.",
  required: "Can't be empty.",
  int: "Must be a whole number.",
  decimal: "Must be a number.",
  bool: "Must be yes or no.",
  date: "Must be a date like 2026-10-31.",
  realDate: "Isn't a real date.",
  tooLong: (n: number) => `Must be ${n} characters or fewer.`,
  tooShort: (n: number) => `Must be at least ${n} characters.`,
  atLeast: (n: number) => `Must be at least ${n}.`,
  atMost: (n: number) => `Must be at most ${n}.`,
  oneOf: (values: readonly string[]) => `Must be one of: ${values.join(", ")}.`,
};

const T = c.bool(true);
const is = (v: Value, filter: ReturnType<typeof fl.is_text | typeof fl.is_int | typeof fl.is_decimal | typeof fl.is_bool>) => expr(withFilters(v, filter), "=", T);

/** The checks for one field. Reads `vals`, appends to `out`, `fields` and `dropped`. */
function fieldChecks(name: string, f: Field): Statement[] {
  const v = ref(`v_${name}`), kind = ref(`k_${name}`), txt = ref(`t_${name}`);
  const drop = (reason: string) => s.group([
    s.update_var("dropped", withFilters(ref("dropped"), fl.array_push(obj({ field: c.text(name), value: ref(`shown_${name}`), reason: c.text(reason) })))),
    s.update_var("problems", withFilters(ref("problems"), fl.set(c.text(name), c.text(reason)))),
  ]);
  const accept = (value: Value) => [
    s.update_var("out", withFilters(ref("out"), fl.set(c.text(name), value))),
    s.update_var("fields", withFilters(ref("fields"), fl.array_push(c.text(name)))),
  ];
  const kindIs = (...k: string[]) => (k.length === 1 ? expr(kind, "=", c.text(k[0]!)) : or(...k.map((x) => expr(kind, "=", c.text(x)))));
  const len = withFilters(txt, fl.strlen());

  let checks: Statement[];
  switch (f.type) {
    case "text": {
      const elif = [
        ...(f.max !== undefined ? [{ when: expr(len, ">", c.int(f.max)), then: [drop(REASONS.tooLong(f.max))] }] : []),
        ...(f.min !== undefined ? [{ when: expr(len, "<", c.int(f.min)), then: [drop(REASONS.tooShort(f.min))] }] : []),
      ];
      checks = [s.conditional({ when: and(expr(kind, "!=", c.text("text")), expr(kind, "!=", c.text("num"))), then: [drop(REASONS.text)], elif, else: accept(txt) })];
      break;
    }
    case "enum": {
      const lower = withFilters(txt, fl.lower());
      checks = [s.conditional({
        when: and(expr(kind, "!=", c.text("text")), expr(kind, "!=", c.text("num"))),
        then: [drop(REASONS.oneOf(f.values!))],
        elif: f.values!.map((val) => ({ when: expr(lower, "=", c.text(val.toLowerCase())), then: accept(c.text(val)) })),
        else: [drop(REASONS.oneOf(f.values!))],
      })];
      break;
    }
    case "int":
    case "decimal": {
      const pattern = f.type === "int" ? /^-?[0-9]+$/ : /^-?[0-9]+(\.[0-9]+)?$/;
      const reason = f.type === "int" ? REASONS.int : REASONS.decimal;
      const num = ref(`n_${name}`);
      const range = [
        ...(f.min !== undefined ? [{ when: expr(num, "<", f.type === "int" ? c.int(f.min) : c.decimal(f.min)), then: [drop(REASONS.atLeast(f.min))] }] : []),
        ...(f.max !== undefined ? [{ when: expr(num, ">", f.type === "int" ? c.int(f.max) : c.decimal(f.max)), then: [drop(REASONS.atMost(f.max))] }] : []),
      ];
      checks = [s.conditional({
        when: or(kindIs("bool", "other"), expr(withFilters(c.regex(pattern), fl.regex_test(txt)), "!=", T)),
        then: [drop(reason)],
        else: [
          s.set_var(`n_${name}`, withFilters(txt, f.type === "int" ? fl.to_int() : fl.to_decimal())),
          ...(range.length ? [s.conditional({ when: range[0]!.when, then: range[0]!.then, elif: range.slice(1), else: accept(num) })] : accept(num)),
        ],
      })];
      break;
    }
    case "bool": {
      const lower = withFilters(txt, fl.lower());
      checks = [s.conditional({
        when: kindIs("bool"),
        then: accept(withFilters(v, fl.to_bool())),
        elif: [
          { when: or(...["true", "yes", "1"].map((x) => expr(lower, "=", c.text(x)))), then: accept(T) },
          { when: or(...["false", "no", "0"].map((x) => expr(lower, "=", c.text(x)))), then: accept(c.bool(false)) },
        ],
        else: [drop(REASONS.bool)],
      })];
      break;
    }
    case "date": {
      const day = ref(`d_${name}`), back = ref(`rt_${name}`);
      checks = [s.conditional({
        when: or(expr(kind, "!=", c.text("text")), expr(withFilters(c.regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}/), fl.regex_test(txt)), "!=", T)),
        then: [drop(REASONS.date)],
        else: [
          s.set_var(`d_${name}`, withFilters(txt, fl.substr(c.int(0), c.int(10)))),
          s.set_var(`rt_${name}`, c.text("")),
          // A date that doesn't exist (2026-02-30) parses by rolling over (to 2026-03-02); a round trip
          // catches it. Text that doesn't parse at all throws, which is the same answer.
          s.try_catch({ try: [s.update_var(`rt_${name}`, withFilters(day, fl.to_epochms(), fl.epochms_date(c.text("Y-m-d"))))], catch: [] }),
          s.conditional({ when: expr(back, "!=", day), then: [drop(REASONS.realDate)], else: accept(day) }),
        ],
      })];
      break;
    }
  }

  return [
    s.set_var(`v_${name}`, withFilters(ref("vals"), fl.get(c.text(name), c.null()))),
    // What kind of JSON value arrived: null, text, num, bool, or other (a list or an object).
    s.set_var(`k_${name}`, c.text("other")),
    s.conditional({
      when: expr(v, "=", c.null()),
      then: [s.update_var(`k_${name}`, c.text("null"))],
      elif: [
        { when: is(v, fl.is_text()), then: [s.update_var(`k_${name}`, c.text("text"))] },
        { when: or(is(v, fl.is_int()), is(v, fl.is_decimal())), then: [s.update_var(`k_${name}`, c.text("num"))] },
        { when: is(v, fl.is_bool()), then: [s.update_var(`k_${name}`, c.text("bool"))] },
      ],
    }),
    s.set_var(`t_${name}`, c.text("")),
    s.set_var(`shown_${name}`, withFilters(v, fl.json_encode(), fl.substr(c.int(0), c.int(80)))),
    s.conditional({
      when: kindIs("text", "num", "bool"),
      then: [
        s.update_var(`t_${name}`, withFilters(v, fl.to_text(), fl.trim())),
        s.update_var(`shown_${name}`, withFilters(v, fl.to_text(), fl.substr(c.int(0), c.int(80)))),
      ],
    }),
    // Blank text is "not proposed", exactly like a missing key.
    s.conditional({ when: and(kindIs("text"), expr(txt, "=", c.text(""))), then: [s.update_var(`k_${name}`, c.text("null"))] }),
    s.conditional({
      when: kindIs("null"),
      // Clearing is only for an apply (an undo restoring an empty field), never for a model's answer, and
      // only when the key was really sent.
      then: [s.conditional({
        when: and(expr(inp("allow_clear"), "=", T), expr(withFilters(ref("vals"), fl.has(c.text(name))), "=", T)),
        then: f.required ? [drop(REASONS.required)] : accept(f.type === "text" ? c.text("") : c.null()),
      })],
      else: checks,
    }),
  ];
}

export function validateFn(o: ResolvedAiOptions, rt: ResolvedRecordType) {
  const names = Object.keys(rt.fields);
  const tests = validateTests(rt);
  return defineFunction({
    name: `ai/${rt.key}/validate`,
    description: `Checks values proposed for a ${rt.label} against its field rules. Keeps only allowed, valid values; reports the rest.`,
    tags: o.tags,
    input: {
      values: input.json({ description: "Field → proposed value." }),
      allow_clear: input.bool({ description: "Let an empty value clear a field (an apply), rather than mean 'nothing proposed'." }),
    },
    stack: [
      s.set_var("vals", inp("values")),
      s.conditional({ when: expr(withFilters(inp("values"), fl.is_object()), "!=", T), then: [s.update_var("vals", c.obj({}))] }),
      s.set_var("out", c.obj({})),
      s.set_var("fields", c.array([])),
      s.set_var("dropped", c.array([])),
      s.set_var("problems", c.obj({})),
      ...names.flatMap((n) => fieldChecks(n, rt.fields[n]!)),
      // Every key that isn't an allowlisted field is reported, never copied.
      s.set_var("unknown", withFilters(ref("vals"), ...names.map((n) => fl.unpick(c.text(n))), fl.array_keys())),
      s.foreach({
        list: ref("unknown"),
        as: "key",
        body: [
          s.set_var("raw", withFilters(ref("vals"), fl.get(ref("key")))),
          s.set_var("shown", withFilters(ref("raw"), fl.json_encode())),
          s.conditional({ when: is(ref("raw"), fl.is_text()), then: [s.update_var("shown", ref("raw"))] }),
          s.update_var("dropped", withFilters(ref("dropped"), fl.array_push(obj({
            field: ref("key"),
            value: withFilters(ref("shown"), fl.substr(c.int(0), c.int(80))),
            reason: c.text(REASONS.notAllowed),
          })))),
          s.update_var("problems", withFilters(ref("problems"), fl.set(ref("key"), c.text(REASONS.notAllowed)))),
        ],
      }),
    ],
    response: { values: ref("out"), fields: ref("fields"), dropped: ref("dropped"), problems: ref("problems") },
    responseShape: {} as { values: Record<string, unknown>; fields: string[]; dropped: AiDropped[]; problems: Record<string, string> },
    tests,
  });
}

/** A value each field type accepts, and what it should come back as. */
export function sampleFor(f: Field): { input: unknown; expected: unknown } {
  switch (f.type) {
    case "text": {
      const n = Math.max(f.min ?? 0, 6);
      const text = "Sample text that is long enough".slice(0, Math.min(n + 6, f.max ?? 40)).trim().padEnd(f.min ?? 0, "x");
      return { input: `  ${text}  `, expected: text };
    }
    case "enum": return { input: f.values![0]!.toUpperCase(), expected: f.values![0] };
    case "int": {
      const n = Math.max(f.min ?? 1, Math.min(f.max ?? 3, 3));
      return { input: String(n), expected: n };
    }
    case "decimal": {
      const n = Math.max(f.min ?? 1.5, Math.min(f.max ?? 2.5, 2.5));
      return { input: String(n), expected: n };
    }
    case "bool": return { input: "yes", expected: true };
    case "date": return { input: "2026-10-31", expected: "2026-10-31" };
  }
}

/** A value each field type refuses, and the reason it's given. */
export function invalidFor(f: Field): { input: unknown; reason: string } {
  switch (f.type) {
    case "text": return f.max !== undefined ? { input: "x".repeat(f.max + 1), reason: REASONS.tooLong(f.max) } : { input: [1, 2], reason: REASONS.text };
    case "enum": return { input: "not-a-choice", reason: REASONS.oneOf(f.values!) };
    case "int": return f.max !== undefined ? { input: f.max + 1, reason: REASONS.atMost(f.max) } : { input: "soon", reason: REASONS.int };
    case "decimal": return { input: "about ten", reason: REASONS.decimal };
    case "bool": return { input: "maybe", reason: REASONS.bool };
    case "date": return { input: "2026-02-30", reason: REASONS.realDate };
  }
}

/** Unit tests on the validator, generated from the field rules: they ship with every install. */
function validateTests(rt: ResolvedRecordType) {
  const tests: Parameters<typeof defineFunction>[0]["tests"] & object = [];
  for (const [name, f] of Object.entries(rt.fields)) {
    const ok = sampleFor(f);
    const bad = invalidFor(f);
    tests.push({
      name: `${name} accepts a valid value`,
      input: { values: c.obj({ [name]: ok.input } as never), allow_clear: c.bool(false) },
      expect: [expect.to_equal(resp(`values.${name}`), toConst(ok.expected)), expect.to_be_empty(resp("dropped"))],
    });
    tests.push({
      name: `${name} refuses an invalid value`,
      input: { values: c.obj({ [name]: bad.input } as never), allow_clear: c.bool(false) },
      expect: [
        expect.to_not_be_defined(resp(`values.${name}`)),
        expect.to_equal(resp(`problems.${name}`), c.text(bad.reason)),
      ],
    });
  }
  const first = Object.keys(rt.fields)[0]!;
  const outsider = rt.owner ?? "id";
  tests.push({
    name: "a field outside the allowlist is refused",
    input: { values: c.obj({ [outsider]: 999, zz_not_a_field: "x" }), allow_clear: c.bool(true) },
    expect: [
      expect.to_be_empty(resp("fields")),
      expect.to_equal(resp(`problems.${outsider}`), c.text(REASONS.notAllowed)),
      expect.to_equal(resp("problems.zz_not_a_field"), c.text(REASONS.notAllowed)),
    ],
  });
  tests.push({
    name: "a blank value is not a proposal",
    input: { values: c.obj({ [first]: "   " }), allow_clear: c.bool(false) },
    expect: [expect.to_be_empty(resp("fields")), expect.to_be_empty(resp("dropped"))],
  });
  const required = Object.keys(rt.fields).find((n) => rt.fields[n]!.required);
  if (required) {
    tests.push({
      name: `${required} can't be cleared`,
      input: { values: c.obj({ [required]: "" }), allow_clear: c.bool(true) },
      expect: [expect.to_be_empty(resp("fields")), expect.to_equal(resp(`problems.${required}`), c.text(REASONS.required))],
    });
  }
  tests.push({
    name: "a list instead of an object proposes nothing",
    input: { values: c.array(["x"]), allow_clear: c.bool(false) },
    expect: [expect.to_be_empty(resp("fields")), expect.to_be_empty(resp("dropped"))],
  });
  return tests;
}

/** A plain JS value as the matching constant. */
export const toConst = (v: unknown): Value =>
  typeof v === "number" ? (Number.isInteger(v) ? c.int(v) : c.decimal(v)) : typeof v === "boolean" ? c.bool(v) : v === null ? c.null() : c.text(String(v));
