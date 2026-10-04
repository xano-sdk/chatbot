/**
 * The golden-bundle contract — this package's peer-drift tripwire.
 *
 * Registers everything on a fresh `Xano`, calls `export()`, and deep-equals the
 * result against the committed fixture with no normalizer. A `@xano/sdk` bump
 * that changes encoding fails HERE first, before it can reach a consumer.
 *
 * Regenerating the fixture is a deliberate, reviewed act — never a way to make
 * this test go green. A failure means the encoded bundle moved; find out *why*
 * first. See AGENTS.md.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  GOLDEN_FIXTURE_URL,
  buildGoldenBundle,
  serializeGoldenBundle,
} from "./golden.js";

const fixture = () => JSON.parse(readFileSync(GOLDEN_FIXTURE_URL, "utf8"));

describe("golden bundle", () => {
  it("matches the committed fixture byte for byte", () => {
    expect(buildGoldenBundle()).toEqual(fixture());
  });

  it("serializes to exactly the committed bytes", () => {
    // Deep-equality alone would let key ORDER drift, which changes the file every
    // regeneration and makes real diffs unreadable.
    expect(serializeGoldenBundle(buildGoldenBundle())).toBe(readFileSync(GOLDEN_FIXTURE_URL, "utf8"));
  });

  it("is deterministic across builds in one process", () => {
    expect(buildGoldenBundle()).toEqual(buildGoldenBundle());
  });
});

describe("what the fixture actually covers", () => {
  // A tripwire only guards what it encodes. These assertions keep the golden
  // config from quietly narrowing to the point where it stops catching things.
  const payload = () => fixture().payload;

  it("covers both endpoint families and the claim bridge", () => {
    expect(payload().query).toHaveLength(10);
  });

  it("covers the guest session-token column", () => {
    const conv = payload().dbo.find((t: any) => t.name === "conversation");
    expect(conv.schema.some((c: any) => c.name === "session_token")).toBe(true);
  });

  it("covers a pinned canonical", () => {
    expect(payload().app[0].canonical).toBe("chat");
  });

  it("covers a keyed provider, not just the keyless default", () => {
    expect(payload().toolset[0].agent_settings.type).toBe("openai");
  });

  it("pins the messages prompt type, the package's single most load-bearing byte", () => {
    expect(payload().toolset[0].agent_settings.prompt_type).toBe("messages");
  });
});
