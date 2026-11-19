import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger, isLogLevel } from "./logger.ts";

describe("createLogger", () => {
    it("emits structured JSON records to the configured stream", async () => {
        const stream = new PassThrough();
        const chunks: string[] = [];
        stream.on("data", (chunk: Buffer) => {
            chunks.push(chunk.toString("utf8"));
        });

        const logger = createLogger({ level: "info", destination: stream });
        logger.debug({ hidden: true }, "ignored");
        logger.info({ port: 3141 }, "listening");

        await new Promise((resolve) => setImmediate(resolve));

        const lines = chunks.join("").trim().split("\n");
        expect(lines).toHaveLength(1);
        const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
        expect(record.msg).toBe("listening");
        expect(record.port).toBe(3141);
    });
});

describe("isLogLevel", () => {
    it("accepts valid pino levels and rejects unknown strings", () => {
        expect(isLogLevel("info")).toBe(true);
        expect(isLogLevel("silent")).toBe(true);
        expect(isLogLevel("verbose")).toBe(false);
    });
});
