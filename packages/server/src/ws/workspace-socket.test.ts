import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    parseWorkspaceWsServerMessage,
    type CreateSessionResponse,
    type SessionId,
    type WorkspaceWsServerMessage,
} from "@pivia/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { SessionCatalog } from "../sessions/catalog.ts";
import { SessionRegistry } from "../sessions/runtime.ts";
import { createFakeRuntimeHarness, writeSessionFixture } from "../testing/fake-runtime.ts";

interface WorkspaceWsTestClient {
    readonly messages: WorkspaceWsServerMessage[];
    waitFor<T extends WorkspaceWsServerMessage>(
        predicate: (message: WorkspaceWsServerMessage) => message is T,
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

async function waitForWorkspaceMessage<T extends WorkspaceWsServerMessage>(
    messages: readonly WorkspaceWsServerMessage[],
    predicate: (message: WorkspaceWsServerMessage) => message is T,
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
    throw new Error(`Timed out waiting for workspace websocket message. Received: ${JSON.stringify(messages)}`);
}

async function connectWorkspaceWebSocket(url: string, headers: Record<string, string>): Promise<WorkspaceWsTestClient> {
    const socket = new WebSocket(url, { headers });
    const messages: WorkspaceWsServerMessage[] = [];
    socket.on("message", (data) => {
        const parsed = parseWorkspaceWsServerMessage(JSON.parse(rawDataToString(data)));
        if (parsed === null) {
            throw new Error("Received malformed workspace websocket frame");
        }
        messages.push(parsed);
    });
    await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", (error) => reject(error));
    });
    socket.on("error", () => {});

    return {
        messages,
        waitFor: (predicate, timeoutMs = 2000) => waitForWorkspaceMessage(messages, predicate, timeoutMs),
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

function upgradeStatus(
    url: URL,
    headers: Record<string, string>,
): Promise<{ statusCode: number; connection?: string }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest({
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: "GET",
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
            response.once("end", () => resolve(connection === undefined ? { statusCode } : { statusCode, connection }));
            response.once("error", reject);
            response.resume();
        });
        request.on("upgrade", () => resolve({ statusCode: 101 }));
        request.on("error", reject);
        request.end();
    });
}

