import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type {
    CreateSessionResponse,
    SessionDetailResponse,
    SessionListResponse,
    WsClientCommand,
    WsServerMessage,
} from "@pivia/protocol";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildApp } from "./app.ts";
import { createLogger } from "./logger.ts";
import { SessionRegistry } from "./runtime.ts";
import { SessionCatalog } from "./sessions.ts";
import {
    createFakeRuntimeHarness,
    createTextDeltaEvent,
    type FakeRuntimeHarness,
    type FakeSession,
} from "./testing/fake-runtime.ts";

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

interface WsTestClient {
    readonly messages: WsServerMessage[];
    send(message: WsClientCommand | Record<string, unknown>): void;
    sendRaw(text: string): void;
    waitFor<T extends WsServerMessage>(
        predicate: (message: WsServerMessage) => message is T,
        timeoutMs?: number,
    ): Promise<T>;
    close(): Promise<void>;
}

function rawDataToString(data: WebSocket.RawData): string {
    if (typeof data === "string") {
        return data;
    }
    if (Buffer.isBuffer(data)) {
        return data.toString("utf8");
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString("utf8");
    }
    return Buffer.from(data).toString("utf8");
}

async function connectWebSocket(url: string, headers: Record<string, string>): Promise<WsTestClient> {
    const socket = new WebSocket(url, { headers });
    const messages: WsServerMessage[] = [];
    socket.on("message", (data) => {
        messages.push(JSON.parse(rawDataToString(data)) as WsServerMessage);
    });
    await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", (error) => reject(error));
    });
    socket.on("error", () => {});

    return {
        messages,
        send(message) {
            socket.send(JSON.stringify(message));
        },
        sendRaw(text) {
            socket.send(text);
        },
        waitFor: (predicate, timeoutMs = 2000) => waitForWsMessage(messages, predicate, timeoutMs),
        async close() {
            if (socket.readyState === WebSocket.CLOSED) {
                return;
            }
            await new Promise<void>((resolve) => {
                socket.once("close", () => resolve());
                socket.close();
            });
        },
    };
}

async function waitForWsMessage<T extends WsServerMessage>(
    messages: readonly WsServerMessage[],
    predicate: (message: WsServerMessage) => message is T,
    timeoutMs = 2000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const match = messages.find(predicate);
        if (match !== undefined) {
            return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`Timed out waiting for websocket message. Received: ${JSON.stringify(messages)}`);
}

interface UpgradeProbe {
    readonly statusCode: number;
    readonly connection: string | undefined;
}

async function waitForRuntimeState(
    registry: SessionRegistry,
    sessionId: string,
    expected: string,
    timeoutMs = 2000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const detail = await registry.getById(sessionId);
        if (detail?.session.runtimeState === expected) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`Timed out waiting for runtime state ${expected}`);
}

function upgradeStatus(url: URL, headers: Record<string, string>): Promise<UpgradeProbe> {
    return new Promise((resolve, reject) => {
        const request = httpRequest({
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            // A rejected upgrade destroys the raw socket server-side. Bypass the global
            // keep-alive agent so the next probe never reuses a connection that is already dead.
            agent: false,
            headers: {
                connection: "upgrade",
                upgrade: "websocket",
                "sec-websocket-version": "13",
                "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
                ...headers,
            },
        });
        request.on("response", (response) => {
            const statusCode = response.statusCode ?? 0;
            const connection =
                typeof response.headers.connection === "string" ? response.headers.connection : undefined;
            response.once("end", () => resolve({ statusCode, connection }));
            response.once("error", reject);
            response.resume();
        });
        request.on("upgrade", () => resolve({ statusCode: 101, connection: undefined }));
        request.on("error", reject);
        request.end();
    });
}

interface AppFixture {
    readonly app: ReturnType<typeof buildApp>;
    readonly registry: SessionRegistry;
    readonly harness: FakeRuntimeHarness;
    readonly root: string;
    readonly projectDir: string;
    readonly baseUrl: string;
    readonly wsBaseUrl: string;
    readonly cookie: string;
    readonly authHeaders: { readonly authorization: string };
}

