/** The optional frontend's packaging rules: the ./react export, an optional React peer, no SDK at runtime. */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const dir = new URL("../src/react/", import.meta.url);

describe("@xano-sdk/chatbot/react", () => {
  it("is exported as ./react, with React an optional peer", () => {
    expect(pkg.exports["./react"]).toEqual({ types: "./dist/react.d.ts", import: "./dist/react.js" });
    expect(pkg.peerDependencies.react).toBeTruthy();
    expect(pkg.peerDependenciesMeta.react.optional).toBe(true);
  });
  it("imports only React and types: no SDK runtime, no backend defs, no other packages", () => {
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
        const [, isType, from] = m;
        if (isType) continue;
        expect(from!.startsWith("./") || from === "react" || from === "react-dom", `${f} imports ${from}`).toBe(true);
      }
    }
  });
  it("never renders a string as HTML", () => {
    for (const f of readdirSync(dir)) expect(readFileSync(new URL(f, dir), "utf8"), f).not.toContain("dangerouslySetInnerHTML");
  });
});
