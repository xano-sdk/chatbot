/**
 * The tarball contract: what `files` actually publishes, and whether the docs
 * inside it can be read once installed.
 *
 * A relative link in `llms.txt` or `README.md` is only meaningful to a consumer
 * if its target ships too — `node_modules/@xano-sdk/chatbot/` is the whole world for
 * an agent reading these files. `AGENTS.md` was linked from `llms.txt` for a
 * release without being in `files`, which is exactly the drift this pins.
 *
 * The file list comes from `npm pack --dry-run --json` rather than from the
 * `files` array, so negations (`!dist/**\/*.map`), `.npmignore`, and npm's
 * always-included set are resolved by npm itself instead of re-implemented here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repoRoot = new URL("../", import.meta.url);

/** Everything `npm publish` would upload, as tarball-relative paths. */
const packedFiles = (): string[] => {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: fileURLToPath(repoRoot),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  // npm can precede the JSON with notices even on stdout; take the array only.
  const json = stdout.slice(stdout.indexOf("["));
  return (JSON.parse(json)[0].files as { path: string }[]).map((f) => f.path);
};

/** `[text](target)` — markdown links, which `llms.txt` uses as well. */
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

const relativeLinksIn = (file: string): string[] =>
  [...readFileSync(new URL(file, repoRoot), "utf8").matchAll(LINK)]
    .flatMap((m) => {
      const target = m[1] ?? "";
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return [];
      const [path] = target.split("#");
      return path ? [path] : [];
    });

describe("published docs", () => {
  it("publishes exactly the intended non-dist files", () => {
    // `dist/` is deliberately not pinned by name here: the suite runs without a
    // build (`npm test` is typecheck + vitest), so what tsup emitted last is not
    // a contract this test can hold. The map exclusion below is, since a stray
    // `.map` is drift in `files`, not in the build.
    const shipped = packedFiles();
    expect(shipped.filter((f) => !f.startsWith("dist/")).sort()).toEqual([
      "AGENTS.md",
      "LICENSE",
      "README.md",
      "llms.txt",
      "package.json",
    ]);
    expect(shipped.filter((f) => f.endsWith(".map"))).toEqual([]);
  }, 60_000);

  it("resolves every relative link in a shipped doc inside the tarball", () => {
    const shipped = packedFiles();
    const docs = shipped.filter((f) => /\.(md|txt)$/.test(f));
    expect(docs.length).toBeGreaterThan(0);

    const dead = docs.flatMap((doc) =>
      relativeLinksIn(doc)
        .map((target) => ({
          doc,
          target,
          // Links are relative to the doc; all shipped docs sit at the root.
          resolved: new URL(target, new URL(doc, "file:///")).pathname.slice(1),
        }))
        .filter(({ resolved }) => !shipped.includes(resolved))
        .map(({ doc, target }) => `${doc} → ${target}`),
    );

    expect(dead).toEqual([]);
  }, 60_000);
});
