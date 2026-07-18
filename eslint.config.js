import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow a leading-underscore name to mark a parameter as intentionally unused
      // (e.g. stub/no-op port implementations that must satisfy an interface shape).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "**/.vite/**", "**/coverage/**"] },
);
