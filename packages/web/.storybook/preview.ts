import type { Preview } from "@storybook/react-vite";

// Load the stylesheets in the same order as src/main.tsx so stories render
// with the real tokens, reset rules, and lazy-loaded fonts.
import "../src/styles/token.css";
import "../src/styles/reset.css";
import "../src/styles/global.css";
import { ensureFontRole } from "../src/lib/fonts";

void Promise.all([ensureFontRole("sans"), ensureFontRole("mono"), ensureFontRole("serif")]);

const preview: Preview = {
    parameters: {
        // Fail the Vitest run on axe-core violations instead of reporting them
        // as todos. A story that cannot be fixed can opt out with
        // parameters: { a11y: { test: "todo" } }.
        a11y: { test: "error" },
        controls: {
            matchers: {
                color: /(background|color)$/i,
                date: /Date$/i,
            },
        },
    },
};

export default preview;
