import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API and WebSocket endpoints stay on the same origin in production. During
// development Vite forwards them to the Node server.
const apiTarget = process.env.PIVIA_API_URL ?? "http://127.0.0.1:3141";

export default defineConfig({
    plugins: [react()],
    resolve: {
        // The protocol package exports its TypeScript source under this condition, so the
        // frontend builds against source without a separate `packages/protocol/dist` build.
        // Vite replaces the default condition list when this option is set, so keep the
        // defaults after it.
        conditions: ["@pivia/source", "module", "browser", "development|production"],
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            // The directory target lets the "@components/*" subpath alias resolve; the
            // TypeScript path maps the barrel import itself to src/components/index.ts.
            "@components": fileURLToPath(new URL("./src/components", import.meta.url)),
            // Vitest's Node project does not use the client export condition. Point every
            // resolver at the protocol source so values and types stay in step without a
            // separate `packages/protocol/dist` build.
            "@pivia/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
        },
    },
    server: {
        proxy: {
            "/api": {
                target: apiTarget,
                changeOrigin: true,
            },
            "/ws": {
                target: apiTarget,
                changeOrigin: true,
                ws: true,
            },
        },
    },
    build: {
        // Keep this in sync with the target in tsconfig.app.json.
        target: "es2024",
    },
    worker: {
        // Shiki splits language grammars into dynamic ES chunks inside highlight.worker.ts.
        format: "es",
    },
});
