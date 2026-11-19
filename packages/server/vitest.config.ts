import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        conditions: ["@pivia/source"],
    },
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
    },
});