describe("workspace websocket route", () => {
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

    async function startFixture(options: { readonly wsHeartbeatIntervalMs?: number } = {}) {
        const root = mkdtempSync(join(tmpdir(), "pivia-ws-workspace-"));
        tempDirs.push(root);
        const projectDir = join(root, "project");
        mkdirSync(projectDir, { recursive: true });
        const sessionDir = join(root, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        writeSessionFixture(join(sessionDir, "existing.jsonl"), "session-existing", {
            name: "Existing Session",
        });

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
        const app = buildApp({
            logger,
            auth: { password: "secret" },
            sessions: catalog,
            registry,
            ...(options.wsHeartbeatIntervalMs === undefined
                ? {}
                : { wsHeartbeatIntervalMs: options.wsHeartbeatIntervalMs }),
        });
        apps.push(app);
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        const url = new URL(address);
        return {
            app,
            catalog,
            registry,
            projectDir,
            wsUrl: `ws://${url.host}/ws/workspace`,
            authHeaders: { authorization: "Bearer secret" },
        };
    }

    it("rejects unauthenticated upgrades and streams SyncFrame snapshots, deltas, and Tier 1 replay", async () => {
        const fixture = await startFixture();

        expect(await upgradeStatus(new URL(fixture.wsUrl), {})).toEqual({
            statusCode: 401,
            connection: "close",
        });

        const client = await connectWorkspaceWebSocket(fixture.wsUrl, fixture.authHeaders);
        const snapshot = await client.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );
        expect(snapshot.snapshot.sessions).toHaveLength(1);
        expect(snapshot.snapshot.sessions[0]).toMatchObject({
            id: "session-existing",
            name: "Existing Session",
            runtimeState: "idle",
        });
        expect(Number.isFinite(snapshot.snapshot.updatedAtMs)).toBe(true);
        expect(snapshot.cursor.epoch.length).toBeGreaterThan(0);
        expect(snapshot.cursor.seq).toBe(0);

        const createdRes = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: fixture.projectDir },
        });
        expect(createdRes.statusCode).toBe(201);
        const createdId: SessionId = createdRes.json<CreateSessionResponse>().session.id;

        const upserted = await client.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.delta.op === "upsert" && message.delta.item.id === createdId,
        );
        expect(upserted.cursor.epoch).toBe(snapshot.cursor.epoch);
        expect(upserted.cursor.seq).toBeGreaterThan(snapshot.cursor.seq);

        const updatedIdle = await client.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.op === "patch" &&
                message.delta.id === createdId &&
                message.delta.patch.runtimeState === "idle",
        );
        expect(updatedIdle.cursor.epoch).toBe(snapshot.cursor.epoch);
        expect(updatedIdle.cursor.seq).toBeGreaterThan(upserted.cursor.seq);

        // Reconnect with epoch + afterSeq receives Tier 1 sync:replay without rescanning disk.
        const listSpy = vi.spyOn(fixture.catalog, "list");
        await client.close();

        const closeRes = await fixture.app.inject({
            method: "POST",
            url: `/api/sessions/${createdId}/close`,
            headers: fixture.authHeaders,
        });
        expect(closeRes.statusCode).toBe(200);
        expect(closeRes.json()).toEqual({ closed: true });

        const replayedClient = await connectWorkspaceWebSocket(
            `${fixture.wsUrl}?epoch=${encodeURIComponent(snapshot.cursor.epoch)}&afterSeq=${updatedIdle.cursor.seq}`,
            fixture.authHeaders,
        );
        const replay = await replayedClient.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:replay" }> =>
                message.type === "sync:replay",
        );
        expect(listSpy).not.toHaveBeenCalled();
        expect(replay.fromSeq).toBe(updatedIdle.cursor.seq);
        expect(replay.deltas.some((item) => item.payload.op === "remove" && item.payload.id === createdId)).toBe(true);
        listSpy.mockRestore();

        await replayedClient.close();
    });

    it("skips buffered events already covered by the snapshot and replays newer events after it", async () => {
        const fixture = await startFixture();
        const listStarted = Promise.withResolvers<void>();
        const releaseList = Promise.withResolvers<void>();
        const originalCatalogList = fixture.catalog.list.bind(fixture.catalog);
        fixture.catalog.list = async () => {
            const result = await originalCatalogList();
            listStarted.resolve();
            await releaseList.promise;
            return result;
        };

        const originalRegistryList = fixture.registry.list.bind(fixture.registry);
        let postSnapshotAttachment: { detach(): void } | undefined;
        let capturedId: SessionId | null = null;
        const origAttachCatalog = fixture.registry.attachCatalog.bind(fixture.registry);
        let snapshotIntercepted = false;
        fixture.registry.attachCatalog = (transport, handshake) => {
            return origAttachCatalog(
                {
                    sendRaw(raw) {
                        transport.sendRaw(raw);
                        if (!snapshotIntercepted && raw.includes('"type":"sync:snapshot"') && capturedId !== null) {
                            snapshotIntercepted = true;
                            postSnapshotAttachment = fixture.registry.attach(capturedId, { send: () => {} });
                        }
                    },
                    close(code, reason) {
                        transport.close(code, reason);
                    },
                },
                handshake,
            );
        };
        void originalRegistryList;

        const client = await connectWorkspaceWebSocket(fixture.wsUrl, fixture.authHeaders);
        await listStarted.promise;

        const createdRes = await fixture.app.inject({
            method: "POST",
            url: "/api/sessions",
            headers: fixture.authHeaders,
            payload: { cwd: fixture.projectDir },
        });
        expect(createdRes.statusCode).toBe(201);
        const createdId: SessionId = createdRes.json<CreateSessionResponse>().session.id;
        capturedId = createdId;
        releaseList.resolve();

        const snapshot = await client.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );
        expect(snapshot.snapshot.sessions.some((session) => session.id === createdId)).toBe(true);
        const snapshotIndex = client.messages.indexOf(snapshot);

        const postAttachUpdate = await client.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.op === "patch" &&
                message.delta.id === createdId &&
                message.delta.patch.attachedClients === 1,
        );
        expect(client.messages.indexOf(postAttachUpdate)).toBeGreaterThan(snapshotIndex);
        expect(postAttachUpdate.cursor.seq).toBeGreaterThan(snapshot.cursor.seq);

        const staleEvents = client.messages.filter(
            (message) => message.type === "sync:delta" && message.cursor.seq <= snapshot.cursor.seq,
        );
        expect(staleEvents).toEqual([]);

        postSnapshotAttachment?.detach();
        await client.close();
    });

    it("serializes each incremental catalog delta once across connected clients", async () => {
        const fixture = await startFixture();

        const clientA = await connectWorkspaceWebSocket(fixture.wsUrl, fixture.authHeaders);
        await clientA.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );
        const clientB = await connectWorkspaceWebSocket(fixture.wsUrl, fixture.authHeaders);
        await clientB.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );

        const handle = await fixture.registry.createSession(fixture.projectDir);
        await clientA.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.op === "patch" &&
                message.delta.id === handle.sessionId &&
                message.delta.patch.runtimeState === "idle",
        );
        await clientB.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.op === "patch" &&
                message.delta.id === handle.sessionId &&
                message.delta.patch.runtimeState === "idle",
        );

        const stringifySpy = vi.spyOn(JSON, "stringify");
        const attachment = fixture.registry.attach(handle.sessionId, { send: () => {} });
        await clientA.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.op === "patch" &&
                message.delta.id === handle.sessionId &&
                message.delta.patch.attachedClients === 1,
        );
        await clientB.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.op === "patch" &&
                message.delta.id === handle.sessionId &&
                message.delta.patch.attachedClients === 1,
        );
        const patchStringifyCalls = stringifySpy.mock.results.filter(
            (result) =>
                result.type === "return" &&
                typeof result.value === "string" &&
                result.value.includes('"type":"sync:delta"') &&
                result.value.includes('"attachedClients":1'),
        );
        expect(patchStringifyCalls).toHaveLength(1);
        stringifySpy.mockRestore();

        attachment.detach();
        await clientA.close();
        await clientB.close();
    });

    it("closes the workspace socket when the catalog scan fails", async () => {
        const fixture = await startFixture();
        fixture.catalog.list = () => Promise.reject(new Error("catalog scan failed"));

        const socket = new WebSocket(fixture.wsUrl, { headers: fixture.authHeaders });
        socket.on("error", () => {});
        const closed = new Promise<number>((resolve) => {
            socket.once("close", (code) => resolve(code));
        });
        await new Promise<void>((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
        });
        socket.on("error", () => {});

        await expect(closed).resolves.toBe(1011);
    });

    it("terminates a workspace socket that stops answering heartbeat pings", async () => {
        const fixture = await startFixture({ wsHeartbeatIntervalMs: 40 });
        const client = await connectWorkspaceWebSocket(fixture.wsUrl, fixture.authHeaders);
        await client.waitFor(
            (message): message is Extract<WorkspaceWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );

        const silent = new WebSocket(fixture.wsUrl, { headers: fixture.authHeaders, autoPong: false });
        await new Promise<void>((resolve, reject) => {
            silent.once("open", () => resolve());
            silent.once("error", reject);
        });
        const silentClosed = new Promise<number>((resolve) => {
            silent.once("close", (code) => resolve(code));
        });
        await expect(silentClosed).resolves.toBe(1006);

        await client.close();
    });
});
