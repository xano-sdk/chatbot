import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "test/fixtures/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "no-undef": "off",
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
    },
  },
  {
    // Tests introspect the opaque exported bundle and loosely-typed statement
    // contexts, where `any` is the pragmatic choice. Source stays `any`-free.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // `_`-prefixed names are deliberately unused: the type-level assertions in
      // types.test.ts ARE their type parameter, which no runtime code can consume.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
    },
  },
];
