import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API and WebSocket endpoints stay on the same origin in production. During
// development Vite forwards them to the Node server.
const apiTarget = process.env.PIVIA_API_URL ?? "http://127.0.0.1:3141";

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            // The directory target lets the "@components/*" subpath alias resolve; the
            // TypeScript path maps the barrel import itself to src/components/index.ts.
            "@components": fileURLToPath(new URL("./src/components", import.meta.url)),
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
        // Keep this in sync with the target in tsconfig.json.
        target: "es2024",
    },
});
