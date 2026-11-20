import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        conditions: ["@pivia/source"],
        // Vitest's Node resolver does not apply the client export condition. Resolve the shared
        // package from source so tests do not depend on a stale `packages/protocol/dist`.
        alias: {
            "@pivia/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
        },
    },
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
    },
});
