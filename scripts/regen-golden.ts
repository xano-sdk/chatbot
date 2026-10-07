/**
 * Regenerates the golden fixtures — `test/fixtures/golden-bundle.json` (the chatbot) and
 * `test/fixtures/golden-ai-bundle.json` (AI actions) — from the current defs and the installed
 * `@xano/sdk`.
 *
 * A deliberate, reviewed act — NOT a way to make a red bundle test go green. Run it only once you know
 * why the bundle moved, then review the diff line by line (guids, auth flags, stack order, output lists).
 *
 *   npm run fixture:regen && git diff test/fixtures/
 */
import { writeFileSync } from "node:fs";
import { GOLDEN_FIXTURE_URL, buildGoldenBundle, serializeGoldenBundle } from "../test/golden.js";
import { AI_GOLDEN_URL, buildAiGoldenBundle, serializeAiGolden } from "../test/ai-fixture.js";

writeFileSync(GOLDEN_FIXTURE_URL, serializeGoldenBundle(buildGoldenBundle()));
writeFileSync(AI_GOLDEN_URL, serializeAiGolden(buildAiGoldenBundle()));

console.log(`Wrote ${GOLDEN_FIXTURE_URL.pathname}`);
console.log(`Wrote ${AI_GOLDEN_URL.pathname}`);
console.log("Review the diff line by line before committing it.");
