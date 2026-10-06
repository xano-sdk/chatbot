import { defineConfig } from "tsup";

export default defineConfig({
  // `index`: the Xano defs (Node, at build time). `react`: the optional frontend (browser), which imports
  // no SDK runtime, only types, so a frontend bundle never carries the backend.
  entry: { index: "src/index.ts", react: "src/react/index.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  // The peer is resolved from the consumer's install — never bundled. A bundled
  // copy would fork the statement/kind registries the consumer's export() uses.
  // React is the consumer's too: a bundled copy would break hooks.
  external: [/^@xano\/sdk(\/|$)/, /^react(\/|$)/, /^react-dom(\/|$)/],
});
