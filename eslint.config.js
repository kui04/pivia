import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

// Each package owns its tsconfig.json. projectService finds the nearest one for every file, so this
// root config needs no list of projects.
export default tseslint.config(
    { ignores: ["**/dist", "**/node_modules", ".devenv", ".direnv"] },
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
    prettier,
);
