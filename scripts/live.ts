// Deploy the AI-actions fixture (test/live/index.ts) to a local Xano engine and run the module's own Xano
// tests there: the validator's unit tests and the generated + fixture workflow tests. Runs from .live/, a
// throwaway project, so the CLI's engine pin and lock never touch this package's package.json.
// Exits non-zero when a test fails. Set XANOSDK_ENGINE_OVERRIDE=v0.1.20 if the engine download times out.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dir = resolve(root, ".live");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: "live-fixture", private: true, type: "module" }) + "\n");
const bin = resolve(root, "node_modules/.bin/xanosdk");
execFileSync(bin, ["export", resolve(root, "test/live/index.ts"), "--out", resolve(dir, "bundle.json"), "--no-lock", "--strict"], { cwd: dir, stdio: "inherit" });
// A failing suite exits 5 with the report still on stdout, so read it either way.
let out: string;
try {
  out = execFileSync(bin, ["deploy", resolve(dir, "bundle.json"), "--test", "--yes", "--json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = String((e as { stdout?: string }).stdout ?? "");
  if (!out.includes("testRun")) throw e;
}
const run = JSON.parse(out.slice(out.indexOf("{"))).testRun;
for (const t of run.tests) console.log(`${t.status === "pass" ? "✓" : "✗"} ${t.qualified}${t.message ? `: ${t.message}` : ""}`);
console.log(`${run.passed} passed, ${run.failed} failed`);
if (run.failed || run.total === 0) process.exit(1);
