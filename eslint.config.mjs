import convexPlugin from "@convex-dev/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".output/**",
      ".wxt/**",
      "convex/_generated/**",
      "node_modules/**",
      "store/pulse.json",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  ...convexPlugin.configs.recommended,
  {
    files: ["convex/**/*.ts"],
    rules: {
      "@convex-dev/no-collect-in-query": "warn",
    },
  },
);
