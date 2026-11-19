import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { SessionDetailResponse, SessionListResponse } from "@pivia/protocol";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.ts";
import { createLogger } from "./logger.ts";
import { SessionCatalog } from "./sessions.ts";

describe("buildApp", () => {
    const apps: ReturnType<typeof buildApp>[] = [];

    afterEach(async () => {
        while (apps.length > 0) {
            const app = apps.pop();
            await app?.close();
        }
    });

    it("serves health status and version without auth", async () => {
        const app = buildApp({
            version: "1.2.3",
            logger: createLogger({ level: "silent" }),
            auth: { password: "secret" },
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

    it("protects private api and ws routes until authenticated with cookie or bearer", async () => {
        const app = buildApp({
            logger: createLogger({ level: "silent" }),
            auth: { password: "my-password", sessionTtlMs: 120_000 },
        });
        app.get("/api/protected", () => ({ secret: 42 }));
        app.get("/ws/sessions", () => ({ ok: true }));
        apps.push(app);

        const initialStatus = await app.inject({ method: "GET", url: "/api/auth/status" });
        expect(initialStatus.statusCode).toBe(200);
        expect(initialStatus.json()).toEqual({ authRequired: true, authenticated: false });

        const unauthProtected = await app.inject({ method: "GET", url: "/api/protected" });
        expect(unauthProtected.statusCode).toBe(401);
        expect(unauthProtected.json()).toEqual({ error: "unauthorized", message: "Authentication required." });

        const unauthWs = await app.inject({ method: "GET", url: "/ws/sessions" });
        expect(unauthWs.statusCode).toBe(401);

        // Unknown /api paths must also return 401 rather than leaking route existence.
        const unauthUnknown = await app.inject({ method: "GET", url: "/api/does-not-exist" });
        expect(unauthUnknown.statusCode).toBe(401);

        const badLogin = await app.inject({
            method: "POST",
            url: "/api/auth",
            payload: { password: "wrong" },
        });
        expect(badLogin.statusCode).toBe(401);
        expect(badLogin.json()).toEqual({ error: "invalid_credentials", message: "Invalid password." });

        const login = await app.inject({
            method: "POST",
            url: "/api/auth",
            payload: { password: "my-password" },
        });
        expect(login.statusCode).toBe(200);
        expect(login.json()).toEqual({ authenticated: true });

        const setCookie = String(login.headers["set-cookie"]);
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Strict");
        expect(setCookie).toContain("Max-Age=120");
        expect(setCookie).not.toContain("Secure");
        const cookiePair = setCookie.split(";")[0] ?? "";

        const authedStatus = await app.inject({
            method: "GET",
            url: "/api/auth/status",
            headers: { cookie: cookiePair },
        });
        expect(authedStatus.json()).toEqual({ authRequired: true, authenticated: true });

        const okProtected = await app.inject({
            method: "GET",
            url: "/api/protected",
            headers: { cookie: cookiePair },
        });
        expect(okProtected.statusCode).toBe(200);
        expect(okProtected.json()).toEqual({ secret: 42 });

        const okWs = await app.inject({
            method: "GET",
            url: "/ws/sessions",
            headers: { cookie: cookiePair },
        });
        expect(okWs.statusCode).toBe(200);

        const bearerOk = await app.inject({
            method: "GET",
            url: "/api/protected",
            headers: { authorization: "Bearer my-password" },
        });
        expect(bearerOk.statusCode).toBe(200);

        const logout = await app.inject({
            method: "POST",
            url: "/api/auth/logout",
            headers: { cookie: cookiePair },
        });
        expect(logout.statusCode).toBe(200);
        expect(logout.json()).toEqual({ authenticated: false });
        const clearedCookie = String(logout.headers["set-cookie"]);
        expect(clearedCookie).toContain("pivia_session=;");
        expect(clearedCookie).toContain("HttpOnly");
        expect(clearedCookie).toContain("Expires=Thu, 01 Jan 1970");

        const afterLogout = await app.inject({
            method: "GET",
            url: "/api/protected",
            headers: { cookie: cookiePair },
        });
        expect(afterLogout.statusCode).toBe(401);
    });

    it("returns standardized ApiErrorResponse for 404 and malformed or unknown-field payloads", async () => {
        const app = buildApp({
            logger: createLogger({ level: "silent" }),
            auth: { password: "secret" },
        });
        apps.push(app);

        const notFoundPage = await app.inject({ method: "GET", url: "/secret-probe-path" });
        expect(notFoundPage.statusCode).toBe(404);
        expect(notFoundPage.json()).toEqual({ error: "not_found", message: "Not found." });

        const authedNotFoundApi = await app.inject({
            method: "GET",
            url: "/api/nonexistent-endpoint",
            headers: { authorization: "Bearer secret" },
        });
        expect(authedNotFoundApi.statusCode).toBe(404);
        expect(authedNotFoundApi.json()).toEqual({ error: "not_found", message: "Not found." });

        const malformedJson = await app.inject({
            method: "POST",
            url: "/api/auth",
            headers: { "content-type": "application/json" },
            payload: "{bad json",
        });
        expect(malformedJson.statusCode).toBe(400);
        expect(malformedJson.json()).toEqual({ error: "invalid_request", message: "Invalid request." });

        const missingPassword = await app.inject({
            method: "POST",
            url: "/api/auth",
            payload: {},
        });
        expect(missingPassword.statusCode).toBe(400);
        expect(missingPassword.json()).toMatchObject({ error: "invalid_request" });
        expect(Object.keys(missingPassword.json<Record<string, unknown>>()).sort()).toEqual(["error", "message"]);

        const extraField = await app.inject({
            method: "POST",
            url: "/api/auth",
            payload: { password: "secret", extra: true },
        });
        expect(extraField.statusCode).toBe(400);
        expect(extraField.json()).toMatchObject({ error: "invalid_request" });
    });

    it("isolates rate limits per proxied client behind loopback and logs failures", async () => {
        const logStream = new PassThrough();
        const logChunks: string[] = [];
        logStream.on("data", (chunk: Buffer) => {
            logChunks.push(chunk.toString("utf8"));
        });

        const app = buildApp({
            logger: createLogger({ level: "warn", destination: logStream }),
            auth: { password: "secret", maxFailures: 2, rateWindowMs: 60_000 },
        });
        app.get("/api/protected", () => ({ ok: true }));
        apps.push(app);

        // Two failed attempts for proxied client A (198.51.100.1) exhaust its quota.
        await app.inject({
            method: "POST",
            url: "/api/auth",
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "198.51.100.1" },
            payload: { password: "bad" },
        });
        await app.inject({
            method: "GET",
            url: "/api/protected",
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "198.51.100.1", authorization: "Bearer bad" },
        });

        // Client A is blocked on /api/auth, /api/protected, and /api/auth/status.
        const blockedLogin = await app.inject({
            method: "POST",
            url: "/api/auth",
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "198.51.100.1" },
            payload: { password: "secret" },
        });
        expect(blockedLogin.statusCode).toBe(429);
        const retryAfter = Number(blockedLogin.headers["retry-after"]);
        expect(Number.isInteger(retryAfter)).toBe(true);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);

        const blockedStatus = await app.inject({
            method: "GET",
            url: "/api/auth/status",
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "198.51.100.1", authorization: "Bearer bad" },
        });
        expect(blockedStatus.statusCode).toBe(429);
        expect(blockedStatus.headers["retry-after"]).toBeDefined();

        // Client B behind the same loopback proxy is unaffected.
        const clientBLogin = await app.inject({
            method: "POST",
            url: "/api/auth",
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "198.51.100.2" },
            payload: { password: "secret" },
        });
        expect(clientBLogin.statusCode).toBe(200);

        // Non-loopback peers cannot rotate X-Forwarded-For to bypass rate limiting.
        await app.inject({
            method: "POST",
            url: "/api/auth",
            remoteAddress: "203.0.113.10",
            headers: { "x-forwarded-for": "198.51.100.50" },
            payload: { password: "bad" },
        });
        await app.inject({
            method: "POST",
            url: "/api/auth",
            remoteAddress: "203.0.113.10",
            headers: { "x-forwarded-for": "198.51.100.51" },
            payload: { password: "bad" },
        });
        const blockedExternal = await app.inject({
            method: "POST",
            url: "/api/auth",
            remoteAddress: "203.0.113.10",
            headers: { "x-forwarded-for": "198.51.100.52" },
            payload: { password: "secret" },
        });
        expect(blockedExternal.statusCode).toBe(429);

        await new Promise((resolve) => setImmediate(resolve));
        const loggedText = logChunks.join("");
        expect(loggedText).toContain("login failed with invalid password");
        expect(loggedText).toContain("login rate-limited");
        expect(loggedText).not.toContain('"bad"');
    });

    it("marks session cookie Secure only when proxied over HTTPS from loopback", async () => {
        const app = buildApp({
            logger: createLogger({ level: "silent" }),
            auth: { password: "secret" },
        });
        apps.push(app);

        const loopbackHttps = await app.inject({
            method: "POST",
            url: "/api/auth",
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-proto": "https" },
            payload: { password: "secret" },
        });
        expect(loopbackHttps.statusCode).toBe(200);
        expect(String(loopbackHttps.headers["set-cookie"])).toContain("Secure");

        const externalSpoof = await app.inject({
            method: "POST",
            url: "/api/auth",
            remoteAddress: "203.0.113.10",
            headers: { "x-forwarded-proto": "https" },
            payload: { password: "secret" },
        });
        expect(externalSpoof.statusCode).toBe(200);
        expect(String(externalSpoof.headers["set-cookie"])).not.toContain("Secure");
    });

    it("allows requests when authentication is explicitly disabled", async () => {
        const app = buildApp({
            logger: createLogger({ level: "silent" }),
            auth: { disabled: true },
        });
        app.get("/api/protected", () => ({ open: true }));
        apps.push(app);

        const status = await app.inject({ method: "GET", url: "/api/auth/status" });
        expect(status.json()).toEqual({ authRequired: false, authenticated: true });

        const login = await app.inject({
            method: "POST",
            url: "/api/auth",
            payload: { password: "ignored" },
        });
        expect(login.statusCode).toBe(200);
        expect(login.json()).toEqual({ authenticated: true });

        const logout = await app.inject({ method: "POST", url: "/api/auth/logout" });
        expect(logout.statusCode).toBe(200);
        expect(logout.json()).toEqual({ authenticated: false });

        const protectedRes = await app.inject({ method: "GET", url: "/api/protected" });
        expect(protectedRes.statusCode).toBe(200);
    });
});

describe("session routes", () => {
    const apps: ReturnType<typeof buildApp>[] = [];
    const sessionDirs: string[] = [];

    afterEach(async () => {
        let app = apps.pop();
        while (app !== undefined) {
            await app.close();
            app = apps.pop();
        }
        let dir = sessionDirs.pop();
        while (dir !== undefined) {
            rmSync(dir, { recursive: true, force: true });
            dir = sessionDirs.pop();
        }
    });

    function createSessionDir(): string {
        const dir = mkdtempSync(join(tmpdir(), "pivia-app-sessions-"));
        sessionDirs.push(dir);
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

    function createSessionApp(sessionDir: string): ReturnType<typeof buildApp> {
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

    it("requires authentication for both session endpoints", async () => {
        const sessionDir = createSessionDir();
        writeSessionFixture(sessionDir, "session-alpha", "alpha question");
        const app = createSessionApp(sessionDir);

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
        const app = createSessionApp(sessionDir);

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
        const app = createSessionApp(sessionDir);
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
});
