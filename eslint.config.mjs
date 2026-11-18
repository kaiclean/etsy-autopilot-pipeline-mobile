import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const boundary = (files, groups) => ({
  files,
  rules: {
    "no-restricted-imports": ["error", { patterns: groups.map(([group, message]) => ({ group, message })) }],
  },
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/adapters/etsy/generated.ts",
  ]),
  // Layer boundaries from docs/DECISIONS.md: UI and routes depend on the domain layers, never the reverse.
  boundary(["src/adapters/**/*.{ts,tsx}"], [
    [["@/app/**", "@/components/**", "@/pipeline/**"], "Adapters must not depend on routes, UI or pipeline stages."],
  ]),
  boundary(["src/pipeline/**/*.{ts,tsx}", "src/db/**/*.{ts,tsx}"], [
    [["@/app/**", "@/components/**"], "Pipeline and db code must not depend on routes or UI."],
  ]),
  boundary(["src/lib/**/*.{ts,tsx}"], [
    [["@/app/**"], "Library code must not depend on routes."],
  ]),
  // Schema layering: core <- ops <- brain. The facade schema.ts re-exports all three.
  boundary(["src/db/schema-core.ts"], [
    [["./schema-ops", "./schema-brain", "./schema"], "schema-core is the base layer."],
  ]),
  boundary(["src/db/schema-ops.ts"], [
    [["./schema-brain", "./schema"], "schema-ops may only depend on schema-core."],
  ]),
]);

export default eslintConfig;
