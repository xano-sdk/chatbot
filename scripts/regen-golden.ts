/**
 * Regenerates `test/fixtures/golden-bundle.json` from the current defs and the
 * currently installed `@xano/sdk`.
 *
 * This is a deliberate, reviewed act — NOT a way to make a red `bundle.test.ts`
 * go green. That test is the peer-drift tripwire; a failure means the encoded
 * bundle moved, and the only correct response is to find out *why* first. Run
 * this only once you have read the core diff and concluded the change is
 * legitimate, then review the fixture diff line by line (watch guids, auth
 * flags, stack order, output lists) before committing it.
 *
 *   npm run fixture:regen && git diff test/fixtures/golden-bundle.json
 *
 * How the bundle is built and serialized lives in `test/golden.ts`, shared with
 * `test/bundle.test.ts`, so the written fixture and the asserted one cannot
 * drift apart.
 */
import { writeFileSync } from "node:fs";
import {
  GOLDEN_FIXTURE_URL,
  buildGoldenBundle,
  serializeGoldenBundle,
} from "../test/golden.js";

writeFileSync(GOLDEN_FIXTURE_URL, serializeGoldenBundle(buildGoldenBundle()));

console.log(`Wrote ${GOLDEN_FIXTURE_URL.pathname}`);
console.log("Review the diff line by line before committing it.");
