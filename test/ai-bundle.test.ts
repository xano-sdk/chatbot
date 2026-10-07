/**
 * The AI actions' golden bundle: the fixture (both record types, approvals, stub, rate limit, generated
 * tests) exported and deep-equalled against the committed file. Regenerate only as a reviewed act:
 * `npm run fixture:regen && git diff test/fixtures/golden-ai-bundle.json`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_GOLDEN_URL, buildAiGoldenBundle, serializeAiGolden } from "./ai-fixture.js";

const fixture = () => JSON.parse(readFileSync(AI_GOLDEN_URL, "utf8"));

describe("AI actions golden bundle", () => {
  it("matches the committed fixture byte for byte", () => {
    expect(serializeAiGolden(buildAiGoldenBundle())).toBe(readFileSync(AI_GOLDEN_URL, "utf8"));
  });
  it("covers what it should: both record types, approvals, the generated tests", () => {
    const p = fixture().payload;
    const fns = p.function.map((f: any) => f.name);
    expect(fns).toEqual(expect.arrayContaining(["ai/note/apply", "ai/ticket/apply", "ai/request_apply", "approvals/request", "ai/limit"]));
    expect(p.workflow_test.filter((t: any) => t.name.startsWith("ai: ")).length).toBeGreaterThanOrEqual(8);
    expect(p.query.filter((q: any) => q.name.startsWith("ai/"))).toHaveLength(6);
  });
});
