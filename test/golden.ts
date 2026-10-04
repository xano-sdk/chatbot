/**
 * The single definition of how the golden bundle is built and serialized.
 *
 * `test/bundle.test.ts` (which asserts the fixture) and `scripts/regen-golden.ts`
 * (which writes it) both import from here, so the two can never drift. A fixture
 * regenerated a different way than it is asserted would silently weaken the
 * byte-exact contract this file exists to keep.
 *
 * The golden config turns **everything** on — both endpoint families, a pinned
 * canonical, a named provider — because the fixture is only a tripwire for what it
 * actually encodes. A default-options bundle would leave the guest family, the
 * claim bridge and the session-token plumbing uncovered.
 */
import { Xano, table, f } from "@xano/sdk";
import { registerChatbot } from "../src/index.js";

/** Fixed so the derived identities (and thus the bundle) are deterministic. */
export const GOLDEN_WORKSPACE_NAME = "xts-chatbot-golden";

export const GOLDEN_FIXTURE_URL = new URL("./fixtures/golden-bundle.json", import.meta.url);

/**
 * The auth table the golden bundle points at. Declared here rather than imported
 * from `helpers.ts` so the fixture cannot move when a test fixture is edited.
 */
const goldenAuthTable = table({
  name: "golden_user",
  auth: true,
  useXdo: false,
  schema: { email: f.email({ required: true, methods: ["trim", "lower"] }) },
});

/** A fresh, fully-registered export. `Xano.export()` is deterministic. */
export const buildGoldenBundle = () => {
  const xano = new Xano()
    .registerWorkspace({ name: GOLDEN_WORKSPACE_NAME })
    .registerTables([goldenAuthTable]);
  registerChatbot(xano, {
    authTable: goldenAuthTable,
    guest: true,
    canonical: "chat",
    llm: { type: "openai", model: "gpt-4o", systemPrompt: "You are a golden-fixture assistant." },
    historyLimit: 12,
    listLimit: 50,
    transcriptLimit: 100,
  });
  return xano.export();
};

/** 2-space JSON with a trailing newline — the committed fixture's on-disk form. */
export const serializeGoldenBundle = (bundle: unknown) => JSON.stringify(bundle, null, 2) + "\n";
