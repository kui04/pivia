import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// Each package owns its tsconfig.json. projectService finds the nearest one for every file, so this
// root config needs no list of projects.
export default tseslint.config(
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
        },
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
    prettier,
);