describe("session runtime routes", () => {
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

    interface AppFixtureOptions {
        readonly onCreate?: ((session: FakeSession) => void) | undefined;
        readonly shutdownUiTimeoutMs?: number | undefined;
    }

    async function startAppFixture(options: AppFixtureOptions = {}): Promise<AppFixture> {
        const root = mkdtempSync(join(tmpdir(), "pivia-app-runtime-"));
        tempDirs.push(root);
        const projectDir = join(root, "project");
        mkdirSync(projectDir, { recursive: true });
        const sessionDir = join(root, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        const logger = createLogger({ level: "silent" });
        const catalog = new SessionCatalog({ sessionDir, agentDir: root, cwd: root, env: {}, logger });
        const harness = createFakeRuntimeHarness({ onCreate: options.onCreate });
        const registry = new SessionRegistry({
            catalog,
            logger,
            agentDir: root,
            runtimeFactory: harness.factory,
            idleTimeoutMs: 0,
            shutdownUiTimeoutMs: options.shutdownUiTimeoutMs,
        });
        const app = buildApp({ logger, auth: { password: "secret" }, sessions: catalog, registry });
        apps.push(app);
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        const url = new URL(address);

        const login = await app.inject({ method: "POST", url: "/api/auth", payload: { password: "secret" } });
        const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";

        return {
            app,
            registry,
            harness,
            root,
            projectDir,
            baseUrl: address,
            wsBaseUrl: `ws://${url.host}`,
            cookie,
            authHeaders: { authorization: "Bearer secret" },
        };
    }

    async function createSession(fixture: AppFixture): Promise<{ readonly id: string; readonly fake: FakeSession }> {
        const response = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: fixture.projectDir },
        });
        expect(response.statusCode).toBe(201);
        const body = response.json<CreateSessionResponse>();
        const fake = fixture.harness.find(body.session.id)?.session;
        if (fake === undefined) {
            throw new Error("expected a fake runtime for the created session");
        }
        return { id: body.session.id, fake };
    }

    it("requires auth and validates the cwd for POST /api/sessions", async () => {
        const fixture = await startAppFixture();

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
        const fixture = await startAppFixture();
        const { id } = await createSession(fixture);

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

    it("rejects websocket upgrades without authentication or with invalid parameters", async () => {
        const fixture = await startAppFixture();
        const { id } = await createSession(fixture);
        const url = new URL(`${fixture.wsBaseUrl}/ws/sessions/${id}`);

        expect(await upgradeStatus(url, {})).toEqual({ statusCode: 401, connection: "close" });

        const invalidAfterSeq = new URL(`${fixture.wsBaseUrl}/ws/sessions/${id}?afterSeq=-1`);
        expect(await upgradeStatus(invalidAfterSeq, fixture.authHeaders)).toEqual({
            statusCode: 400,
            connection: "close",
        });

        const unknownSession = new URL(`${fixture.wsBaseUrl}/ws/sessions/session-unknown`);
        expect(await upgradeStatus(unknownSession, fixture.authHeaders)).toEqual({
            statusCode: 404,
            connection: "close",
        });

        const invalidId = new URL(`${fixture.wsBaseUrl}/ws/sessions/%21invalid`);
        expect(await upgradeStatus(invalidId, fixture.authHeaders)).toEqual({
            statusCode: 400,
            connection: "close",
        });

        const probe = await connectWebSocket(url.toString(), fixture.authHeaders);
        await probe.waitFor((message): message is Extract<WsServerMessage, { type: "snapshot" }> => {
            return message.type === "snapshot";
        });
        await probe.close();
    });

    it("returns 201 while a session_start dialog is pending and answers it out of band", async () => {
        let startupDialog: Promise<string | undefined> | undefined;
        let signalBindStarted: (() => void) | undefined;
        const bindStarted = new Promise<void>((resolve) => {
            signalBindStarted = resolve;
        });
        const fixture = await startAppFixture({
            onCreate: (session) => {
                session.bindExtensionsHandler = async (bindings) => {
                    session.bindings = bindings;
                    signalBindStarted?.();
                    startupDialog = bindings.uiContext.select("Choose mode", ["safe", "danger"]);
                    await startupDialog;
                };
            },
        });

        const create = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: fixture.projectDir },
        });
        expect(create.statusCode).toBe(201);
        const sessionId = create.json<CreateSessionResponse>().session.id;
        expect(create.json<CreateSessionResponse>().session.runtimeState).toBe("starting");
        await bindStarted;

        const client = await connectWebSocket(`${fixture.wsBaseUrl}/ws/sessions/${sessionId}`, fixture.authHeaders);
        const snapshot = await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "snapshot" }> => message.type === "snapshot",
        );
        const request = snapshot.pendingUiRequests[0];
        if (request === undefined) {
            throw new Error("expected the startup dialog in the snapshot");
        }

        // The prompt waits for bindExtensions; the UI answer must bypass the command chain.
        client.send({ type: "prompt", id: "prompt", message: "hello" });
        client.send({ type: "extension_ui_response", id: request.id, value: "safe" });

        const response = await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "response" }> =>
                message.type === "response" && message.id === "prompt",
        );
        expect(response).toMatchObject({ success: true, data: { disposition: "started" } });
        if (startupDialog === undefined) {
            throw new Error("expected the startup dialog");
        }
        await expect(startupDialog).resolves.toBe("safe");
        await client.close();
    });

    it("delivers a session_shutdown dialog over the open websocket", async () => {
        const fixture = await startAppFixture();
        const { id } = await createSession(fixture);
        await waitForRuntimeState(fixture.registry, id, "idle");
        const client = await connectWebSocket(`${fixture.wsBaseUrl}/ws/sessions/${id}`, fixture.authHeaders);
        await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "snapshot" }> => message.type === "snapshot",
        );

        const runtime = fixture.harness.find(id);
        if (runtime === undefined) {
            throw new Error("expected the fake runtime");
        }
        runtime.disposeHandler = async (session) => {
            if (session.bindings === undefined) {
                throw new Error("expected extension bindings");
            }
            await session.bindings.uiContext.confirm("Save before closing?", "Unsaved changes.");
        };

        const closeResponsePromise = fixture.app.inject({
            method: "POST",
            url: `/api/sessions/${id}/close`,
            headers: fixture.authHeaders,
        });
        const request = await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "confirm",
        );
        client.send({ type: "extension_ui_response", id: request.request.id, confirmed: true });

        const closeResponse = await closeResponsePromise;
        expect(closeResponse.statusCode).toBe(200);
        expect(closeResponse.json()).toEqual({ closed: true });
        await client.close();
    });

    it("streams events, replays reconnects, and bridges extension UI over websockets", async () => {
        const fixture = await startAppFixture();
        const { id, fake } = await createSession(fixture);
        const url = `${fixture.wsBaseUrl}/ws/sessions/${id}`;
        const client = await connectWebSocket(url, { cookie: fixture.cookie });

        const snapshot = await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "snapshot" }> => message.type === "snapshot",
        );
        expect(snapshot).toMatchObject({ sessionId: id, seq: 0 });
        expect(snapshot.state).toMatchObject({ sessionId: id, cwd: realpathSync(fixture.projectDir) });
        expect(snapshot.entries[0]).toMatchObject({ type: "session", id });

        client.send({ type: "get_state", id: "state" });
        const state = await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "response" }> =>
                message.type === "response" && message.id === "state",
        );
        expect(state).toMatchObject({ command: "get_state", success: true });

        client.send({ type: "set_session_name", id: "name", name: "WS Session" });
        await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "response" }> =>
                message.type === "response" && message.id === "name",
        );
        expect(fake.getName()).toBe("WS Session");

        client.send({ type: "prompt", id: "prompt", message: "hello" });
        const promptResponse = await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "response" }> =>
                message.type === "response" && message.id === "prompt",
        );
        expect(promptResponse).toMatchObject({ command: "prompt", success: true, data: { disposition: "started" } });

        fake.emit(createTextDeltaEvent("Hel", "Hel"));
        const event = await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "event" }> => message.type === "event",
        );
        expect(event.sessionId).toBe(id);
        expect(event.seq).toBe(1);
        expect(JSON.stringify(event)).not.toContain('"partial"');
        expect(JSON.stringify(event)).not.toContain('"message"');

        client.sendRaw("{not json");
        const invalidJson = await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "error" }> => message.type === "error",
        );
        expect(invalidJson).toMatchObject({ code: "invalid_json" });

        client.send({ type: "unknown_command" });
        await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "error" }> =>
                message.type === "error" && message.code === "invalid_request",
        );

        client.send({ type: "prompt", id: "invalid-prompt" });
        await client.waitFor(
            (message): message is Extract<WsServerMessage, { type: "error" }> =>
                message.type === "error" && message.id === "invalid-prompt",
        );

        const lastSeq = event.seq;
        await client.close();
        fake.emit(createTextDeltaEvent("lo", "Hello"));

        const replayClient = await connectWebSocket(`${url}?afterSeq=${lastSeq}`, fixture.authHeaders);
        const replay = await replayClient.waitFor(
            (message): message is Extract<WsServerMessage, { type: "replay" }> => message.type === "replay",
        );
        expect(replay.seq).toBe(lastSeq + 1);
        expect(replay.events).toHaveLength(1);
        expect(replay.events[0]).toMatchObject({ seq: lastSeq + 1, event: { type: "message_update" } });

        const staleClient = await connectWebSocket(`${url}?afterSeq=99999`, fixture.authHeaders);
        const staleSnapshot = await staleClient.waitFor(
            (message): message is Extract<WsServerMessage, { type: "snapshot" }> => message.type === "snapshot",
        );
        expect(staleSnapshot.seq).toBe(replay.seq);

        const secondClient = await connectWebSocket(url, fixture.authHeaders);
        await secondClient.waitFor(
            (message): message is Extract<WsServerMessage, { type: "snapshot" }> => message.type === "snapshot",
        );

        const bindings = fake.bindings;
        if (bindings === undefined) {
            throw new Error("expected extension bindings");
        }
        const confirmed = bindings.uiContext.confirm("Allow command?", "Run a dangerous tool?");
        const uiRequest = await replayClient.waitFor(
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "confirm",
        );
        await secondClient.waitFor(
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.id === uiRequest.request.id,
        );
        secondClient.send({ type: "extension_ui_response", id: uiRequest.request.id, confirmed: true });
        await expect(confirmed).resolves.toBe(true);
        await replayClient.waitFor(
            (message): message is Extract<WsServerMessage, { type: "extension_ui_resolved" }> =>
                message.type === "extension_ui_resolved" && message.requestId === uiRequest.request.id,
        );

        await fixture.app.close();
        expect(fixture.registry.activeSessionCount).toBe(0);
        expect(fixture.harness.runtimes.every((runtime) => runtime.disposeCalls === 1)).toBe(true);
        await replayClient.close();
        await staleClient.close();
        await secondClient.close();
    });
});
