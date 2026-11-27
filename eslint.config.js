import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// Each package owns its tsconfig.json. projectService finds the nearest one for every file, so this
// root config needs no list of projects.
export default defineConfig(
    { ignores: ["**/dist", "**/node_modules", "**/storybook-static", ".devenv", ".direnv"] },
    {
        files: ["**/*.{js,mjs,cjs}"],
        extends: [js.configs.recommended],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: globals.node,
        },
    },
    {
        files: ["packages/**/*.{ts,tsx}"],
        extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
            "@typescript-eslint/no-deprecated": "error",
            "@typescript-eslint/no-unnecessary-condition": "error",
            "@typescript-eslint/no-unnecessary-type-parameters": "error",
            "@typescript-eslint/no-unsafe-class-instance-assignment": "error",
            "@typescript-eslint/return-await": ["error", "error-handling-correctness-only"],
            // A `default` clause already documents that every member of the union is handled.
            "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
            // `x == null` is the one comparison that reads better than two checks.
            eqeqeq: ["error", "always", { null: "ignore" }],
            "no-console": "error",
        },
    },
    {
        files: ["packages/server/**/*.ts"],
        languageOptions: {
            globals: globals.node,
        },
    },
    {
        // The web app runs in the browser. React Hooks checks effect dependencies and the refresh
        // plugin keeps the module graph compatible with Vite's fast refresh boundary.
        files: ["packages/web/src/**/*.{ts,tsx}"],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommendedTypeChecked,
            reactHooks.configs.flat.recommended,
            reactRefresh.configs.vite,
        ],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: globals.browser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
            // A missing dependency ships a stale closure, so it must fail the run, not warn.
            "react-hooks/exhaustive-deps": "error",
        },
    },
    {
        // The Storybook a11y addon only checks stories; this covers every rendered component.
        files: ["packages/web/src/**/*.tsx"],
        extends: [jsxA11y.flatConfigs.recommended],
    },
    {
        // Story files export the meta object and story objects, not a component, and the test
        // entry only mounts a React tree. Neither participates in the fast refresh boundary.
        files: ["packages/web/src/**/*.stories.tsx", "packages/web/src/main.tsx"],
        rules: {
            "react-refresh/only-export-components": "off",
        },
    },
    {
        // Vite, Vitest and Storybook configuration run in Node.
        files: ["packages/web/vite.config.ts", "packages/web/vitest.config.ts", "packages/web/.storybook/**/*.ts"],
        extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: globals.node,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
        },
    },
    {
        // The protocol package imports SDK types to derive wire types; a re-export would make
        // consumers depend on SDK shapes instead of the protocol contract.
        files: ["packages/protocol/src/**/*.ts"],
        rules: {
            "no-restricted-syntax": [
                "error",
                {
                    selector: "ExportNamedDeclaration[source.value=/^@earendil-works\\/pi-/]",
                    message: "Derive a protocol type instead of re-exporting an SDK type.",
                },
                {
                    selector: "ExportAllDeclaration[source.value=/^@earendil-works\\/pi-/]",
                    message: "Derive a protocol type instead of re-exporting an SDK type.",
                },
            ],
        },
    },
    {
        // The browser app reaches the server through the endpoint descriptors, never by importing
        // server modules (which would pull Node-only code into the bundle).
        files: ["packages/web/**/*.{ts,tsx}"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: ["@pivia/server", "@pivia/server/*"],
                            message: "Call the server through @pivia/protocol endpoints instead.",
                        },
                    ],
                },
            ],
        },
    },
    prettier,
);
