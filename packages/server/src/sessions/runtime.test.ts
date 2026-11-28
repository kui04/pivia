import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSessionEvent, RpcExtensionUIResponse, SessionManager } from "@earendil-works/pi-coding-agent";

import {
    EMPTY_SESSION_UI_STATE,
    parseSessionId,
    parseSyncSeq,
    type SessionDelta,
    type SessionId,
    type SessionRpcCommand,
    type SessionRpcServerMessage,
    type SessionWsServerMessage,
    type SyncSeq,
    type WorkspaceWsServerMessage,
} from "@pivia/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../logger.ts";
import { createPiRuntimeFactory } from "./pi-runtime.ts";
import {
    type ActiveSessionHandle,
    SessionRegistry,
    SessionRegistryError,
    type SessionAttachOptions,
    type SessionAttachment,
    type SessionClient,
    type SessionRegistryLogger,
} from "./runtime.ts";
import { SessionCatalog } from "./catalog.ts";
import {
    createFakeRuntimeHarness,
    createRecordingLogger,
    createTextDeltaEvent,
    type FakeRuntimeHarness,
    type FakeSession,
    writeSessionFixture,
} from "../testing/fake-runtime.ts";

const tempDirs: string[] = [];
const registries: SessionRegistry[] = [];

afterEach(async () => {
    let registry = registries.pop();
    while (registry !== undefined) {
        await registry.disposeAll();
        registry = registries.pop();
    }
    let dir = tempDirs.pop();
    while (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        dir = tempDirs.pop();
    }
});

interface Collector {
    readonly client: SessionClient;
    readonly messages: SessionWsServerMessage[];
    readonly closes: Array<{ readonly code: number; readonly reason: string }>;
}

interface Fixture {
    readonly root: string;
    readonly agentDir: string;
    readonly projectDir: string;
    readonly sessionDir: string;
    readonly catalog: SessionCatalog;
    readonly registry: SessionRegistry;
    readonly harness: FakeRuntimeHarness;
}

interface FixtureOptions {
    readonly idleTimeoutMs?: number;
    readonly shutdownUiTimeoutMs?: number;
    readonly pendingUiTimeoutMs?: number | null;
    readonly delayMs?: number;
    readonly logger?: SessionRegistryLogger;
    readonly nowMs?: (() => number) | undefined;
    readonly onCreate?: ((session: FakeSession) => void) | undefined;
    readonly maxSessionFileBytes?: number | undefined;
}

function createFixture(options: FixtureOptions = {}): Fixture {
    const root = mkdtempSync(join(tmpdir(), "pivia-runtime-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    const sessionDir = join(root, "sessions");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    const logger = createLogger({ level: "silent" });
    const catalog = new SessionCatalog({
        sessionDir,
        agentDir,
        cwd: root,
        env: {},
        logger,
        maxSessionFileBytes: options.maxSessionFileBytes,
    });
    const harness = createFakeRuntimeHarness({ delayMs: options.delayMs, onCreate: options.onCreate });
    const registry = new SessionRegistry({
        catalog,
        logger: options.logger ?? logger,
        agentDir,
        runtimeFactory: harness.factory,
        idleTimeoutMs: options.idleTimeoutMs ?? 0,
        shutdownUiTimeoutMs: options.shutdownUiTimeoutMs,
        pendingUiTimeoutMs: options.pendingUiTimeoutMs,
        nowMs: options.nowMs,
        diskSync: { enabled: false },
    });
    registries.push(registry);
    return { root, agentDir, projectDir, sessionDir, catalog, registry, harness };
}

function createCollector(): Collector {
    const messages: SessionWsServerMessage[] = [];
    const closes: Array<{ readonly code: number; readonly reason: string }> = [];
    return {
        messages,
        closes,
        client: {
            send(message) {
                messages.push(message);
            },
            close(code, reason) {
                closes.push({ code, reason });
            },
        },
    };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("Timed out waiting for condition");
}

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

async function waitForRuntimeState(
    registry: SessionRegistry,
    sessionId: SessionId,
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

async function waitForMessage<T extends SessionWsServerMessage>(
    messages: readonly SessionWsServerMessage[],
    predicate: (message: SessionWsServerMessage) => message is T,
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
    throw new Error(`Timed out waiting for message. Received: ${JSON.stringify(messages)}`);
}

function responseFor(
    messages: readonly SessionWsServerMessage[],
    id: string,
): Promise<Extract<SessionRpcServerMessage, { type: "rpc:response" }>> {
    return waitForMessage(
        messages,
        (message): message is Extract<SessionRpcServerMessage, { type: "rpc:response" }> => {
            return message.type === "rpc:response" && message.id === id;
        },
    );
}

async function successResponseFor(
    messages: readonly SessionWsServerMessage[],
    id: string,
): Promise<Extract<SessionRpcServerMessage, { type: "rpc:response"; success: true }>> {
    const response = await responseFor(messages, id);
    expect(response.success).toBe(true);
    if (!response.success) {
        throw new Error(`Expected successful response for ${id}, got: ${response.error}`);
    }
    return response;
}

function sendCommand(attachment: SessionAttachment, command: SessionRpcCommand): Promise<void> {
    return attachment.handleMessage({ type: "rpc:command", command });
}

function sendUiResponse(attachment: SessionAttachment, response: RpcExtensionUIResponse): Promise<void> {
    return attachment.handleMessage({
        type: "rpc:ui_response",
        response,
    });
}

function sessionSeq(raw: number): SyncSeq<"session"> {
    const parsed = parseSyncSeq<"session">(raw);
    if (parsed === null) {
        throw new Error(`Invalid session seq: ${raw}`);
    }
    return parsed;
}

function attachCatalogCollector(registry: SessionRegistry) {
    const frames: WorkspaceWsServerMessage[] = [];
    const snapshotReady = Promise.withResolvers<void>();
    const detach = registry.attachCatalog({
        sendRaw(raw) {
            const frame = JSON.parse(raw) as WorkspaceWsServerMessage;
            frames.push(frame);
            if (frame.type === "sync:snapshot") {
                snapshotReady.resolve();
            }
        },
        close() {},
    });
    return { frames, ready: snapshotReady.promise, detach };
}

function findSessionFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findSessionFiles(path));
        } else if (entry.name.endsWith(".jsonl")) {
            results.push(path);
        }
    }
    return results;
}

function attach(
    registry: SessionRegistry,
    sessionId: SessionId,
    options?: SessionAttachOptions,
): { collector: Collector; attachment: SessionAttachment } {
    const collector = createCollector();
    const attachment = registry.attach(sessionId, collector.client, options);
    return { collector, attachment };
}

function fakeSession(fixture: Fixture, handle: ActiveSessionHandle): FakeSession {
    const runtime = fixture.harness.find(handle.sessionId);
    if (runtime === undefined) {
        throw new Error(`expected a fake runtime for ${handle.sessionId}`);
    }
    return runtime.session;
}

