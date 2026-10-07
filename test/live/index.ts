// The AI-actions fixture, deployable: `npm run test:live` deploys it to a local Xano engine (stub provider,
// no model needed) and runs the module's generated tests and the fixture's own.
import { buildAiFixture } from "../ai-fixture.js";

export default buildAiFixture().xano;
