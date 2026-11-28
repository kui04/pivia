import { fileURLToPath, URL } from "node:url";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

// Vitest reuses vite.config.ts for the aliases and build target, then adds the
// unit and Storybook projects. Storybook tests need Chromium, so they stay a
// separate project from the fast Node unit tests.
export default mergeConfig(
    viteConfig,
    defineConfig({
        // Pre-bundle the Base UI entry points the stories use. A dependency
        // discovered mid-run reloads the test page and invalidates the run.
        optimizeDeps: {
            include: [
                "@base-ui/react/alert-dialog",
                "@base-ui/react/button",
                "@base-ui/react/checkbox",
                "@base-ui/react/collapsible",
                "@base-ui/react/dialog",
                "@base-ui/react/drawer",
                "@base-ui/react/field",
                "@base-ui/react/fieldset",
                "@base-ui/react/form",
                "@base-ui/react/input",
                "@base-ui/react/menu",
                "@base-ui/react/popover",
                "@base-ui/react/progress",
                "@base-ui/react/radio",
                "@base-ui/react/radio-group",
                "@base-ui/react/scroll-area",
                "@base-ui/react/select",
                "@base-ui/react/toast",
                "@base-ui/react/tooltip",
                "@shikijs/themes/dark-plus",
                "@shikijs/themes/light-plus",
                "katex",
                "lucide-react",
                "react-markdown",
                "react-zoom-pan-pinch",
                "rehype-katex",
                "remark-breaks",
                "remark-gfm",
                "remark-math",
                "shiki",
                "shiki/core",
                "shiki/engine/oniguruma",
                "shiki/langs",
                "shiki/wasm",
                "zustand",
                "zustand/middleware",
            ],
        },
        test: {
            projects: [
                {
                    extends: true,
                    test: {
                        name: "unit",
                        include: ["src/**/*.test.ts"],
                        environment: "node",
                    },
                },
                {
                    extends: true,
                    plugins: [
                        storybookTest({
                            configDir: fileURLToPath(new URL("./.storybook", import.meta.url)),
                        }),
                    ],
                    test: {
                        name: "storybook",
                        browser: {
                            enabled: true,
                            headless: true,
                            provider: playwright(),
                            instances: [{ browser: "chromium" }],
                        },
                    },
                },
            ],
        },
    }),
);
