import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.ts";
import { createLogger } from "./logger.ts";

describe("buildApp", () => {
    const apps: ReturnType<typeof buildApp>[] = [];

    afterEach(async () => {
        while (apps.length > 0) {
            const app = apps.pop();
            await app?.close();
        }
    });

    it("serves health status and version", async () => {
        const app = buildApp({
            version: "1.2.3",
            logger: createLogger({ level: "silent" }),
        });
        apps.push(app);

        const response = await app.inject({
            method: "GET",
            url: "/api/health",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            status: "ok",
            version: "1.2.3",
        });
    });
});
