import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DirectoryListResponse } from "@pivia/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { SessionCatalog } from "../sessions/catalog.ts";

describe("fs routes", () => {
    const apps: ReturnType<typeof buildApp>[] = [];
    const tempDirs: string[] = [];

    afterEach(async () => {
        let app = apps.pop();
        while (app !== undefined) {
            await app.close();
            app = apps.pop();
        }
        let dir = tempDirs.pop();
        while (dir !== undefined) {
            rmSync(dir, { recursive: true, force: true });
            dir = tempDirs.pop();
        }
    });

    function createFixture() {
        const root = mkdtempSync(join(tmpdir(), "pivia-fs-routes-"));
        tempDirs.push(root);
        const browseRoot = join(root, "browse");
        mkdirSync(join(browseRoot, "Beta"), { recursive: true });
        mkdirSync(join(browseRoot, "alpha"), { recursive: true });
        mkdirSync(join(browseRoot, ".hidden"), { recursive: true });
        writeFileSync(join(browseRoot, "notes.txt"), "hello", "utf8");
        const linkedDir = join(root, "linked-target");
        mkdirSync(linkedDir, { recursive: true });
        symlinkSync(linkedDir, join(browseRoot, "symlink-dir"));
        symlinkSync(join(root, "dangling"), join(browseRoot, "broken-link"));

        const sessionDir = join(root, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        const logger = createLogger({ level: "silent" });
        const catalog = new SessionCatalog({ sessionDir, agentDir: root, cwd: root, env: {}, logger });
        const app = buildApp({
            logger,
            auth: { password: "secret" },
            sessions: catalog,
        });
        apps.push(app);
        return {
            app,
            root: realpathSync(root),
            browseRoot: realpathSync(browseRoot),
            authHeaders: { authorization: "Bearer secret" },
        };
    }

    it("requires auth and lists sorted subdirectories with parent navigation", async () => {
        const fixture = createFixture();

        const unauthenticated = await fixture.app.inject({
            method: "GET",
            url: "/api/fs/directories",
        });
        expect(unauthenticated.statusCode).toBe(401);

        const defaultRes = await fixture.app.inject({
            method: "GET",
            url: "/api/fs/directories",
            headers: fixture.authHeaders,
        });
        expect(defaultRes.statusCode).toBe(200);
        expect(defaultRes.json<DirectoryListResponse>().path).toBe(realpathSync(process.cwd()));

        const listRes = await fixture.app.inject({
            method: "GET",
            url: `/api/fs/directories?path=${encodeURIComponent(fixture.browseRoot)}`,
            headers: fixture.authHeaders,
        });
        expect(listRes.statusCode).toBe(200);
        expect(listRes.json<DirectoryListResponse>()).toEqual({
            path: fixture.browseRoot,
            parent: dirname(fixture.browseRoot),
            directories: [".hidden", "alpha", "Beta", "symlink-dir"],
            truncated: false,
        });

        const rootRes = await fixture.app.inject({
            method: "GET",
            url: `/api/fs/directories?path=${encodeURIComponent("/")}`,
            headers: fixture.authHeaders,
        });
        expect(rootRes.statusCode).toBe(200);
        expect(rootRes.json<DirectoryListResponse>().parent).toBeNull();
    });

    it("caps a large directory listing and reports truncation", async () => {
        const fixture = createFixture();
        const large = join(fixture.root, "large");
        mkdirSync(large, { recursive: true });
        for (let index = 0; index < 1001; index += 1) {
            mkdirSync(join(large, `dir-${String(index).padStart(4, "0")}`));
        }

        const res = await fixture.app.inject({
            method: "GET",
            url: `/api/fs/directories?path=${encodeURIComponent(large)}`,
            headers: fixture.authHeaders,
        });
        expect(res.statusCode).toBe(200);
        const listing = res.json<DirectoryListResponse>();
        expect(listing.truncated).toBe(true);
        expect(listing.directories).toHaveLength(1000);
        expect(listing.directories.at(-1)).toBe("dir-0999");
    });

    it("rejects relative, missing, and non-directory paths", async () => {
        const fixture = createFixture();

        const relative = await fixture.app.inject({
            method: "GET",
            url: "/api/fs/directories?path=relative/dir",
            headers: fixture.authHeaders,
        });
        expect(relative.statusCode).toBe(400);
        expect(relative.json()).toMatchObject({ error: "invalid_request" });

        const missing = await fixture.app.inject({
            method: "GET",
            url: `/api/fs/directories?path=${encodeURIComponent(join(fixture.root, "missing"))}`,
            headers: fixture.authHeaders,
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ error: "directory_not_found" });

        const filePath = join(fixture.browseRoot, "notes.txt");
        const notDir = await fixture.app.inject({
            method: "GET",
            url: `/api/fs/directories?path=${encodeURIComponent(filePath)}`,
            headers: fixture.authHeaders,
        });
        expect(notDir.statusCode).toBe(400);
        expect(notDir.json()).toMatchObject({ error: "invalid_request" });
    });
});
