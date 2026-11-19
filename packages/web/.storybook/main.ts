import { fileURLToPath, URL } from "node:url";

import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
    stories: ["../src/**/*.stories.@(ts|tsx)"],
    // Keep story-only assets out of the app build; Storybook serves this folder at the root.
    staticDirs: [fileURLToPath(new URL("./fixtures", import.meta.url))],
    addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
    framework: {
        name: "@storybook/react-vite",
        // The builder reuses vite.config.ts, so stories resolve the "@" and
        // "@components" aliases and build against the same target as the app.
        options: {},
    },
};

export default config;
