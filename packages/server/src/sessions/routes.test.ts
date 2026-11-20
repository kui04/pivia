import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { CreateSessionResponse, SessionDetailResponse, SessionListResponse } from "@pivia/protocol";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { createFakeRuntimeHarness, type FakeRuntimeHarness } from "../testing/fake-runtime.ts";
import { SessionCatalog } from "./catalog.ts";
import { SessionRegistry } from "./runtime.ts";

describe("session routes", () => {
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

    function createSessionDir(): string {
        const dir = mkdtempSync(join(tmpdir(), "pivia-app-sessions-"));
        tempDirs.push(dir);
        return dir;
    }

    function writeSessionFixture(dir: string, id: string, text: string): void {
        const timestamp = "2026-04-01T00:00:00.000Z";
        const header = { type: "session", version: 3, id, timestamp, cwd: "/tmp/pivia-project" };
        const message = {
            type: "message",
            id: "entry-1",
            parentId: null,
            timestamp,
            message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
        };
        writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, "utf8");
    }

    function createReadOnlyApp(sessionDir: string): ReturnType<typeof buildApp> {
        const app = buildApp({
            logger: createLogger({ level: "silent" }),
            auth: { password: "secret" },
            sessions: new SessionCatalog({
                sessionDir,
                agentDir: sessionDir,
                cwd: sessionDir,
                env: {},
                logger: createLogger({ level: "silent" }),
            }),
        });
        apps.push(app);
        return app;
    }

    function createLifecycleFixture(): {
        readonly app: ReturnType<typeof buildApp>;
        readonly registry: SessionRegistry;
        readonly harness: FakeRuntimeHarness;
        readonly root: string;
        readonly projectDir: string;
        readonly authHeaders: { readonly authorization: string };
    } {
        const root = mkdtempSync(join(tmpdir(), "pivia-session-routes-"));
        tempDirs.push(root);
        const projectDir = join(root, "project");
        mkdirSync(projectDir, { recursive: true });
        const sessionDir = join(root, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        const logger = createLogger({ level: "silent" });
        const catalog = new SessionCatalog({ sessionDir, agentDir: root, cwd: root, env: {}, logger });
        const harness = createFakeRuntimeHarness();
        const registry = new SessionRegistry({
            catalog,
            logger,
            agentDir: root,
            runtimeFactory: harness.factory,
            idleTimeoutMs: 0,
        });
        const app = buildApp({ logger, auth: { password: "secret" }, sessions: catalog, registry });
        apps.push(app);
        return { app, registry, harness, root, projectDir, authHeaders: { authorization: "Bearer secret" } };
    }

    it("requires authentication for both session endpoints", async () => {
        const sessionDir = createSessionDir();
        writeSessionFixture(sessionDir, "session-alpha", "alpha question");
        const app = createReadOnlyApp(sessionDir);

        const list = await app.inject({ method: "GET", url: "/api/sessions" });
        expect(list.statusCode).toBe(401);
        expect(list.json()).toEqual({ error: "unauthorized", message: "Authentication required." });

        const detail = await app.inject({ method: "GET", url: "/api/sessions/session-alpha" });
        expect(detail.statusCode).toBe(401);
        expect(detail.json()).toEqual({ error: "unauthorized", message: "Authentication required." });
    });

    it("returns a list and one detail with a bearer credential", async () => {
        const sessionDir = createSessionDir();
        writeSessionFixture(sessionDir, "session-alpha", "alpha question");
        writeSessionFixture(sessionDir, "session-beta", "beta question");
        const app = createReadOnlyApp(sessionDir);

        const list = await app.inject({
            method: "GET",
            url: "/api/sessions",
            headers: { authorization: "Bearer secret" },
        });
        expect(list.statusCode).toBe(200);
        const listBody = list.json<SessionListResponse>();
        expect(listBody.sessions.map((session) => session.id).sort()).toEqual(["session-alpha", "session-beta"]);
        expect(Number.isFinite(listBody.scannedAtMs)).toBe(true);
        expect(list.body).not.toContain("allMessagesText");
        expect(list.body).not.toContain(sessionDir);

        const detail = await app.inject({
            method: "GET",
            url: "/api/sessions/session-alpha",
            headers: { authorization: "Bearer secret" },
        });
        expect(detail.statusCode).toBe(200);
        const detailBody = detail.json<SessionDetailResponse>();
        expect(detailBody.session).toMatchObject({ id: "session-alpha", firstMessage: "alpha question" });
        expect(detailBody.entries[0]).toMatchObject({ type: "session", id: "session-alpha", version: 3 });
        expect(detailBody.entries).toHaveLength(2);
        expect(detail.body).not.toContain("allMessagesText");
        expect(detail.body).not.toContain(sessionDir);
    });

    it("returns 400 for invalid ids and 404 for unknown sessions", async () => {
        const sessionDir = createSessionDir();
        writeSessionFixture(sessionDir, "session-alpha", "alpha question");
        const app = createReadOnlyApp(sessionDir);
        const headers = { authorization: "Bearer secret" };

        const invalid = await app.inject({ method: "GET", url: "/api/sessions/%21invalid", headers });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toEqual({ error: "invalid_request", message: "Invalid session id." });

        // The router resolves the dot segments of `%2e%2e` before route matching, so this path
        // never reaches the handler and the not-found handler rejects it.
        const dotSegments = await app.inject({ method: "GET", url: "/api/sessions/%2e%2e", headers });
        expect(dotSegments.statusCode).toBe(404);
        expect(dotSegments.json()).toEqual({ error: "not_found", message: "Not found." });

        const encodedSlash = await app.inject({ method: "GET", url: "/api/sessions/..%2Fescape", headers });
        expect(encodedSlash.statusCode).toBe(400);
        expect(encodedSlash.json()).toEqual({ error: "invalid_request", message: "Invalid session id." });

        const encodedDotSlash = await app.inject({ method: "GET", url: "/api/sessions/%2e%2e%2Fescape", headers });
        expect(encodedDotSlash.statusCode).toBe(400);
        expect(encodedDotSlash.json()).toEqual({ error: "invalid_request", message: "Invalid session id." });

        const missing = await app.inject({ method: "GET", url: "/api/sessions/session-unknown", headers });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: "not_found", message: "Session not found." });
    });

    it("requires auth and validates the cwd for POST /api/sessions", async () => {
        const fixture = createLifecycleFixture();

        const unauthenticated = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            payload: { cwd: fixture.projectDir },
        });
        expect(unauthenticated.statusCode).toBe(401);

        const missingBody = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: {},
        });
        expect(missingBody.statusCode).toBe(400);

        const extraField = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: fixture.projectDir, extra: true },
        });
        expect(extraField.statusCode).toBe(400);

        const missingDir = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: join(fixture.root, "missing") },
        });
        expect(missingDir.statusCode).toBe(400);
        expect(missingDir.json()).toMatchObject({ error: "invalid_request" });

        const filePath = join(fixture.root, "file.txt");
        writeFileSync(filePath, "file", "utf8");
        const notDirectory = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: filePath },
        });
        expect(notDirectory.statusCode).toBe(400);
        expect(notDirectory.json()).toMatchObject({ error: "invalid_request" });

        const created = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: fixture.projectDir },
        });
        expect(created.statusCode).toBe(201);
        const body = created.json<CreateSessionResponse>();
        expect(body.session).toMatchObject({
            cwd: realpathSync(fixture.projectDir),
            firstMessage: "(no messages)",
            attachedClients: 0,
        });
        expect(["starting", "idle"]).toContain(body.session.runtimeState);
        expect(body.session.id.length).toBeGreaterThan(0);
        expect(created.body).not.toContain("sessionFile");

        const list = await fixture.app.inject({ method: "GET", url: "/api/sessions", headers: fixture.authHeaders });
        expect(list.statusCode).toBe(200);
        expect(list.json<SessionListResponse>().sessions.map((session) => session.id)).toContain(body.session.id);

        const detail = await fixture.app.inject({
            method: "GET",
            url: `/api/sessions/${body.session.id}`,
            headers: fixture.authHeaders,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json<SessionDetailResponse>().entries[0]).toMatchObject({
            type: "session",
            id: body.session.id,
        });
    });

    it("closes an active session and reports unknown or invalid ids", async () => {
        const fixture = createLifecycleFixture();
        const create = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: fixture.projectDir },
        });
        expect(create.statusCode).toBe(201);
        const { id } = create.json<CreateSessionResponse>().session;

        const closed = await fixture.app.inject({
            method: "POST",
            url: `/api/sessions/${id}/close`,
            headers: fixture.authHeaders,
        });
        expect(closed.statusCode).toBe(200);
        expect(closed.json()).toEqual({ closed: true });
        expect(fixture.registry.activeSessionCount).toBe(0);

        const again = await fixture.app.inject({
            method: "POST",
            url: `/api/sessions/${id}/close`,
            headers: fixture.authHeaders,
        });
        expect(again.statusCode).toBe(200);
        expect(again.json()).toEqual({ closed: false });

        const unknown = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions/session-unknown/close",
            headers: fixture.authHeaders,
        });
        expect(unknown.statusCode).toBe(200);
        expect(unknown.json()).toEqual({ closed: false });

        const invalid = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions/%21invalid/close",
            headers: fixture.authHeaders,
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toEqual({ error: "invalid_request", message: "Invalid session id." });
    });

    it("supports incremental slice queries and compresses session endpoints without compressing auth routes", async () => {
        const sessionDir = createSessionDir();
        const longText = "x".repeat(2048);
        writeSessionFixture(sessionDir, "session-slice", longText);
        const app = createReadOnlyApp(sessionDir);
        const headers = { authorization: "Bearer secret", "accept-encoding": "gzip" };

        const full = await app.inject({ method: "GET", url: "/api/sessions/session-slice", headers });
        expect(full.statusCode).toBe(200);
        expect(full.headers["content-encoding"]).toBe("gzip");

        const fullBody = JSON.parse(gunzipSync(full.rawPayload).toString("utf8")) as SessionDetailResponse;
        expect(fullBody.entriesVersion).toBeTruthy();
        expect(fullBody.baseEntryCount).toBe(0);
        expect(fullBody.entries).toHaveLength(2);

        const slice = await app.inject({
            method: "GET",
            url: `/api/sessions/session-slice?entriesVersion=${encodeURIComponent(fullBody.entriesVersion ?? "")}&afterCount=1&afterEntryId=session-slice`,
            headers: { authorization: "Bearer secret" },
        });
        expect(slice.statusCode).toBe(200);
        const sliceBody = slice.json<SessionDetailResponse>();
        expect(sliceBody.baseEntryCount).toBe(1);
        expect(sliceBody.entries).toHaveLength(1);

        // Auth routes must remain uncompressed even with accept-encoding: gzip (global: false).
        const authStatus = await app.inject({
            method: "GET",
            url: "/api/auth/status",
            headers: { "accept-encoding": "gzip" },
        });
        expect(authStatus.statusCode).toBe(200);
        expect(authStatus.headers["content-encoding"]).toBeUndefined();
    });
});