describe("SessionRegistry", () => {
    it("shares one runtime for concurrent opens of the same session", async () => {
        const fixture = createFixture({ delayMs: 10 });
        writeSessionFixture(join(fixture.sessionDir, "alpha.jsonl"), "session-alpha", {
            messages: [{ role: "user", text: "alpha question" }],
        });

        const [first, second] = await Promise.all([
            fixture.registry.open(sid("session-alpha")),
            fixture.registry.open(sid("session-alpha")),
        ]);

        expect(fixture.harness.runtimes).toHaveLength(1);
        expect(first.session).toBe(second.session);
        expect(first.sessionId).toBe("session-alpha");
        expect(fixture.registry.activeSessionCount).toBe(1);
    });

    it("returns a not-found error for unknown session ids", async () => {
        const fixture = createFixture();

        await expect(fixture.registry.open(sid("session-missing"))).rejects.toMatchObject({
            name: "SessionRegistryError",
            code: "not_found",
        });
        expect(fixture.harness.runtimes).toHaveLength(0);
    });

    it("returns a starting session that can answer session_start dialogs", async () => {
        let startupDialog: Promise<string | undefined> | undefined;
        let signalBindStarted: (() => void) | undefined;
        const bindStarted = new Promise<void>((resolve) => {
            signalBindStarted = resolve;
        });
        const fixture = createFixture({
            onCreate: (session) => {
                session.bindExtensionsHandler = async (bindings) => {
                    session.bindings = bindings;
                    signalBindStarted?.();
                    startupDialog = bindings.uiContext.select("Choose mode", ["safe", "danger"]);
                    await startupDialog;
                };
            },
        });

        const handle = await fixture.registry.createSession(fixture.projectDir);
        await bindStarted;
        expect((await fixture.registry.getById(handle.sessionId))?.session.runtimeState).toBe("starting");
        expect((await fixture.registry.open(handle.sessionId)).session).toBe(handle.session);

        const collector = createCollector();
        const attachment = fixture.registry.attach(handle.sessionId, collector.client);
        const snapshot = collector.messages[0];
        if (snapshot?.type !== "sync:snapshot") {
            throw new Error("expected a snapshot");
        }
        const request = snapshot.snapshot.pendingUiRequests[0];
        if (request === undefined) {
            throw new Error("expected the startup dialog in the snapshot");
        }
        expect(request.method).toBe("select");

        await sendUiResponse(attachment, { type: "extension_ui_response", id: request.id, value: "safe" });
        if (startupDialog === undefined) {
            throw new Error("expected the startup dialog");
        }
        await expect(startupDialog).resolves.toBe("safe");
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        attachment.detach();
    });

    it("removes a runtime when extension bindings fail", async () => {
        let rejectBind: ((error: Error) => void) | undefined;
        const fixture = createFixture({
            onCreate: (session) => {
                session.bindExtensionsHandler = () =>
                    new Promise<void>((_resolve, reject) => {
                        rejectBind = reject;
                    });
            },
        });

        const handle = await fixture.registry.createSession(fixture.projectDir);
        const collector = createCollector();
        const attachment = fixture.registry.attach(handle.sessionId, collector.client);
        await waitUntil(() => rejectBind !== undefined);
        rejectBind?.(new Error("bind failed"));

        await waitUntil(() => fixture.registry.activeSessionCount === 0);
        expect(fixture.harness.runtimes).toHaveLength(1);
        expect(fixture.harness.runtimes[0]?.disposeCalls).toBe(1);
        expect(collector.closes).toEqual([{ code: 1011, reason: "Session failed to initialize" }]);
        attachment.detach();
    });

    it("applies a shutdown request raised while bindings load", async () => {
        const fixture = createFixture({
            onCreate: (session) => {
                session.bindExtensionsHandler = (bindings) => {
                    session.bindings = bindings;
                    bindings.shutdownHandler();
                    return Promise.resolve();
                };
            },
        });

        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitUntil(() => fixture.registry.activeSessionCount === 0);
        expect(fixture.harness.find(handle.sessionId)?.disposeCalls).toBe(1);
    });

    it("allows an attached client to answer a session_shutdown dialog", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const runtime = fixture.harness.find(handle.sessionId);
        if (runtime === undefined) {
            throw new Error("expected the fake runtime");
        }
        let shutdownDialog: Promise<boolean> | undefined;
        runtime.disposeHandler = async (session) => {
            if (session.bindings === undefined) {
                throw new Error("expected extension bindings");
            }
            shutdownDialog = session.bindings.uiContext.confirm("Save before closing?", "Unsaved changes.");
            await shutdownDialog;
        };

        const closePromise = fixture.registry.closeSession(handle.sessionId);
        const request = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "confirm",
        );
        if (request.delta.kind !== "ui_request") {
            throw new Error("expected ui_request delta");
        }
        expect((await fixture.registry.getById(handle.sessionId))?.session.runtimeState).toBe("closing");
        expect(() => fixture.registry.attach(handle.sessionId, createCollector().client)).toThrow(SessionRegistryError);

        await sendCommand(attachment, { type: "get_state", id: "closing-state" });
        const closingResponse = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "rpc:response" }> =>
                message.type === "rpc:response" && message.id === "closing-state",
        );
        expect(closingResponse).toMatchObject({ success: false, error: "Session is closing." });

        await sendUiResponse(attachment, {
            type: "extension_ui_response",
            id: request.delta.request.id,
            confirmed: true,
        });
        if (shutdownDialog === undefined) {
            throw new Error("expected the shutdown dialog");
        }
        await expect(shutdownDialog).resolves.toBe(true);
        await expect(closePromise).resolves.toBe(true);
        expect(fixture.registry.activeSessionCount).toBe(0);
        expect(collector.closes).toEqual([{ code: 4400, reason: "Session closed" }]);
    });

    it("times out a session_shutdown dialog when the client does not answer", async () => {
        const fixture = createFixture({ shutdownUiTimeoutMs: 20 });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { attachment } = attach(fixture.registry, handle.sessionId);
        const runtime = fixture.harness.find(handle.sessionId);
        if (runtime === undefined) {
            throw new Error("expected the fake runtime");
        }
        runtime.disposeHandler = async (session) => {
            if (session.bindings === undefined) {
                throw new Error("expected extension bindings");
            }
            await session.bindings.uiContext.confirm("Save?", "No answer expected.");
        };

        await expect(fixture.registry.closeSession(handle.sessionId)).resolves.toBe(true);
        expect(fixture.registry.activeSessionCount).toBe(0);
        attachment.detach();
    });

    it("disposes session_shutdown dialogs immediately when no client is attached", async () => {
        const fixture = createFixture({ shutdownUiTimeoutMs: 5_000 });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const runtime = fixture.harness.find(handle.sessionId);
        if (runtime === undefined) {
            throw new Error("expected the fake runtime");
        }
        runtime.disposeHandler = async (session) => {
            if (session.bindings === undefined) {
                throw new Error("expected extension bindings");
            }
            await session.bindings.uiContext.confirm("Save?", "No client can answer.");
        };

        const started = Date.now();
        await expect(fixture.registry.closeSession(handle.sessionId)).resolves.toBe(true);
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("force-disposes session_shutdown dialogs during disposeAll", async () => {
        const fixture = createFixture({ shutdownUiTimeoutMs: 5_000 });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector } = attach(fixture.registry, handle.sessionId);
        const runtime = fixture.harness.find(handle.sessionId);
        if (runtime === undefined) {
            throw new Error("expected the fake runtime");
        }
        runtime.disposeHandler = async (session) => {
            if (session.bindings === undefined) {
                throw new Error("expected extension bindings");
            }
            await session.bindings.uiContext.confirm("Save?", "Force close should cancel this.");
        };

        await expect(fixture.registry.disposeAll()).resolves.toBeUndefined();
        expect(fixture.registry.activeSessionCount).toBe(0);
        expect(collector.closes.some((close) => close.code === 1001)).toBe(true);
        expect(collector.closes.find((close) => close.code === 1001)?.reason).toBe("Server going away");
    });

    it("disposes a shutdown dialog when the last client detaches during closing", async () => {
        const fixture = createFixture({ shutdownUiTimeoutMs: 5_000 });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const runtime = fixture.harness.find(handle.sessionId);
        if (runtime === undefined) {
            throw new Error("expected the fake runtime");
        }
        runtime.disposeHandler = async (session) => {
            if (session.bindings === undefined) {
                throw new Error("expected extension bindings");
            }
            await session.bindings.uiContext.confirm("Save?", "The client leaves.");
        };

        const closePromise = fixture.registry.closeSession(handle.sessionId);
        await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "confirm",
        );
        attachment.detach();
        await expect(closePromise).resolves.toBe(true);
        expect(fixture.registry.activeSessionCount).toBe(0);
    });

    it("waits for a closing runtime before reopening the same session", async () => {
        const fixture = createFixture();
        writeSessionFixture(join(fixture.sessionDir, "alpha.jsonl"), "session-alpha");
        const first = await fixture.registry.open(sid("session-alpha"));
        await waitForRuntimeState(fixture.registry, sid("session-alpha"), "idle");
        expect(first.sessionId).toBe("session-alpha");

        const runtime = fixture.harness.find("session-alpha");
        if (runtime === undefined) {
            throw new Error("expected the first fake runtime");
        }
        let releaseDispose: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releaseDispose = resolve;
        });
        runtime.disposeHandler = () => gate;

        const closePromise = fixture.registry.closeSession(sid("session-alpha"));
        const openPromise = fixture.registry.open(sid("session-alpha"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fixture.harness.runtimes).toHaveLength(1);

        releaseDispose?.();
        await expect(closePromise).resolves.toBe(true);
        const reopened = await openPromise;
        expect(reopened.sessionId).toBe("session-alpha");
        expect(fixture.harness.runtimes).toHaveLength(2);
    });

    it("keeps a session alive while a pending dialog has no clients", async () => {
        const fixture = createFixture({ idleTimeoutMs: 30, pendingUiTimeoutMs: null });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const bindings = fakeSession(fixture, handle).bindings;
        if (bindings === undefined) {
            throw new Error("expected extension bindings");
        }

        const dialog = bindings.uiContext.select("Still there?", ["yes", "no"]);
        const request = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "select",
        );
        if (request.delta.kind !== "ui_request") {
            throw new Error("expected ui_request");
        }
        attachment.detach();
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(fixture.registry.activeSessionCount).toBe(1);

        const late = attach(fixture.registry, handle.sessionId);
        const snapshot = late.collector.messages[0];
        if (snapshot?.type !== "sync:snapshot") {
            throw new Error("expected a snapshot");
        }
        expect(snapshot.snapshot.pendingUiRequests.map((pending) => pending.id)).toContain(request.delta.request.id);
        await sendUiResponse(late.attachment, {
            type: "extension_ui_response",
            id: request.delta.request.id,
            value: "yes",
        });
        await expect(dialog).resolves.toBe("yes");
        late.attachment.detach();
        await waitUntil(() => fixture.registry.activeSessionCount === 0);
    });

    it("reclaims a session after pendingUiTimeoutMs expires", async () => {
        const fixture = createFixture({ idleTimeoutMs: 20, pendingUiTimeoutMs: 40 });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const bindings = fakeSession(fixture, handle).bindings;
        if (bindings === undefined) {
            throw new Error("expected extension bindings");
        }

        const dialog = bindings.uiContext.select("Timeout?", ["yes", "no"]);
        await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "select",
        );
        attachment.detach();
        await waitUntil(() => fixture.registry.activeSessionCount === 0);
        await expect(dialog).resolves.toBeUndefined();
    });

    it("reclaims a streaming session after a finite pendingUiTimeoutMs expires", async () => {
        const fixture = createFixture({ idleTimeoutMs: 1_000, pendingUiTimeoutMs: 40 });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const session = fakeSession(fixture, handle);
        session.setState({ isStreaming: true });
        const bindings = session.bindings;
        if (bindings === undefined) {
            throw new Error("expected extension bindings");
        }

        const dialog = bindings.uiContext.confirm("Tool confirmation", "Proceed while streaming?");
        await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "confirm",
        );
        attachment.detach();
        await waitUntil(() => fixture.registry.activeSessionCount === 0);
        await expect(dialog).resolves.toBe(false);
    });

    it("cancels a startup dialog but keeps the client for session_shutdown", async () => {
        let startupDialog: Promise<string | undefined> | undefined;
        const fixture = createFixture({
            shutdownUiTimeoutMs: 1_000,
            onCreate: (session) => {
                session.bindExtensionsHandler = async (bindings) => {
                    session.bindings = bindings;
                    startupDialog = bindings.uiContext.select("Start?", ["yes", "no"]);
                    await startupDialog;
                };
            },
        });

        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitUntil(() => startupDialog !== undefined);
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const snapshot = collector.messages[0];
        if (snapshot?.type !== "sync:snapshot") {
            throw new Error("expected a snapshot");
        }
        const startupRequest = snapshot.snapshot.pendingUiRequests[0];
        if (startupRequest === undefined) {
            throw new Error("expected the startup dialog in the snapshot");
        }
        const runtime = fixture.harness.find(handle.sessionId);
        if (runtime === undefined) {
            throw new Error("expected the fake runtime");
        }
        let shutdownDialog: Promise<boolean> | undefined;
        runtime.disposeHandler = async (session) => {
            if (session.bindings === undefined) {
                throw new Error("expected extension bindings");
            }
            shutdownDialog = session.bindings.uiContext.confirm("Save?", "Closing after startup.");
            await shutdownDialog;
        };

        const closePromise = fixture.registry.closeSession(handle.sessionId);
        await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_resolved" &&
                message.delta.requestId === startupRequest.id,
        );
        if (startupDialog === undefined) {
            throw new Error("expected the startup dialog");
        }
        await expect(startupDialog).resolves.toBeUndefined();

        const shutdownRequest = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "confirm",
        );
        if (shutdownRequest.delta.kind !== "ui_request") {
            throw new Error("expected ui_request");
        }
        await sendUiResponse(attachment, {
            type: "extension_ui_response",
            id: shutdownRequest.delta.request.id,
            confirmed: true,
        });
        if (shutdownDialog === undefined) {
            throw new Error("expected the shutdown dialog");
        }
        await expect(shutdownDialog).resolves.toBe(true);
        await expect(closePromise).resolves.toBe(true);
        expect(fixture.registry.activeSessionCount).toBe(0);
    });

    it("closes a starting session by cancelling its startup dialog", async () => {
        let startupDialog: Promise<string | undefined> | undefined;
        const fixture = createFixture({
            onCreate: (session) => {
                session.bindExtensionsHandler = async (bindings) => {
                    session.bindings = bindings;
                    startupDialog = bindings.uiContext.select("Start?", ["yes", "no"]);
                    await startupDialog;
                };
            },
        });

        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitUntil(() => startupDialog !== undefined);
        await expect(fixture.registry.closeSession(handle.sessionId)).resolves.toBe(true);
        if (startupDialog === undefined) {
            throw new Error("expected the startup dialog");
        }
        await expect(startupDialog).resolves.toBeUndefined();
        expect(fixture.registry.activeSessionCount).toBe(0);
        expect(fixture.harness.find(handle.sessionId)?.disposeCalls).toBe(1);
    });

    it("waits for an in-flight session creation during disposeAll", async () => {
        const fixture = createFixture({ delayMs: 20 });
        const createPromise = fixture.registry.createSession(fixture.projectDir);
        await fixture.registry.disposeAll();
        await expect(createPromise).rejects.toThrow("Session registry is disposed.");
        expect(fixture.registry.activeSessionCount).toBe(0);
        expect(fixture.harness.runtimes).toHaveLength(1);
        expect(fixture.harness.runtimes[0]?.disposeCalls).toBe(1);
    });

    it("rejects new sessions for missing, non-directory, and relative cwd values", async () => {
        const fixture = createFixture();
        const missing = join(fixture.root, "missing");
        const filePath = join(fixture.root, "not-a-directory.txt");
        writeFileSync(filePath, "file", "utf8");

        const cases = [
            { cwd: missing, code: "directory_not_found" },
            { cwd: filePath, code: "invalid_request" },
            { cwd: "relative/project", code: "invalid_request" },
        ] as const;
        for (const testCase of cases) {
            await expect(fixture.registry.createSession(testCase.cwd)).rejects.toMatchObject({
                code: testCase.code,
            });
        }
        expect(fixture.registry.activeSessionCount).toBe(0);
        expect(fixture.harness.runtimes).toHaveLength(0);

        const createdMissing = await fixture.registry.createSession(missing, { createDirectory: true });
        expect(createdMissing.cwd).toBe(realpathSync(missing));
        expect(fixture.registry.activeSessionCount).toBe(1);
    });

    it("merges an unflushed new session into list and detail responses", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fakeSession(fixture, handle);
        const realProjectDir = realpathSync(fixture.projectDir);

        session.setState({ isStreaming: true, messageCount: 2 });
        const collector = createCollector();
        const attachment = fixture.registry.attach(handle.sessionId, collector.client);

        const list = await fixture.registry.list();
        const summary = list.sessions.find((session) => session.id === handle.sessionId);
        expect(summary).toMatchObject({
            id: handle.sessionId,
            cwd: realProjectDir,
            name: null,
            firstMessage: "(no messages)",
            messageCount: 2,
            runtimeState: "streaming",
            attachedClients: 1,
        });
        expect(list.sessions[0]?.id).toBe(handle.sessionId);

        const detail = await fixture.registry.getById(handle.sessionId);
        expect(detail?.session).toMatchObject({ id: handle.sessionId, attachedClients: 1 });
        expect(detail?.entries[0]).toMatchObject({ type: "session", id: handle.sessionId, cwd: realProjectDir });

        attachment.detach();
        expect(collector.messages[0]).toMatchObject({
            type: "sync:snapshot",
            cursor: { seq: 0 },
            snapshot: { state: { sessionId: handle.sessionId } },
        });
    });

    it("reports idle, streaming, and compacting runtime states", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fakeSession(fixture, handle);

        expect((await fixture.registry.getById(handle.sessionId))?.session.runtimeState).toBe("idle");
        session.setState({ isStreaming: true });
        expect((await fixture.registry.getById(handle.sessionId))?.session.runtimeState).toBe("streaming");
        session.setState({ isCompacting: true });
        expect((await fixture.registry.getById(handle.sessionId))?.session.runtimeState).toBe("compacting");
    });

    it("orders merged sessions by latest activity", async () => {
        let now = Date.parse("2026-07-01T00:00:00.000Z");
        const fixture = createFixture({ nowMs: () => now });
        writeSessionFixture(join(fixture.sessionDir, "old.jsonl"), "session-old", {
            timestamp: "2026-01-01T00:00:00.000Z",
        });
        writeSessionFixture(join(fixture.sessionDir, "new.jsonl"), "session-new", {
            timestamp: "2026-06-01T00:00:00.000Z",
        });

        await fixture.registry.open(sid("session-old"));
        expect((await fixture.registry.list()).sessions.map((session) => session.id)).toEqual([
            "session-old",
            "session-new",
        ]);

        now = Date.parse("2025-01-01T00:00:00.000Z");
        const created = await fixture.registry.createSession(fixture.projectDir);
        expect((await fixture.registry.list()).sessions.map((session) => session.id)).toEqual([
            "session-old",
            "session-new",
            created.sessionId,
        ]);
    });

    it("acknowledges prompt preflight immediately and reports preflight rejection as failure", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const session = fakeSession(fixture, handle);

        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        session.promptHandler = async (_text, options) => {
            options.preflightResult("started");
            await gate;
        };

        await sendCommand(attachment, { type: "prompt", id: "prompt-1", message: "hello" });
        const accepted = await responseFor(collector.messages, "prompt-1");
        expect(accepted).toMatchObject({
            type: "rpc:response",
            command: "prompt",
            success: true,
            data: { disposition: "started" },
        });
        expect(session.promptCalls).toHaveLength(1);

        release?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(collector.messages.filter((message) => message.type === "rpc:response")).toHaveLength(1);

        session.promptHandler = () => Promise.reject(new Error("Session is already streaming."));
        await sendCommand(attachment, { type: "prompt", id: "prompt-2", message: "again" });
        const rejected = await responseFor(collector.messages, "prompt-2");
        expect(rejected).toMatchObject({
            type: "rpc:response",
            command: "prompt",
            success: false,
            error: "Session is already streaming.",
        });
    });

    it("logs prompt errors that happen after preflight without sending a second response", async () => {
        const recording = createRecordingLogger();
        const fixture = createFixture({ logger: recording.logger });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const session = fakeSession(fixture, handle);

        session.promptHandler = (_text, options) => {
            options.preflightResult("queued");
            return Promise.reject(new Error("provider failed"));
        };

        await sendCommand(attachment, { type: "prompt", id: "prompt-late", message: "hello" });
        const accepted = await responseFor(collector.messages, "prompt-late");
        expect(accepted).toMatchObject({ success: true, data: { disposition: "queued" } });

        await waitUntil(() =>
            recording.warnings.some((warning) => warning.message === "prompt failed after it was accepted"),
        );
        expect(
            collector.messages.filter((message) => message.type === "rpc:response" && message.id === "prompt-late"),
        ).toHaveLength(1);
    });

    it("handles control commands and reports state from the managed session", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fakeSession(fixture, handle);
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        session.setState({
            steeringMessages: ["steer-a"],
            followUpMessages: ["follow-b"],
            messageCount: 4,
        });

        await sendCommand(attachment, { type: "get_state", id: "state" });
        expect((await successResponseFor(collector.messages, "state")).data).toMatchObject({
            sessionId: handle.sessionId,
            name: null,
            thinkingLevel: "medium",
            isStreaming: false,
            steeringMessages: ["steer-a"],
            followUpMessages: ["follow-b"],
            messageCount: 4,
        });

        await sendCommand(attachment, { type: "set_session_name", id: "name", name: "  Named Session  " });
        expect((await responseFor(collector.messages, "name")).success).toBe(true);
        expect(session.getName()).toBe("Named Session");

        await sendCommand(attachment, { type: "set_session_name", id: "empty-name", name: "   " });
        expect(await responseFor(collector.messages, "empty-name")).toMatchObject({
            success: false,
            error: "Session name cannot be empty.",
        });

        session.setModelHandler = (provider, modelId) => {
            session.setState({
                contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
                routedModel: null,
            });
            return {
                provider,
                id: modelId,
                name: `${provider}/${modelId}`,
                contextWindow: 200_000,
                reasoning: true,
            };
        };
        await sendCommand(attachment, { type: "set_model", id: "model", provider: "fake", modelId: "model-2" });
        expect((await successResponseFor(collector.messages, "model")).data).toEqual({
            provider: "fake",
            id: "model-2",
            name: "fake/model-2",
            contextWindow: 200_000,
            reasoning: true,
        });
        expect(
            collector.messages.some(
                (message) =>
                    message.type === "sync:delta" &&
                    message.delta.kind === "state_patched" &&
                    message.delta.patch.model?.id === "model-2" &&
                    message.delta.patch.contextUsage?.percent === 5,
            ),
        ).toBe(true);

        await sendCommand(attachment, { type: "get_available_models", id: "models" });
        expect((await successResponseFor(collector.messages, "models")).data).toEqual({
            models: [
                { provider: "fake", id: "model-2", name: "fake/model-2", contextWindow: 200_000, reasoning: true },
            ],
        });

        await sendCommand(attachment, { type: "set_thinking_level", id: "thinking", level: "high" });
        expect((await successResponseFor(collector.messages, "thinking")).data).toEqual({ level: "high" });

        await sendCommand(attachment, { type: "get_available_thinking_levels", id: "levels" });
        expect((await successResponseFor(collector.messages, "levels")).data).toEqual({
            levels: ["off", "minimal", "low", "medium", "high"],
        });

        await sendCommand(attachment, { type: "steer", id: "steer", message: "steer text" });
        expect((await successResponseFor(collector.messages, "steer")).data).toEqual({ disposition: "queued" });
        expect(session.steerCalls).toEqual([{ text: "steer text", images: undefined }]);

        await sendCommand(attachment, { type: "follow_up", id: "follow", message: "follow text" });
        expect((await successResponseFor(collector.messages, "follow")).data).toEqual({ disposition: "handled" });
        expect(session.followUpCalls).toEqual([{ text: "follow text", images: undefined }]);

        await sendCommand(attachment, { type: "abort", id: "abort" });
        expect((await responseFor(collector.messages, "abort")).success).toBe(true);
        expect(session.abortCalls).toBe(1);

        await sendCommand(attachment, { type: "clear_queue", id: "clear" });
        expect((await successResponseFor(collector.messages, "clear")).data).toEqual({
            steering: ["steer-a"],
            followUp: ["follow-b"],
        });

        await sendCommand(attachment, { type: "compact", id: "compact", customInstructions: "summarize" });
        expect((await successResponseFor(collector.messages, "compact")).data).toMatchObject({
            summary: "fake compaction",
        });
        expect(session.compactCalls).toEqual(["summarize"]);
    });

    it("broadcasts converted session events with monotonic sequence numbers", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const session = fakeSession(fixture, handle);

        session.emit(createTextDeltaEvent("Hel", "Hel"));
        session.emit({ type: "agent_settled", aborted: false });

        const event = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.delta.kind === "agent_event",
        );
        expect(event.cursor.seq).toBe(1);
        if (event.delta.kind !== "agent_event") {
            throw new Error("expected agent_event");
        }
        expect(event.delta.event.type).toBe("message_update");
        expect(JSON.stringify(event)).not.toContain('"partial"');
        expect(JSON.stringify(event)).not.toContain('"message"');

        const settled = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "agent_event" &&
                message.delta.event.type === "agent_settled",
        );
        expect(settled.cursor.seq).toBe(2);
        attachment.detach();
    });

    it("logs and broadcasts extension errors without closing the session", async () => {
        const recording = createRecordingLogger();
        const fixture = createFixture({ logger: recording.logger });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const { collector } = attach(fixture.registry, handle.sessionId);
        const bindings = fakeSession(fixture, handle).bindings;
        if (bindings === undefined) {
            throw new Error("expected extension bindings");
        }

        bindings.onError({ extensionPath: "/ext/demo.ts", event: "tool_call", error: "boom" });

        const broadcast = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.delta.kind === "extension_error",
        );
        expect(broadcast.delta).toMatchObject({
            kind: "extension_error",
            extensionPath: "/ext/demo.ts",
            event: "tool_call",
            error: "boom",
        });
        expect(recording.warnings.some((warning) => warning.message === "extension handler failed")).toBe(true);
        expect(fixture.registry.activeSessionCount).toBe(1);
    });

    it("bridges extension dialogs and resolves the pending request from any client", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const first = attach(fixture.registry, handle.sessionId);
        const second = attach(fixture.registry, handle.sessionId);
        const ui = fakeSession(fixture, handle).bindings?.uiContext;
        if (ui === undefined) {
            throw new Error("expected extension bindings");
        }

        const confirmed = ui.confirm("Clear session?", "All messages will be lost.");
        const request = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "confirm" &&
                message.delta.request.title === "Clear session?",
        );
        if (request.delta.kind !== "ui_request") {
            throw new Error("expected ui_request");
        }
        const confirmId = request.delta.request.id;
        await waitForMessage(
            second.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.id === confirmId,
        );

        await sendUiResponse(first.attachment, {
            type: "extension_ui_response",
            id: confirmId,
            confirmed: true,
        });
        await expect(confirmed).resolves.toBe(true);
        await waitForMessage(
            first.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_resolved" &&
                message.delta.requestId === confirmId,
        );
        await waitForMessage(
            second.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_resolved" &&
                message.delta.requestId === confirmId,
        );

        const selected = ui.select("Allow command?", ["Allow", "Block"]);
        const selectRequest = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "select",
        );
        if (selectRequest.delta.kind !== "ui_request") {
            throw new Error("expected ui_request");
        }
        await sendUiResponse(second.attachment, {
            type: "extension_ui_response",
            id: selectRequest.delta.request.id,
            value: "Allow",
        });
        await expect(selected).resolves.toBe("Allow");

        const input = ui.input("Enter a value", "placeholder");
        const inputRequest = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "input",
        );
        if (inputRequest.delta.kind !== "ui_request") {
            throw new Error("expected ui_request");
        }
        await sendUiResponse(first.attachment, {
            type: "extension_ui_response",
            id: inputRequest.delta.request.id,
            cancelled: true,
        });
        await expect(input).resolves.toBeUndefined();

        const edited = ui.editor("Edit text", "prefill");
        const editorRequest = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "editor",
        );
        if (editorRequest.delta.kind !== "ui_request") {
            throw new Error("expected ui_request");
        }
        await sendUiResponse(first.attachment, {
            type: "extension_ui_response",
            id: editorRequest.delta.request.id,
            value: "edited",
        });
        await expect(edited).resolves.toBe("edited");

        const late = attach(fixture.registry, handle.sessionId);
        const snapshot = await waitForMessage(
            late.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );
        expect(snapshot.snapshot.pendingUiRequests).toEqual([]);
    });

    it("forwards fire-and-forget extension UI methods and ignores component factories", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector } = attach(fixture.registry, handle.sessionId);
        const session = fakeSession(fixture, handle);
        const ui = session.bindings?.uiContext;
        if (ui === undefined) {
            throw new Error("expected extension bindings");
        }

        ui.notify("Heads up", "warning");
        ui.setStatus("build", "running");
        ui.setWidget("widget", ["line one", "line two"], { placement: "belowEditor" });
        ui.setWidget("ignored", (() => {
            throw new Error("component factories must not run");
        }) as never);
        ui.setTitle("pivia");
        ui.setEditorText("prefilled");

        const methods = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"];
        for (const method of methods) {
            await waitForMessage(
                collector.messages,
                (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                    message.type === "sync:delta" &&
                    message.delta.kind === "ui_request" &&
                    message.delta.request.method === method,
            );
        }
        const widgetRequests = collector.messages.filter(
            (message) =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "setWidget" &&
                message.delta.request.widgetKey === "ignored",
        );
        expect(widgetRequests).toEqual([]);
        expect(
            collector.messages.filter(
                (message) => message.type === "sync:delta" && message.delta.kind === "ui_request",
            ),
        ).toHaveLength(5);

        // A late client gets the cached chrome from the snapshot, not by replaying the deltas.
        const late = attach(fixture.registry, handle.sessionId);
        const cached = await waitForMessage(
            late.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );
        expect(cached.snapshot.uiState).toEqual({
            statuses: [{ key: "build", text: "running" }],
            widgets: [{ key: "widget", lines: ["line one", "line two"], placement: "belowEditor" }],
            title: "pivia",
        });

        // A reload rebinds the extension set, so clients receive removals and the next snapshot is empty.
        await session.bindings?.commandContextActions.reload();
        const uiRequests = collector.messages.filter(
            (
                message,
            ): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> & {
                readonly delta: Extract<SessionDelta, { kind: "ui_request" }>;
            } => message.type === "sync:delta" && message.delta.kind === "ui_request",
        );
        expect(uiRequests.slice(5).map((message) => message.delta.request.method)).toEqual([
            "setStatus",
            "setWidget",
            "setTitle",
        ]);

        const afterReload = attach(fixture.registry, handle.sessionId);
        const empty = await waitForMessage(
            afterReload.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );
        expect(empty.snapshot.uiState).toEqual(EMPTY_SESSION_UI_STATE);
    });

    it("resolves dialogs on timeout, abort, and session close", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector } = attach(fixture.registry, handle.sessionId);
        const ui = fakeSession(fixture, handle).bindings?.uiContext;
        if (ui === undefined) {
            throw new Error("expected extension bindings");
        }

        const timedOut = ui.confirm("Timeout?", "Default false", { timeout: 20 });
        await expect(timedOut).resolves.toBe(false);
        await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.delta.kind === "ui_resolved",
        );

        const controller = new AbortController();
        const aborted = ui.input("Abort?", undefined, { signal: controller.signal });
        controller.abort();
        await expect(aborted).resolves.toBeUndefined();

        const pending = ui.select("Close?", ["one", "two"]);
        const selectRequest = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "ui_request" &&
                message.delta.request.method === "select",
        );
        if (selectRequest.delta.kind !== "ui_request") {
            throw new Error("expected ui_request");
        }
        const late = createCollector();
        fixture.registry.attach(handle.sessionId, late.client);
        const lateSnapshot = await waitForMessage(
            late.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );
        expect(lateSnapshot.snapshot.pendingUiRequests.map((request) => request.id)).toContain(
            selectRequest.delta.request.id,
        );

        expect(await fixture.registry.closeSession(handle.sessionId)).toBe(true);
        await expect(pending).resolves.toBeUndefined();
        expect(collector.closes).toEqual([{ code: 4400, reason: "Session closed" }]);
        expect(await fixture.registry.closeSession(handle.sessionId)).toBe(false);
    });

    it("closes only the session that requested shutdown", async () => {
        const fixture = createFixture();
        writeSessionFixture(join(fixture.sessionDir, "alpha.jsonl"), "session-alpha");
        writeSessionFixture(join(fixture.sessionDir, "beta.jsonl"), "session-beta");
        const alpha = await fixture.registry.open(sid("session-alpha"));
        const beta = await fixture.registry.open(sid("session-beta"));

        fakeSession(fixture, alpha).bindings?.shutdownHandler();
        await waitUntil(() => fixture.registry.activeSessionCount === 1);

        expect(fixture.harness.find("session-alpha")?.disposeCalls).toBe(1);
        expect(fixture.harness.find("session-beta")?.disposeCalls).toBe(0);
        expect(await fixture.registry.getById(sid("session-alpha"))).not.toBeNull();
        expect(fakeSession(fixture, beta).bindings).toBeDefined();

        const { collector } = attach(fixture.registry, sid("session-beta"));
        expect(collector.messages[0]).toMatchObject({
            type: "sync:snapshot",
            snapshot: { state: { sessionId: "session-beta" } },
        });
    });

    it("reclaims idle runtimes only while no client is attached", async () => {
        const fixture = createFixture({ idleTimeoutMs: 30 });
        const first = await fixture.registry.createSession(fixture.projectDir);
        await waitUntil(() => fixture.registry.activeSessionCount === 0);
        expect(fixture.harness.find(first.sessionId)?.disposeCalls).toBe(1);

        const second = await fixture.registry.createSession(fixture.projectDir);
        const { attachment } = attach(fixture.registry, second.sessionId);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(fixture.registry.activeSessionCount).toBe(1);

        attachment.detach();
        await waitUntil(() => fixture.registry.activeSessionCount === 0);
        expect(fixture.harness.find(second.sessionId)?.disposeCalls).toBe(1);
    });

    it("creates, names, and persists a real SDK session", async () => {
        const root = mkdtempSync(join(tmpdir(), "pivia-real-runtime-"));
        tempDirs.push(root);
        const agentDir = join(root, "agent");
        const projectDir = join(root, "project");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(projectDir, { recursive: true });
        const logger = createLogger({ level: "silent" });
        const catalog = new SessionCatalog({ agentDir, cwd: root, env: {}, logger });
        let shutdownEvents = 0;
        const baseFactory = createPiRuntimeFactory({
            agentDir,
            logger,
            resourceLoaderOptions: {
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                extensionFactories: [
                    (pi) => {
                        pi.on("session_shutdown", () => {
                            shutdownEvents += 1;
                        });
                    },
                ],
            },
        });
        let captured: SessionManager | undefined;
        const registry = new SessionRegistry({
            catalog,
            logger,
            agentDir,
            idleTimeoutMs: 10_000,
            diskSync: { enabled: false },
            runtimeFactory: async (input) => {
                captured = input.sessionManager;
                return baseFactory(input);
            },
        });
        registries.push(registry);

        const handle: ActiveSessionHandle = await registry.createSession(projectDir);
        const realProjectDir = realpathSync(projectDir);
        const { collector, attachment } = attach(registry, handle.sessionId);

        await sendCommand(attachment, { type: "set_session_name", id: "name", name: "Integration Session" });
        expect(await responseFor(collector.messages, "name")).toMatchObject({ success: true });

        await sendCommand(attachment, { type: "get_state", id: "state" });
        expect((await successResponseFor(collector.messages, "state")).data).toMatchObject({
            sessionId: handle.sessionId,
            cwd: realProjectDir,
            name: "Integration Session",
            isStreaming: false,
            isCompacting: false,
        });

        if (captured === undefined) {
            throw new Error("expected the session manager captured by the runtime factory");
        }
        captured.appendMessage({ role: "user", content: "integration seed", timestamp: Date.now() });

        await registry.disposeAll();
        expect(registry.activeSessionCount).toBe(0);
        expect(shutdownEvents).toBe(1);
        await expect(registry.disposeAll()).resolves.toBeUndefined();

        const files = findSessionFiles(join(agentDir, "sessions"));
        expect(files).toHaveLength(1);
        expect(files[0]).toContain(handle.sessionId);
        const entries = readFileSync(files[0] ?? "", "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);

        expect(entries[0]).toMatchObject({ type: "session", id: handle.sessionId, cwd: realProjectDir });
        expect(entries.some((entry) => entry.type === "session_info" && entry.name === "Integration Session")).toBe(
            true,
        );
        expect(
            entries.some(
                (entry) =>
                    entry.type === "message" &&
                    typeof entry.message === "object" &&
                    entry.message !== null &&
                    (entry.message as Record<string, unknown>).role === "user" &&
                    (entry.message as Record<string, unknown>).content === "integration seed",
            ),
        ).toBe(true);
    });

    it("supports Tier 1/2/3 handshake fallbacks, 512 KB HTTP offloading, and causal entries_appended deltas", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fakeSession(fixture, handle);

        const first = attach(fixture.registry, handle.sessionId);
        const initialSnap = first.collector.messages[0];
        if (initialSnap?.type !== "sync:snapshot" || initialSnap.snapshot.entries.mode !== "inline") {
            throw new Error("expected inline sync:snapshot");
        }
        const runtimeId = initialSnap.cursor.epoch;
        const entriesVersion = initialSnap.snapshot.entriesVersion;
        expect(initialSnap.snapshot.baseEntryCount).toBe(0);
        expect(initialSnap.snapshot.entries.data).toHaveLength(1);

        // Appending multiple entries synchronously coalesces into one microtask entries_appended delta.
        const e1 = session.appendUserMessage("hello");
        const e2 = session.appendUserMessage("world");
        expect(e1).not.toBe(e2);
        // message_update alone does not trigger entries_appended.
        session.emit(createTextDeltaEvent("Hi", "Hi"));

        const appendedMsg = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.delta.kind === "entries_appended",
        );
        if (appendedMsg.delta.kind !== "entries_appended" || appendedMsg.delta.entries.mode !== "inline") {
            throw new Error("expected inline entries_appended delta");
        }
        expect(appendedMsg.delta.baseEntryCount).toBe(1);
        expect(appendedMsg.delta.entries.data).toHaveLength(2);

        // Tier 1 replays agent_event + entries_appended in exact causal order on the unified clock.
        const e3 = session.appendUserMessage("missed while offline");
        await Promise.resolve();
        const tier1 = attach(fixture.registry, handle.sessionId, {
            cursor: { epoch: runtimeId, seq: sessionSeq(0) },
            hint: { entriesVersion, afterCount: 3, afterEntryId: e2 },
        });
        const replayMsg = tier1.collector.messages[0];
        expect(replayMsg?.type).toBe("sync:replay");
        if (replayMsg?.type === "sync:replay") {
            expect(replayMsg.deltas.some((item) => item.payload.kind === "agent_event")).toBe(true);
            expect(
                replayMsg.deltas.some(
                    (item) =>
                        item.payload.kind === "entries_appended" &&
                        item.payload.baseEntryCount === 3 &&
                        item.payload.entries.mode === "inline" &&
                        item.payload.entries.data.length === 1,
                ),
            ).toBe(true);
        }

        // Tier 2 when epoch mismatches but prefixAnchor matches returns incremental inline snapshot.
        const tier2 = attach(fixture.registry, handle.sessionId, {
            hint: { entriesVersion, afterCount: 3, afterEntryId: e2 },
        });
        const patchSnap = tier2.collector.messages[0];
        expect(patchSnap?.type).toBe("sync:snapshot");
        if (patchSnap?.type === "sync:snapshot" && patchSnap.snapshot.entries.mode === "inline") {
            expect(patchSnap.snapshot.baseEntryCount).toBe(3);
            expect(patchSnap.snapshot.entries.data).toHaveLength(1);
            expect(patchSnap.snapshot.liveMessage?.content[0]).toEqual({ type: "text", text: "Hi" });
        }

        // Oversized (> 512 KB) payload offloads to mode: "http" in live entries_appended, Tier 1 replay, and Tier 2/3 snapshots.
        const huge = "z".repeat(600 * 1024);
        session.appendUserMessage(huge);
        const hugeBroadcast = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "entries_appended" &&
                message.delta.entries.mode === "http",
        );
        expect(hugeBroadcast.delta).toMatchObject({
            kind: "entries_appended",
            baseEntryCount: 4,
            entries: { mode: "http", meta: { entryCount: 5 } },
        });

        // Tier 1 replay retains compact { mode: "http" } descriptor in causal order.
        const tier1ReplayOffload = attach(fixture.registry, handle.sessionId, {
            cursor: { epoch: runtimeId, seq: sessionSeq(2) },
        });
        const replayWithOffload = tier1ReplayOffload.collector.messages[0];
        expect(replayWithOffload?.type).toBe("sync:replay");
        if (replayWithOffload?.type === "sync:replay") {
            expect(
                replayWithOffload.deltas.some(
                    (item) =>
                        item.payload.kind === "entries_appended" &&
                        item.payload.entries.mode === "http" &&
                        item.payload.entries.meta.entryCount === 5,
                ),
            ).toBe(true);
        }

        const tier2Offload = attach(fixture.registry, handle.sessionId, {
            hint: { entriesVersion, afterCount: 4, afterEntryId: e3 },
        });
        expect(tier2Offload.collector.messages[0]).toMatchObject({
            type: "sync:snapshot",
            snapshot: {
                baseEntryCount: 4,
                entries: { mode: "http", meta: { entryCount: 5 } },
            },
        });

        const tier3Offload = attach(fixture.registry, handle.sessionId);
        expect(tier3Offload.collector.messages[0]).toMatchObject({
            type: "sync:snapshot",
            snapshot: {
                baseEntryCount: 0,
                entries: { mode: "http", meta: { entryCount: 5 } },
            },
        });

        first.attachment.detach();
        tier1.attachment.detach();
        tier2.attachment.detach();
        tier1ReplayOffload.attachment.detach();
        tier2Offload.attachment.detach();
        tier3Offload.attachment.detach();
    });

    it("emits workspace catalog updates across lifecycle transitions without leaking message_update deltas", async () => {
        let releaseBind: (() => void) | undefined;
        const bindGate = new Promise<void>((resolve) => {
            releaseBind = resolve;
        });
        const fixture = createFixture({
            onCreate(session) {
                session.bindExtensionsHandler = async () => {
                    await bindGate;
                };
            },
        });

        const primary = attachCatalogCollector(fixture.registry);
        const secondary = attachCatalogCollector(fixture.registry);
        await Promise.all([primary.ready, secondary.ready]);
        const events = () =>
            primary.frames.filter(
                (frame): frame is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                    frame.type === "sync:delta",
            );

        try {
            const handle = await fixture.registry.createSession(fixture.projectDir);
            const session = fakeSession(fixture, handle);

            expect(events().at(-1)?.delta).toMatchObject({
                op: "upsert",
                item: { id: handle.sessionId, runtimeState: "starting", attachedClients: 0 },
            });
            expect(secondary.frames).toHaveLength(primary.frames.length);

            releaseBind?.();
            await waitUntil(() =>
                events().some(
                    (frame) =>
                        frame.delta.op === "patch" &&
                        frame.delta.id === handle.sessionId &&
                        frame.delta.patch.runtimeState === "idle",
                ),
            );

            const { attachment } = attach(fixture.registry, handle.sessionId);
            expect(events().at(-1)?.delta).toMatchObject({
                op: "patch",
                id: handle.sessionId,
                patch: { attachedClients: 1 },
            });

            await sendCommand(attachment, { type: "set_session_name", id: "rename-1", name: "Live Rename" });
            expect(events().at(-1)?.delta).toMatchObject({
                op: "patch",
                id: handle.sessionId,
                patch: { name: "Live Rename" },
            });

            session.setState({ isStreaming: true });
            session.emit({ type: "agent_start" });
            expect(events().at(-1)?.delta).toMatchObject({
                op: "patch",
                id: handle.sessionId,
                patch: { runtimeState: "streaming" },
            });

            const countBeforeDeltas = events().length;
            session.emit(createTextDeltaEvent("Hel", "Hel"));
            session.emit(createTextDeltaEvent("lo", "Hello"));
            expect(events()).toHaveLength(countBeforeDeltas);

            session.setState({ isStreaming: false });
            session.emit({ type: "agent_settled", aborted: false });
            expect(events().at(-1)?.delta).toMatchObject({
                op: "patch",
                id: handle.sessionId,
                patch: { runtimeState: "idle" },
            });

            attachment.detach();
            expect(events().at(-1)?.delta).toMatchObject({
                op: "patch",
                id: handle.sessionId,
                patch: { attachedClients: 0 },
            });

            await fixture.registry.closeSession(handle.sessionId);
            expect(events().some((frame) => frame.delta.op === "remove" && frame.delta.id === handle.sessionId)).toBe(
                true,
            );
            expect(events().at(-2)?.delta).toMatchObject({
                op: "patch",
                id: handle.sessionId,
                patch: { runtimeState: "closing" },
            });
            expect(events().at(-1)?.delta).toMatchObject({
                op: "remove",
                id: handle.sessionId,
            });

            // Detaching stops further notifications, and persisted disk sessions fall back to idle on close.
            secondary.detach();
            const countBeforePersisted = primary.frames.length;
            const persistedPath = join(fixture.sessionDir, "persisted.jsonl");
            writeSessionFixture(persistedPath, "session-persisted");
            const persistedId = parseSessionId("session-persisted");
            if (persistedId === null) {
                throw new Error("expected valid test session id");
            }
            await fixture.registry.open(persistedId);
            const countBeforeClose = events().length;
            await fixture.registry.closeSession(persistedId);

            expect(
                events()
                    .slice(countBeforeClose)
                    .some(
                        (frame) =>
                            frame.delta.op === "patch" &&
                            frame.delta.id === persistedId &&
                            frame.delta.patch.runtimeState === "idle" &&
                            frame.delta.patch.attachedClients === 0,
                    ),
            ).toBe(true);
            expect(secondary.frames.length).toBeLessThan(countBeforePersisted + 2);
            expect(events().at(-1)?.delta).toMatchObject({
                op: "patch",
                id: persistedId,
                patch: { runtimeState: "idle", attachedClients: 0 },
            });

            // All catalog events share one epoch and strictly increasing seq matching list().
            const listAfterEvents = await fixture.registry.list();
            const allDeltas = events();
            expect(allDeltas.length).toBeGreaterThan(0);
            for (let index = 0; index < allDeltas.length; index += 1) {
                const frame = allDeltas[index];
                expect(frame?.cursor.epoch).toBe(listAfterEvents.cursor.epoch);
                if (index > 0) {
                    const prev = allDeltas[index - 1];
                    if (prev !== undefined && frame !== undefined) {
                        expect(frame.cursor.seq).toBe(prev.cursor.seq + 1);
                    }
                }
            }
            expect(allDeltas.at(-1)?.cursor.seq).toBe(listAfterEvents.cursor.seq);

            primary.detach();
            const countAfterDetach = allDeltas.length;
            await fixture.registry.createSession(fixture.projectDir);
            expect(events()).toHaveLength(countAfterDetach);
            expect((await fixture.registry.list()).cursor.seq).toBeGreaterThan(listAfterEvents.cursor.seq);
        } finally {
            releaseBind?.();
        }
    });

    it("preserves full firstMessage and sends it once instead of repeating it on later patches", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fakeSession(fixture, handle);
        const catalog = attachCatalogCollector(fixture.registry);
        await catalog.ready;
        const longMessage = "x".repeat(2_000);

        session.appendUserMessage(longMessage);
        session.emit({
            type: "message_end",
            message: { role: "user", content: longMessage, timestamp: Date.now() },
        });

        const deltas = catalog.frames.filter(
            (frame): frame is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> => frame.type === "sync:delta",
        );
        expect(handle.summarize().firstMessage).toBe(longMessage);
        expect(deltas).toHaveLength(1);
        expect(deltas[0]?.delta).toMatchObject({
            op: "patch",
            id: handle.sessionId,
            patch: { firstMessage: longMessage },
        });

        session.setState({ isStreaming: true });
        session.emit({ type: "agent_start" });
        session.emit({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "Done" }],
                timestamp: Date.now(),
            } as never,
        });
        session.setState({ isStreaming: false });
        session.emit({ type: "agent_end", messages: [], willRetry: false });
        session.emit({ type: "agent_settled", aborted: false });

        const laterPatches = catalog.frames
            .filter(
                (frame): frame is Extract<WorkspaceWsServerMessage, { type: "sync:delta" }> =>
                    frame.type === "sync:delta",
            )
            .slice(1)
            .filter((frame) => frame.delta.op === "patch");
        expect(laterPatches.length).toBeGreaterThan(0);
        for (const update of laterPatches) {
            if (update.delta.op === "patch") {
                expect("firstMessage" in update.delta.patch).toBe(false);
            }
        }
        catalog.detach();
    });

    it("ignores late detach after close and caches header-derived summary fields", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fakeSession(fixture, handle);
        const catalog = attachCatalogCollector(fixture.registry);
        await catalog.ready;

        const { attachment } = attach(fixture.registry, handle.sessionId);
        session.appendUserMessage("Cached prompt");
        session.emit({
            type: "message_end",
            message: { role: "user", content: "Cached prompt", timestamp: Date.now() },
        });

        const originalGetEntries = session.getEntries.bind(session);
        let getEntriesCalls = 0;
        session.getEntries = () => {
            getEntriesCalls += 1;
            return originalGetEntries();
        };
        const summary = handle.summarize();
        expect(summary.firstMessage).toBe("Cached prompt");
        expect(getEntriesCalls).toBe(0);

        const countBeforeClose = catalog.frames.length;
        await fixture.registry.closeSession(handle.sessionId);
        const closedFrames = catalog.frames.slice(countBeforeClose);
        expect(
            closedFrames.some(
                (frame) =>
                    frame.type === "sync:delta" &&
                    frame.delta.op === "patch" &&
                    frame.delta.id === handle.sessionId &&
                    frame.delta.patch.runtimeState === "idle" &&
                    frame.delta.patch.attachedClients === 0,
            ),
        ).toBe(true);
        const countAfterTerminal = catalog.frames.length;

        // A late detach arriving after closeSession removed the entry must not re-publish "closing".
        attachment.detach();
        expect(catalog.frames).toHaveLength(countAfterTerminal);
        catalog.detach();
    });

    it("emits a terminal fallback catalog event even when resolveById rejects after close", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const catalog = attachCatalogCollector(fixture.registry);
        await catalog.ready;

        fixture.catalog.resolveById = () => Promise.reject(new Error("disk read error"));
        await fixture.registry.closeSession(handle.sessionId);
        expect(catalog.frames.at(-1)).toMatchObject({
            type: "sync:delta",
            delta: { op: "remove", id: handle.sessionId },
        });
        catalog.detach();
    });

    it("keeps an oversized persisted session in the catalog on close instead of emitting remove", async () => {
        const fixture = createFixture({ maxSessionFileBytes: 100 });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const catalog = attachCatalogCollector(fixture.registry);
        await catalog.ready;

        writeSessionFixture(join(fixture.sessionDir, "oversized.jsonl"), handle.sessionId, {
            messages: [{ role: "user", text: "x".repeat(500) }],
        });

        await fixture.registry.closeSession(handle.sessionId);
        expect(
            catalog.frames.some(
                (frame) =>
                    frame.type === "sync:delta" &&
                    frame.delta.op === "patch" &&
                    frame.delta.id === handle.sessionId &&
                    frame.delta.patch.runtimeState === "idle" &&
                    frame.delta.patch.attachedClients === 0,
            ),
        ).toBe(true);
        expect(catalog.frames.some((frame) => frame.type === "sync:delta" && frame.delta.op === "remove")).toBe(false);
        catalog.detach();
    });

    it("retries list() when a session closes mid-scan so snapshots stay linearized", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const originalList = fixture.catalog.list.bind(fixture.catalog);
        let listCalls = 0;
        const firstScanStarted = Promise.withResolvers<void>();
        const releaseFirstScan = Promise.withResolvers<void>();

        fixture.catalog.list = async () => {
            listCalls += 1;
            const res = await originalList();
            if (listCalls === 1) {
                firstScanStarted.resolve();
                await releaseFirstScan.promise;
            }
            return res;
        };

        const listPromise = fixture.registry.list();
        await firstScanStarted.promise;
        await fixture.registry.closeSession(handle.sessionId);
        releaseFirstScan.resolve();

        const result = await listPromise;
        expect(listCalls).toBe(2);
        expect(result.sessions.some((session) => session.id === handle.sessionId)).toBe(false);
    });

    it("emits state_patched for queue modes and auto-compaction changes after extension reload()", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fixture.harness.sessions[0];
        if (session === undefined) {
            throw new Error("expected fake session");
        }
        session.reload = () => {
            session.reloadCalls += 1;
            session.setState({
                steeringMode: "all",
                followUpMode: "all",
                autoCompactionEnabled: false,
            });
            return Promise.resolve();
        };

        const c1 = createCollector();
        const attach1 = fixture.registry.attach(handle.sessionId, c1.client);
        const snap = c1.messages[0];
        if (snap?.type !== "sync:snapshot") {
            throw new Error("expected initial snapshot");
        }
        const s1 = parseSyncSeq<"session">(1);
        if (s1 === null) {
            throw new Error("invalid seq");
        }

        await session.bindings?.commandContextActions.reload();
        expect(c1.messages.slice(1)).toEqual([
            {
                type: "sync:delta",
                cursor: { epoch: snap.cursor.epoch, seq: s1 },
                delta: {
                    kind: "state_patched",
                    patch: {
                        steeringMode: "all",
                        followUpMode: "all",
                        autoCompactionEnabled: false,
                    },
                },
            },
        ]);

        // Tier 1 replay for a reconnecting client includes that state_patched delta cleanly.
        const c2 = createCollector();
        const attach2 = fixture.registry.attach(handle.sessionId, c2.client, { cursor: snap.cursor });
        expect(c2.messages).toEqual([
            {
                type: "sync:replay",
                cursor: { epoch: snap.cursor.epoch, seq: s1 },
                fromSeq: snap.cursor.seq,
                deltas: [
                    {
                        seq: s1,
                        payload: {
                            kind: "state_patched",
                            patch: {
                                steeringMode: "all",
                                followUpMode: "all",
                                autoCompactionEnabled: false,
                            },
                        },
                    },
                ],
            },
        ]);

        attach1.detach();
        attach2.detach();
    });

    it("completes close cleanup and allows reopening even if an unsubscribe callback throws", async () => {
        const fixture = createFixture({
            onCreate: (session) => {
                session.subscribe = () => () => {
                    throw new Error("unsubscribe failure");
                };
            },
        });
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await expect(fixture.registry.closeSession(handle.sessionId)).resolves.toBe(true);
        const listAfterClose = await fixture.registry.list();
        expect(listAfterClose.sessions.some((s) => s.id === handle.sessionId)).toBe(false);
    });

    it("coalesces consecutive assistant text deltas inside streamCoalesceMs and flushes before settled boundaries", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const session = fakeSession(fixture, handle);

        session.emit(createTextDeltaEvent("Hel", "Hel"));
        session.emit(createTextDeltaEvent("lo ", "Hello "));
        session.emit(createTextDeltaEvent("world", "Hello world"));

        // Buffered until either the 16ms coalesce timer or a non-delta boundary fires.
        expect(collector.messages.filter((m) => m.type === "sync:delta")).toHaveLength(0);

        session.emit({ type: "agent_settled", aborted: false });

        const coalesced = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.delta.kind === "agent_event",
        );
        if (coalesced.delta.kind !== "agent_event" || coalesced.delta.event.type !== "message_update") {
            throw new Error("expected coalesced message_update");
        }
        expect(coalesced.cursor.seq).toBe(1);
        expect(coalesced.delta.event.assistantMessageEvent).toEqual({
            type: "text_delta",
            contentIndex: 0,
            delta: "Hello world",
        });

        const settled = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" &&
                message.delta.kind === "agent_event" &&
                message.delta.event.type === "agent_settled",
        );
        expect(settled.cursor.seq).toBe(2);
        attachment.detach();
    });

    it("flushes coalesced deltas automatically when the timer expires and on delta type switches", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const { collector, attachment } = attach(fixture.registry, handle.sessionId);
        const session = fakeSession(fixture, handle);

        const thinkingEvent = (delta: string, accumulated: string): AgentSessionEvent => {
            const base = createTextDeltaEvent("", "");
            if (base.type !== "message_update" || base.message.role !== "assistant") {
                throw new Error("expected assistant message_update template");
            }
            const message = {
                ...base.message,
                content: [{ type: "thinking" as const, thinking: accumulated }],
            };
            return {
                type: "message_update",
                message,
                assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message },
            };
        };

        // Thinking deltas followed by text delta flushes thinking immediately, then timer flushes text.
        session.emit(thinkingEvent("Step 1", "Step 1"));
        session.emit(thinkingEvent(" Step 2", "Step 1 Step 2"));
        session.emit(createTextDeltaEvent("Done!", "Done!"));

        const thinkingMsg = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.cursor.seq === 1,
        );
        const textMsg = await waitForMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.cursor.seq === 2,
        );
        if (
            thinkingMsg.delta.kind !== "agent_event" ||
            thinkingMsg.delta.event.type !== "message_update" ||
            textMsg.delta.kind !== "agent_event" ||
            textMsg.delta.event.type !== "message_update"
        ) {
            throw new Error("expected message_update deltas");
        }

        expect(thinkingMsg.delta.event.assistantMessageEvent).toEqual({
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Step 1 Step 2",
        });
        expect(textMsg.delta.event.assistantMessageEvent).toEqual({
            type: "text_delta",
            contentIndex: 0,
            delta: "Done!",
        });
        attachment.detach();
    });
});
