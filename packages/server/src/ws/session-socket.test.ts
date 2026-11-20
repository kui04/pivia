import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreateSessionResponse, WsClientCommand, WsServerMessage } from "@pivia/protocol";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { SessionCatalog } from "../sessions/catalog.ts";
import { SessionRegistry } from "../sessions/runtime.ts";
import {
    createFakeRuntimeHarness,
    createTextDeltaEvent,
    type FakeRuntimeHarness,
    type FakeSession,
} from "../testing/fake-runtime.ts";

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

interface WsAppFixture {
    readonly app: ReturnType<typeof buildApp>;
    readonly registry: SessionRegistry;
    readonly harness: FakeRuntimeHarness;
    readonly root: string;
    readonly projectDir: string;
    readonly wsBaseUrl: string;
    readonly cookie: string;
    readonly authHeaders: { readonly authorization: string };
}

describe("session websocket route", () => {
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

    async function startAppFixture(options: AppFixtureOptions = {}): Promise<WsAppFixture> {
        const root = mkdtempSync(join(tmpdir(), "pivia-ws-runtime-"));
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
            wsBaseUrl: `ws://${url.host}`,
            cookie,
            authHeaders: { authorization: "Bearer secret" },
        };
    }

    async function createSession(fixture: WsAppFixture): Promise<{ readonly id: string; readonly fake: FakeSession }> {
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
        if (snapshot.entriesMode !== "inline") {
            throw new Error("expected inline snapshot entries");
        }
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

        const replayClient = await connectWebSocket(
            `${url}?afterSeq=${lastSeq}&runtimeId=${encodeURIComponent(snapshot.runtimeId)}`,
            fixture.authHeaders,
        );
        const replay = await replayClient.waitFor(
            (message): message is Extract<WsServerMessage, { type: "replay" }> => message.type === "replay",
        );
        expect(replay.seq).toBe(lastSeq + 1);
        expect(replay.events).toHaveLength(1);
        expect(replay.events[0]).toMatchObject({ seq: lastSeq + 1, event: { type: "message_update" } });

        const mismatchedRuntimeClient = await connectWebSocket(
            `${url}?afterSeq=${lastSeq}&runtimeId=stale-runtime`,
            fixture.authHeaders,
        );
        const mismatchedSnapshot = await mismatchedRuntimeClient.waitFor(
            (message): message is Extract<WsServerMessage, { type: "snapshot" }> => message.type === "snapshot",
        );
        expect(mismatchedSnapshot.runtimeId).toBe(snapshot.runtimeId);
        await mismatchedRuntimeClient.close();

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
