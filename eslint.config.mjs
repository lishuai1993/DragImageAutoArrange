import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
// Passing `acronyms` at all *replaces* the rule's built-in list, so the defaults
// have to be carried over explicitly to add one of our own.
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/", "dist/", "*.config.mjs", "*.config.js", "*.config.ts"],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
  },
  {
    rules: {
      // "DIA" is this plugin's own acronym: without this the sentence-case rule
      // rewrites it to "dia" in every user-facing string that names it.
      "obsidianmd/ui/sentence-case": [
        "warn",
        { enforceCamelCaseLower: true, acronyms: [...DEFAULT_ACRONYMS, "DIA"] },
      ],
    },
  },
  {
    // The vitest bootstrap has to name the global object: its whole job is to
    // install the Electron-renderer globals (`window`) that the plugin code
    // assumes. `no-global-this` targets production code reaching for the global
    // object instead of `window`; here `window` does not exist yet, so the rule
    // cannot be satisfied by construction.
    files: ["tests/setup.ts"],
    rules: {
      "obsidianmd/no-global-this": "off",
      // This file *is* the `createEl`/`createDiv`/`createSpan` implementation
      // the rule wants callers to use, so its body necessarily starts from the
      // raw `document.createElement` primitive.
      "obsidianmd/prefer-create-el": "off",
    },
  },
]);
