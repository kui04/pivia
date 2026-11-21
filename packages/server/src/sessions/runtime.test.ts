import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionManager } from "@earendil-works/pi-coding-agent";

import { parseSessionId, type SessionId, type WsResponseMessage, type WsServerMessage } from "@pivia/protocol";
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
    readonly messages: WsServerMessage[];
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
    const catalog = new SessionCatalog({ sessionDir, agentDir, cwd: root, env: {}, logger });
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
    });
    registries.push(registry);
    return { root, agentDir, projectDir, sessionDir, catalog, registry, harness };
}

function createCollector(): Collector {
    const messages: WsServerMessage[] = [];
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

async function waitForMessage<T extends WsServerMessage>(
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
    throw new Error(`Timed out waiting for message. Received: ${JSON.stringify(messages)}`);
}

function responseFor(messages: readonly WsServerMessage[], id: string): Promise<WsResponseMessage> {
    return waitForMessage(messages, (message): message is WsResponseMessage => {
        return message.type === "response" && message.id === id;
    });
}

async function successResponseFor(
    messages: readonly WsServerMessage[],
    id: string,
): Promise<Extract<WsResponseMessage, { success: true }>> {
    const response = await responseFor(messages, id);
    expect(response.success).toBe(true);
    if (!response.success) {
        throw new Error(`Expected successful response for ${id}, got: ${response.error}`);
    }
    return response;
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
        if (snapshot?.type !== "snapshot") {
            throw new Error("expected a snapshot");
        }
        const request = snapshot.pendingUiRequests[0];
        if (request === undefined) {
            throw new Error("expected the startup dialog in the snapshot");
        }
        expect(request.method).toBe("select");

        await attachment.handleCommand({ type: "extension_ui_response", id: request.id, value: "safe" });
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
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "confirm",
        );
        expect((await fixture.registry.getById(handle.sessionId))?.session.runtimeState).toBe("closing");
        expect(() => fixture.registry.attach(handle.sessionId, createCollector().client)).toThrow(SessionRegistryError);

        await attachment.handleCommand({ type: "get_state", id: "closing-state" });
        const closingResponse = await waitForMessage(
            collector.messages,
            (message): message is Extract<WsServerMessage, { type: "response" }> =>
                message.type === "response" && message.id === "closing-state",
        );
        expect(closingResponse).toMatchObject({ success: false, error: "Session is closing." });

        await attachment.handleCommand({
            type: "extension_ui_response",
            id: request.request.id,
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
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "confirm",
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
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "select",
        );
        attachment.detach();
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(fixture.registry.activeSessionCount).toBe(1);

        const late = attach(fixture.registry, handle.sessionId);
        const snapshot = late.collector.messages[0];
        if (snapshot?.type !== "snapshot") {
            throw new Error("expected a snapshot");
        }
        expect(snapshot.pendingUiRequests.map((pending) => pending.id)).toContain(request.request.id);
        await late.attachment.handleCommand({
            type: "extension_ui_response",
            id: request.request.id,
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
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "select",
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
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "confirm",
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
        if (snapshot?.type !== "snapshot") {
            throw new Error("expected a snapshot");
        }
        const startupRequest = snapshot.pendingUiRequests[0];
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
            (message): message is Extract<WsServerMessage, { type: "extension_ui_resolved" }> =>
                message.type === "extension_ui_resolved" && message.requestId === startupRequest.id,
        );
        if (startupDialog === undefined) {
            throw new Error("expected the startup dialog");
        }
        await expect(startupDialog).resolves.toBeUndefined();

        const shutdownRequest = await waitForMessage(
            collector.messages,
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "confirm",
        );
        await attachment.handleCommand({
            type: "extension_ui_response",
            id: shutdownRequest.request.id,
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

        const cases = [missing, filePath, "relative/project"];
        for (const cwd of cases) {
            await expect(fixture.registry.createSession(cwd)).rejects.toBeInstanceOf(SessionRegistryError);
        }
        expect(fixture.registry.activeSessionCount).toBe(0);
        expect(fixture.harness.runtimes).toHaveLength(0);
    });

    it("merges an unflushed new session into list and detail responses", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fakeSession(fixture, handle);
        const realProjectDir = realpathSync(fixture.projectDir);

        session.setState({ isStreaming: true, messageCount: 2, pendingMessageCount: 1 });
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
        expect(collector.messages[0]).toMatchObject({ type: "snapshot", sessionId: handle.sessionId, seq: 0 });
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

        await attachment.handleCommand({ type: "prompt", id: "prompt-1", message: "hello" });
        const accepted = await responseFor(collector.messages, "prompt-1");
        expect(accepted).toMatchObject({
            type: "response",
            command: "prompt",
            success: true,
            data: { disposition: "started" },
        });
        expect(session.promptCalls).toHaveLength(1);

        release?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(collector.messages.filter((message) => message.type === "response")).toHaveLength(1);

        session.promptHandler = () => Promise.reject(new Error("Session is already streaming."));
        await attachment.handleCommand({ type: "prompt", id: "prompt-2", message: "again" });
        const rejected = await responseFor(collector.messages, "prompt-2");
        expect(rejected).toMatchObject({
            type: "response",
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

        await attachment.handleCommand({ type: "prompt", id: "prompt-late", message: "hello" });
        const accepted = await responseFor(collector.messages, "prompt-late");
        expect(accepted).toMatchObject({ success: true, data: { disposition: "queued" } });

        await waitUntil(() =>
            recording.warnings.some((warning) => warning.message === "prompt failed after it was accepted"),
        );
        expect(
            collector.messages.filter((message) => message.type === "response" && message.id === "prompt-late"),
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
            pendingMessageCount: 2,
            messageCount: 4,
        });

        await attachment.handleCommand({ type: "get_state", id: "state" });
        expect((await successResponseFor(collector.messages, "state")).data).toMatchObject({
            sessionId: handle.sessionId,
            name: null,
            thinkingLevel: "medium",
            isStreaming: false,
            steeringMessages: ["steer-a"],
            followUpMessages: ["follow-b"],
            pendingMessageCount: 2,
            messageCount: 4,
        });

        await attachment.handleCommand({ type: "set_session_name", id: "name", name: "  Named Session  " });
        expect((await responseFor(collector.messages, "name")).success).toBe(true);
        expect(session.getName()).toBe("Named Session");

        await attachment.handleCommand({ type: "set_session_name", id: "empty-name", name: "   " });
        expect(await responseFor(collector.messages, "empty-name")).toMatchObject({
            success: false,
            error: "Session name cannot be empty.",
        });

        await attachment.handleCommand({ type: "set_model", id: "model", provider: "fake", modelId: "model-2" });
        expect((await successResponseFor(collector.messages, "model")).data).toEqual({
            provider: "fake",
            id: "model-2",
            name: "fake/model-2",
        });

        await attachment.handleCommand({ type: "get_available_models", id: "models" });
        expect((await successResponseFor(collector.messages, "models")).data).toEqual({
            models: [{ provider: "fake", id: "model-2", name: "fake/model-2" }],
        });

        await attachment.handleCommand({ type: "set_thinking_level", id: "thinking", level: "high" });
        expect((await successResponseFor(collector.messages, "thinking")).data).toEqual({ level: "high" });

        await attachment.handleCommand({ type: "get_available_thinking_levels", id: "levels" });
        expect((await successResponseFor(collector.messages, "levels")).data).toEqual({
            levels: ["off", "minimal", "low", "medium", "high"],
        });

        await attachment.handleCommand({ type: "steer", id: "steer", message: "steer text" });
        expect((await successResponseFor(collector.messages, "steer")).data).toEqual({ disposition: "queued" });
        expect(session.steerCalls).toEqual([{ text: "steer text", images: undefined }]);

        await attachment.handleCommand({ type: "follow_up", id: "follow", message: "follow text" });
        expect((await successResponseFor(collector.messages, "follow")).data).toEqual({ disposition: "handled" });
        expect(session.followUpCalls).toEqual([{ text: "follow text", images: undefined }]);

        await attachment.handleCommand({ type: "abort", id: "abort" });
        expect((await responseFor(collector.messages, "abort")).success).toBe(true);
        expect(session.abortCalls).toBe(1);

        await attachment.handleCommand({ type: "clear_queue", id: "clear" });
        expect((await successResponseFor(collector.messages, "clear")).data).toEqual({
            steering: ["steer-a"],
            followUp: ["follow-b"],
        });

        await attachment.handleCommand({ type: "compact", id: "compact", customInstructions: "summarize" });
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
            (message): message is Extract<WsServerMessage, { type: "event" }> => message.type === "event",
        );
        expect(event.seq).toBe(1);
        expect(event.event.type).toBe("message_update");
        expect(JSON.stringify(event)).not.toContain('"partial"');
        expect(JSON.stringify(event)).not.toContain('"message"');

        const settled = await waitForMessage(
            collector.messages,
            (message): message is Extract<WsServerMessage, { type: "event" }> =>
                message.type === "event" && message.event.type === "agent_settled",
        );
        expect(settled.seq).toBe(2);
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
            (message): message is Extract<WsServerMessage, { type: "extension_error" }> =>
                message.type === "extension_error",
        );
        expect(broadcast).toMatchObject({
            sessionId: handle.sessionId,
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
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" &&
                message.request.method === "confirm" &&
                message.request.title === "Clear session?",
        );
        await waitForMessage(
            second.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.id === request.request.id,
        );

        await first.attachment.handleCommand({
            type: "extension_ui_response",
            id: request.request.id,
            confirmed: true,
        });
        await expect(confirmed).resolves.toBe(true);
        await waitForMessage(
            first.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "extension_ui_resolved" }> =>
                message.type === "extension_ui_resolved" && message.requestId === request.request.id,
        );
        await waitForMessage(
            second.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "extension_ui_resolved" }> =>
                message.type === "extension_ui_resolved" && message.requestId === request.request.id,
        );

        const selected = ui.select("Allow command?", ["Allow", "Block"]);
        const selectRequest = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "select",
        );
        await second.attachment.handleCommand({
            type: "extension_ui_response",
            id: selectRequest.request.id,
            value: "Allow",
        });
        await expect(selected).resolves.toBe("Allow");

        const input = ui.input("Enter a value", "placeholder");
        const inputRequest = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "input",
        );
        await first.attachment.handleCommand({
            type: "extension_ui_response",
            id: inputRequest.request.id,
            cancelled: true,
        });
        await expect(input).resolves.toBeUndefined();

        const edited = ui.editor("Edit text", "prefill");
        const editorRequest = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "editor",
        );
        await first.attachment.handleCommand({
            type: "extension_ui_response",
            id: editorRequest.request.id,
            value: "edited",
        });
        await expect(edited).resolves.toBe("edited");

        const late = attach(fixture.registry, handle.sessionId);
        const snapshot = await waitForMessage(
            late.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "snapshot" }> => message.type === "snapshot",
        );
        expect(snapshot.pendingUiRequests).toEqual([]);
    });

    it("forwards fire-and-forget extension UI methods and ignores component factories", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, handle.sessionId, "idle");
        const { collector } = attach(fixture.registry, handle.sessionId);
        const ui = fakeSession(fixture, handle).bindings?.uiContext;
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
                (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                    message.type === "extension_ui_request" && message.request.method === method,
            );
        }
        const widgetRequests = collector.messages.filter(
            (message) =>
                message.type === "extension_ui_request" &&
                message.request.method === "setWidget" &&
                message.request.widgetKey === "ignored",
        );
        expect(widgetRequests).toEqual([]);
        expect(collector.messages.filter((message) => message.type === "extension_ui_request")).toHaveLength(5);
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
            (message): message is Extract<WsServerMessage, { type: "extension_ui_resolved" }> =>
                message.type === "extension_ui_resolved",
        );

        const controller = new AbortController();
        const aborted = ui.input("Abort?", undefined, { signal: controller.signal });
        controller.abort();
        await expect(aborted).resolves.toBeUndefined();

        const pending = ui.select("Close?", ["one", "two"]);
        const selectRequest = await waitForMessage(
            collector.messages,
            (message): message is Extract<WsServerMessage, { type: "extension_ui_request" }> =>
                message.type === "extension_ui_request" && message.request.method === "select",
        );
        const late = createCollector();
        fixture.registry.attach(handle.sessionId, late.client);
        const lateSnapshot = await waitForMessage(
            late.messages,
            (message): message is Extract<WsServerMessage, { type: "snapshot" }> => message.type === "snapshot",
        );
        expect(lateSnapshot.pendingUiRequests.map((request) => request.id)).toContain(selectRequest.request.id);

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
        expect(collector.messages[0]).toMatchObject({ type: "snapshot", sessionId: "session-beta" });
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
            runtimeFactory: async (input) => {
                captured = input.sessionManager;
                return baseFactory(input);
            },
        });
        registries.push(registry);

        const handle: ActiveSessionHandle = await registry.createSession(projectDir);
        const realProjectDir = realpathSync(projectDir);
        const { collector, attachment } = attach(registry, handle.sessionId);

        await attachment.handleCommand({ type: "set_session_name", id: "name", name: "Integration Session" });
        expect(await responseFor(collector.messages, "name")).toMatchObject({ success: true });

        await attachment.handleCommand({ type: "get_state", id: "state" });
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

    it("supports Tier 1/2/3 handshake fallbacks, 512 KB HTTP offloading, and microtask entries_appended broadcasts", async () => {
        const fixture = createFixture();
        const handle = await fixture.registry.createSession(fixture.projectDir);
        const session = fakeSession(fixture, handle);

        const first = attach(fixture.registry, handle.sessionId);
        const initialSnap = first.collector.messages[0];
        if (initialSnap?.type !== "snapshot" || initialSnap.entriesMode !== "inline") {
            throw new Error("expected inline snapshot");
        }
        const runtimeId = initialSnap.runtimeId;
        const entriesVersion = initialSnap.entriesVersion;
        expect(initialSnap.baseEntryCount).toBe(0);
        expect(initialSnap.entries).toHaveLength(1);

        // Appending multiple entries synchronously coalesces into one microtask entries_appended broadcast.
        const e1 = session.appendUserMessage("hello");
        const e2 = session.appendUserMessage("world");
        expect(e1).not.toBe(e2);
        // message_update alone does not trigger entries_appended.
        session.emit(createTextDeltaEvent("Hi", "Hi"));

        const appendedMsg = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "entries_appended" }> =>
                message.type === "entries_appended",
        );
        expect(appendedMsg.entriesMode).toBe("inline");
        if (appendedMsg.entriesMode === "inline") {
            expect(appendedMsg.baseEntryCount).toBe(1);
            expect(appendedMsg.entries).toHaveLength(2);
        }

        // Tier 1 with matching runtimeId + prefixAnchor appends missed entries & includes liveMessage.
        const e3 = session.appendUserMessage("missed while offline");
        await Promise.resolve();
        const tier1 = attach(fixture.registry, handle.sessionId, {
            afterSeq: 0,
            runtimeId,
            prefixAnchor: { entriesVersion, afterCount: 3, afterEntryId: e2 },
        });
        const replayMsg = tier1.collector.messages[0];
        expect(replayMsg?.type).toBe("replay");
        if (replayMsg?.type === "replay") {
            expect(replayMsg.appendedSlice?.baseEntryCount).toBe(3);
            expect(replayMsg.appendedSlice?.entries).toHaveLength(1);
            expect(replayMsg.liveMessage?.content[0]).toEqual({ type: "text", text: "Hi" });
        }

        // Tier 2 when runtimeId mismatches but prefixAnchor matches returns incremental inline snapshot.
        const tier2 = attach(fixture.registry, handle.sessionId, {
            afterSeq: 0,
            runtimeId: "old-runtime",
            prefixAnchor: { entriesVersion, afterCount: 3, afterEntryId: e2 },
        });
        const patchSnap = tier2.collector.messages[0];
        expect(patchSnap?.type).toBe("snapshot");
        if (patchSnap?.type === "snapshot" && patchSnap.entriesMode === "inline") {
            expect(patchSnap.baseEntryCount).toBe(3);
            expect(patchSnap.entries).toHaveLength(1);
            expect(patchSnap.liveMessage?.content[0]).toEqual({ type: "text", text: "Hi" });
        }

        // Oversized (> 512 KB) payload offloads to entriesMode: "http" across Tier 1, Tier 2, Tier 3, and live entries_appended.
        const huge = "z".repeat(600 * 1024);
        session.appendUserMessage(huge);
        const hugeBroadcast = await waitForMessage(
            first.collector.messages,
            (message): message is Extract<WsServerMessage, { type: "entries_appended" }> =>
                message.type === "entries_appended" && message.entriesMode === "http",
        );
        expect(hugeBroadcast).toMatchObject({ entriesMode: "http", baseEntryCount: 4, entryCount: 5 });

        const tier1Offload = attach(fixture.registry, handle.sessionId, {
            afterSeq: 0,
            runtimeId,
            prefixAnchor: { entriesVersion, afterCount: 4, afterEntryId: e3 },
        });
        expect(tier1Offload.collector.messages[0]).toMatchObject({
            type: "snapshot",
            entriesMode: "http",
            baseEntryCount: 4,
            entryCount: 5,
        });

        const tier3Offload = attach(fixture.registry, handle.sessionId);
        expect(tier3Offload.collector.messages[0]).toMatchObject({
            type: "snapshot",
            entriesMode: "http",
            baseEntryCount: 0,
            entryCount: 5,
        });

        first.attachment.detach();
        tier1.attachment.detach();
        tier2.attachment.detach();
        tier1Offload.attachment.detach();
        tier3Offload.attachment.detach();
    });
});
