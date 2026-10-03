import convexPlugin from "@convex-dev/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
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
  {
    // React runs only in the extension; convex-test fixtures also use `use*` names.
    files: ["{components,entrypoints,utils}/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
  },
  ...convexPlugin.configs.recommended,
  {
    files: ["convex/**/*.ts"],
    rules: {
      "@convex-dev/no-collect-in-query": "warn",
    },
  },
);
