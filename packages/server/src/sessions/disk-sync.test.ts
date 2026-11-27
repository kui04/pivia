import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
    parseSessionId,
    SESSION_CLOSE_CODE,
    WS_CLOSE_CODE,
    type CatalogDelta,
    type SessionId,
    type SessionSummary,
    type SessionWsServerMessage,
    type WorkspaceWsServerMessage,
} from "@pivia/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    AwaitWriteFinishOptions,
    WatchBackend,
    WatchBackendEventName,
    WatchBackendFactory,
    WatchBackendOptions,
} from "../fs/watcher.ts";
import { createChokidarWatchBackend } from "../fs/watcher.ts";
import { createLogger } from "../logger.ts";
import {
    createFakeRuntimeHarness,
    type FakeRuntimeHarness,
    type FakeSession,
    writeSessionFixture,
} from "../testing/fake-runtime.ts";
import { defaultProjectSessionDir, type CatalogDiskEntry, type DiskFileStamp, SessionCatalog } from "./catalog.ts";
import {
    detectActiveDiskChange,
    diffCatalogSnapshots,
    diffSessionSummaryForCatalog,
    mergeCatalogEntries,
    stampsEqual,
    type TrackedDiskFile,
} from "./disk-sync.ts";
import { type SessionAttachment, type SessionClient, SessionRegistry } from "./runtime.ts";

const tempDirs: string[] = [];
const registries: SessionRegistry[] = [];

afterEach(async () => {
    try {
        let registry = registries.pop();
        while (registry !== undefined) {
            await registry.disposeAll();
            registry = registries.pop();
        }
    } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
        let dir = tempDirs.pop();
        while (dir !== undefined) {
            rmSync(dir, { recursive: true, force: true });
            dir = tempDirs.pop();
        }
    }
});

function createTempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
}

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

function makeSummary(rawId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: sid(rawId),
        cwd: "/tmp/project",
        name: null,
        firstMessage: "Hello",
        messageCount: 1,
        createdAtMs: 1_000,
        modifiedAtMs: 2_000,
        hasParent: false,
        runtimeState: "idle",
        attachedClients: 0,
        ...overrides,
    };
}

function makeDiskEntry(
    rawId: string,
    options: {
        readonly realPath?: string;
        readonly mtimeMs?: number;
        readonly ctimeMs?: number;
        readonly sizeBytes?: number;
        readonly ino?: number;
        readonly summary?: Partial<SessionSummary>;
    } = {},
): CatalogDiskEntry {
    const mtimeMs = options.mtimeMs ?? 5_000;
    return {
        summary: makeSummary(rawId, options.summary),
        realPath: options.realPath ?? `/tmp/sessions/${rawId}.jsonl`,
        stamp: {
            mtimeMs,
            ctimeMs: options.ctimeMs ?? mtimeMs,
            sizeBytes: options.sizeBytes ?? 256,
            ino: options.ino ?? 1,
        },
    };
}

interface FakeWatchHandle {
    readonly options: WatchBackendOptions;
    readonly watchedPaths: Set<string>;
    closed: boolean;
}

interface FakeWatchHarness {
    readonly factory: WatchBackendFactory;
    readonly handles: FakeWatchHandle[];
    activeCount(): number;
    trigger(dirPath: string, event: WatchBackendEventName, filename: string | null): void;
}

function createFakeWatchHarness(): FakeWatchHarness {
    const handles: FakeWatchHandle[] = [];

    const factory: WatchBackendFactory = (options) => {
        const watchedPaths = new Set<string>();
        const entry: FakeWatchHandle = {
            options,
            watchedPaths,
            closed: false,
        };
        handles.push(entry);
        const backend: WatchBackend = {
            add(paths) {
                for (const p of paths) {
                    watchedPaths.add(p);
                }
            },
            unwatch(paths) {
                for (const p of paths) {
                    watchedPaths.delete(p);
                }
            },
            close() {
                entry.closed = true;
                watchedPaths.clear();
                return Promise.resolve();
            },
        };
        return backend;
    };

    return {
        factory,
        handles,
        activeCount() {
            return handles.reduce((sum, handle) => sum + (handle.closed ? 0 : handle.watchedPaths.size), 0);
        },
        trigger(dirPath, event, filename) {
            const target = realpathSync(dirPath);
            const eventPath = filename === null ? target : join(target, filename);
            for (const handle of handles) {
                if (handle.closed) {
                    continue;
                }
                const matchesWatched = [...handle.watchedPaths].some(
                    (watchedPath) => realpathSync(watchedPath) === target,
                );
                if (matchesWatched) {
                    handle.options.onEvent({ event, path: eventPath });
                }
            }
        },
    };
}

interface SessionClientCollector {
    readonly client: SessionClient;
    readonly messages: SessionWsServerMessage[];
    readonly closes: Array<{ readonly code: number; readonly reason: string }>;
}

function createSessionClientCollector(): SessionClientCollector {
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for condition");
}

async function waitForRuntimeState(
    registry: SessionRegistry,
    sessionId: SessionId,
    expected: string,
    timeoutMs = 2_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const detail = await registry.getById(sessionId);
        if (detail?.session.runtimeState === expected) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for runtime state ${expected}`);
}

async function waitForCatalogDelta(
    frames: readonly WorkspaceWsServerMessage[],
    predicate: (delta: CatalogDelta) => boolean,
    timeoutMs = 2_000,
): Promise<CatalogDelta> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const frame of frames) {
            if (frame.type === "sync:delta" && predicate(frame.delta)) {
                return frame.delta;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for catalog delta. Received: ${JSON.stringify(frames)}`);
}

async function waitForSessionMessage<T extends SessionWsServerMessage>(
    messages: readonly SessionWsServerMessage[],
    predicate: (message: SessionWsServerMessage) => message is T,
    timeoutMs = 2_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const match = messages.find(predicate);
        if (match !== undefined) {
            return match;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for session message. Received: ${JSON.stringify(messages)}`);
}

interface RegistryFixture {
    readonly root: string;
    readonly agentDir: string;
    readonly projectDir: string;
    readonly sessionDir: string;
    readonly catalog: SessionCatalog;
    readonly registry: SessionRegistry;
    readonly harness: FakeRuntimeHarness;
    readonly fakeWatch: FakeWatchHarness;
}

function createRegistryFixture(
    options: {
        readonly customLayout?: boolean;
        readonly useRealWatcher?: boolean;
        readonly usePolling?: boolean;
        readonly awaitWriteFinish?: boolean | AwaitWriteFinishOptions;
        readonly debounceMs?: number;
        readonly pollIntervalMs?: number;
        readonly onRealBackendReady?: () => void;
    } = {},
): RegistryFixture {
    const root = createTempDir("pivia-disk-sync-");
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    const sessionDir = join(root, "sessions");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const logger = createLogger({ level: "silent" });
    const catalog = new SessionCatalog({
        ...(options.customLayout === false ? {} : { sessionDir }),
        agentDir,
        cwd: root,
        env: {},
        logger,
    });
    const harness = createFakeRuntimeHarness();
    const fakeWatch = createFakeWatchHarness();
    const backendFactory: WatchBackendFactory | undefined =
        options.useRealWatcher === true
            ? options.onRealBackendReady === undefined
                ? undefined
                : (backendOptions) =>
                      createChokidarWatchBackend({
                          ...backendOptions,
                          onReady: () => {
                              backendOptions.onReady?.();
                              options.onRealBackendReady?.();
                          },
                      })
            : fakeWatch.factory;
    const registry = new SessionRegistry({
        catalog,
        logger,
        agentDir,
        runtimeFactory: harness.factory,
        idleTimeoutMs: 0,
        diskSync: {
            enabled: true,
            debounceMs: options.debounceMs ?? 10,
            pollIntervalMs: options.pollIntervalMs ?? 0,
            ...(options.usePolling === undefined ? {} : { usePolling: options.usePolling }),
            ...(options.awaitWriteFinish === undefined ? {} : { awaitWriteFinish: options.awaitWriteFinish }),
            ...(backendFactory === undefined ? {} : { backendFactory }),
        },
    });
    registries.push(registry);
    return {
        root,
        agentDir,
        projectDir,
        sessionDir,
        catalog,
        registry,
        harness,
        fakeWatch,
    };
}

function fakeSession(fixture: RegistryFixture, sessionId: SessionId): FakeSession {
    const runtime = fixture.harness.find(sessionId);
    if (runtime === undefined) {
        throw new Error(`Missing fake runtime for ${sessionId}`);
    }
    return runtime.session;
}

function bumpFileMtime(filePath: string, offsetMs = 5_000): void {
    const stats = statSync(filePath);
    const nextDate = new Date(stats.mtimeMs + offsetMs);
    utimesSync(filePath, nextDate, nextDate);
}

describe("disk-sync pure helpers", () => {
    describe("stampsEqual", () => {
        it("returns true when mtimeMs, ctimeMs, sizeBytes, and ino match", () => {
            const left: DiskFileStamp = {
                mtimeMs: 1_700_000_000_123,
                ctimeMs: 1_700_000_000_123,
                sizeBytes: 1024,
                ino: 42,
            };
            const right: DiskFileStamp = {
                mtimeMs: 1_700_000_000_123,
                ctimeMs: 1_700_000_000_123,
                sizeBytes: 1024,
                ino: 42,
            };
            expect(stampsEqual(left, right)).toBe(true);
        });

        it("returns false when mtimeMs, ctimeMs, sizeBytes, or ino differs", () => {
            const base: DiskFileStamp = {
                mtimeMs: 1_700_000_000_123,
                ctimeMs: 1_700_000_000_123,
                sizeBytes: 1024,
                ino: 42,
            };
            expect(stampsEqual(base, { ...base, mtimeMs: 1_700_000_000_124 })).toBe(false);
            expect(stampsEqual(base, { ...base, ctimeMs: 1_700_000_000_124 })).toBe(false);
            expect(stampsEqual(base, { ...base, sizeBytes: 2048 })).toBe(false);
            expect(stampsEqual(base, { ...base, ino: 43 })).toBe(false);
        });
    });

    describe("detectActiveDiskChange", () => {
        it("returns unchanged for ephemeral sessions regardless of disk entry", () => {
            const tracked: TrackedDiskFile = { kind: "ephemeral" };
            expect(detectActiveDiskChange(tracked, undefined)).toEqual({ kind: "unchanged" });
            expect(detectActiveDiskChange(tracked, makeDiskEntry("s-ephemeral"))).toEqual({ kind: "unchanged" });
        });

        it("returns unchanged for unflushed sessions without a disk file and modified if one appears", () => {
            const tracked: TrackedDiskFile = {
                kind: "unflushed",
                expectedPath: "/tmp/sessions/s-unflushed.jsonl",
            };
            expect(detectActiveDiskChange(tracked, undefined)).toEqual({ kind: "unchanged" });

            const diskEntry = makeDiskEntry("s-unflushed", {
                realPath: "/tmp/sessions/external-s-unflushed.jsonl",
            });
            expect(detectActiveDiskChange(tracked, diskEntry)).toEqual({
                kind: "modified",
                diskEntry,
            });
        });

        it("detects unchanged, modified (mtime, ctime, size, ino, realPath), and deleted for persisted sessions", () => {
            const tracked: TrackedDiskFile = {
                kind: "persisted",
                realPath: "/tmp/sessions/s-persisted.jsonl",
                stamp: { mtimeMs: 5_000, ctimeMs: 5_000, sizeBytes: 256, ino: 1 },
            };

            const identical = makeDiskEntry("s-persisted", {
                realPath: "/tmp/sessions/s-persisted.jsonl",
                mtimeMs: 5_000,
                ctimeMs: 5_000,
                sizeBytes: 256,
                ino: 1,
            });
            expect(detectActiveDiskChange(tracked, identical)).toEqual({ kind: "unchanged" });

            const changedMtime = makeDiskEntry("s-persisted", {
                realPath: "/tmp/sessions/s-persisted.jsonl",
                mtimeMs: 5_500,
                sizeBytes: 256,
            });
            expect(detectActiveDiskChange(tracked, changedMtime)).toEqual({
                kind: "modified",
                diskEntry: changedMtime,
            });

            const changedInode = makeDiskEntry("s-persisted", {
                realPath: "/tmp/sessions/s-persisted.jsonl",
                mtimeMs: 5_000,
                ctimeMs: 5_000,
                sizeBytes: 256,
                ino: 99,
            });
            expect(detectActiveDiskChange(tracked, changedInode)).toEqual({
                kind: "modified",
                diskEntry: changedInode,
            });

            const changedSize = makeDiskEntry("s-persisted", {
                realPath: "/tmp/sessions/s-persisted.jsonl",
                mtimeMs: 5_000,
                sizeBytes: 512,
            });
            expect(detectActiveDiskChange(tracked, changedSize)).toEqual({
                kind: "modified",
                diskEntry: changedSize,
            });

            const changedPath = makeDiskEntry("s-persisted", {
                realPath: "/tmp/sessions/s-persisted-relocated.jsonl",
                mtimeMs: 5_000,
                sizeBytes: 256,
            });
            expect(detectActiveDiskChange(tracked, changedPath)).toEqual({
                kind: "modified",
                diskEntry: changedPath,
            });

            expect(detectActiveDiskChange(tracked, undefined)).toEqual({ kind: "deleted" });
        });
    });

    describe("diffSessionSummaryForCatalog", () => {
        it("returns null when summaries are identical", () => {
            const summary = makeSummary("s-same", { name: "Session A" });
            expect(diffSessionSummaryForCatalog(summary, { ...summary })).toBeNull();
        });

        it("returns a minimal patch containing only changed mutable fields", () => {
            const previous = makeSummary("s-patch");
            const next = makeSummary("s-patch", {
                name: "Renamed",
                firstMessage: "Updated first message",
                messageCount: 3,
                modifiedAtMs: 9_000,
                runtimeState: "streaming",
                attachedClients: 2,
            });

            expect(diffSessionSummaryForCatalog(previous, next)).toEqual({
                op: "patch",
                id: previous.id,
                patch: {
                    name: "Renamed",
                    firstMessage: "Updated first message",
                    messageCount: 3,
                    modifiedAtMs: 9_000,
                    runtimeState: "streaming",
                    attachedClients: 2,
                },
            });

            const onlyCount = makeSummary("s-patch", { messageCount: 4 });
            expect(diffSessionSummaryForCatalog(previous, onlyCount)).toEqual({
                op: "patch",
                id: previous.id,
                patch: { messageCount: 4 },
            });
        });

        it("returns upsert when immutable fields change", () => {
            const base = makeSummary("s-immutable");

            const changedCwd = makeSummary("s-immutable", { cwd: "/tmp/other-project" });
            expect(diffSessionSummaryForCatalog(base, changedCwd)).toEqual({
                op: "upsert",
                item: changedCwd,
            });

            const changedCreated = makeSummary("s-immutable", { createdAtMs: 1_500 });
            expect(diffSessionSummaryForCatalog(base, changedCreated)).toEqual({
                op: "upsert",
                item: changedCreated,
            });

            const changedParent = makeSummary("s-immutable", { hasParent: true, name: "Forked" });
            expect(diffSessionSummaryForCatalog(base, changedParent)).toEqual({
                op: "upsert",
                item: changedParent,
            });
        });
    });

    describe("diffCatalogSnapshots", () => {
        it("emits upsert for new sessions, patch or upsert for changed sessions, and remove for deleted ones", () => {
            const sUnchanged = makeSummary("s-unchanged");
            const sPatchedPrev = makeSummary("s-patched", { messageCount: 1 });
            const sPatchedNext = makeSummary("s-patched", { messageCount: 2, modifiedAtMs: 4_000 });
            const sReplacedPrev = makeSummary("s-replaced", { cwd: "/tmp/one" });
            const sReplacedNext = makeSummary("s-replaced", { cwd: "/tmp/two" });
            const sRemoved = makeSummary("s-removed");
            const sAdded = makeSummary("s-added");

            const previous = new Map<SessionId, SessionSummary>([
                [sUnchanged.id, sUnchanged],
                [sPatchedPrev.id, sPatchedPrev],
                [sReplacedPrev.id, sReplacedPrev],
                [sRemoved.id, sRemoved],
            ]);
            const next = new Map<SessionId, SessionSummary>([
                [sUnchanged.id, { ...sUnchanged }],
                [sPatchedNext.id, sPatchedNext],
                [sReplacedNext.id, sReplacedNext],
                [sAdded.id, sAdded],
            ]);

            const deltas = diffCatalogSnapshots(previous, next);
            expect(deltas).toHaveLength(4);
            expect(deltas).toContainEqual({ op: "upsert", item: sAdded });
            expect(deltas).toContainEqual({
                op: "patch",
                id: sPatchedNext.id,
                patch: { messageCount: 2, modifiedAtMs: 4_000 },
            });
            expect(deltas).toContainEqual({ op: "upsert", item: sReplacedNext });
            expect(deltas).toContainEqual({ op: "remove", id: sRemoved.id });
        });

        it("suppresses remove deltas when suppressRemovals is true", () => {
            const sKept = makeSummary("s-kept");
            const sRemoved = makeSummary("s-removed");
            const previous = new Map<SessionId, SessionSummary>([
                [sKept.id, sKept],
                [sRemoved.id, sRemoved],
            ]);
            const next = new Map<SessionId, SessionSummary>([[sKept.id, { ...sKept }]]);

            expect(diffCatalogSnapshots(previous, next, { suppressRemovals: true })).toEqual([]);
        });
    });

    describe("mergeCatalogEntries", () => {
        it("overrides disk entries with active summaries, keeps unflushed active sessions, and sorts newest first", () => {
            const diskOlder = makeDiskEntry("s-disk-older", {
                summary: { modifiedAtMs: 1_000 },
            });
            const diskBackedByActive = makeDiskEntry("s-shared", {
                summary: { modifiedAtMs: 2_000, runtimeState: "idle", attachedClients: 0 },
            });
            const activeOverride = makeSummary("s-shared", {
                modifiedAtMs: 5_000,
                runtimeState: "streaming",
                attachedClients: 1,
            });
            const activeUnflushed = makeSummary("s-unflushed", {
                modifiedAtMs: 3_500,
                runtimeState: "idle",
            });

            const merged = mergeCatalogEntries([diskOlder, diskBackedByActive], [activeOverride, activeUnflushed]);

            expect(merged).toEqual([activeOverride, activeUnflushed, diskOlder.summary]);
        });
    });
});

describe("SessionCatalog.scan and SessionCatalog.resolveWatchTargets", () => {
    it("scans a custom flat root with stamps, canonical paths, and .jsonl watch target filtering", async () => {
        const root = createTempDir("pivia-catalog-flat-");
        const sessionDir = join(root, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        const filePath = join(sessionDir, "session-flat.jsonl");
        writeSessionFixture(filePath, "session-flat", {
            messages: [{ role: "user", text: "Hello flat" }],
            name: "Flat Session",
        });
        const expectedStats = statSync(filePath);
        const expectedRealPath = realpathSync(filePath);

        const catalog = new SessionCatalog({
            sessionDir,
            agentDir: join(root, "agent"),
            cwd: root,
            env: {},
            logger: createLogger({ level: "silent" }),
            nowMs: () => 42_000,
        });

        const scanned = await catalog.scan();
        expect(scanned.root.isCustom).toBe(true);
        expect(scanned.root.realDir).toBe(realpathSync(sessionDir));
        expect(scanned.updatedAtMs).toBe(42_000);
        expect(scanned.incomplete).toBe(false);
        expect(scanned.watchDirs).toContain(realpathSync(sessionDir));
        expect(scanned.entries).toHaveLength(1);
        expect(scanned.entries[0]).toMatchObject({
            realPath: expectedRealPath,
            stamp: {
                mtimeMs: expectedStats.mtimeMs,
                ctimeMs: expectedStats.ctimeMs,
                sizeBytes: expectedStats.size,
                ino: expectedStats.ino,
            },
            summary: {
                id: sid("session-flat"),
                name: "Flat Session",
                firstMessage: "Hello flat",
                messageCount: 1,
            },
        });

        const targets = await catalog.resolveWatchTargets();
        const dirTarget = targets.find(
            (target) => target.kind === "directory" && realpathSync(target.path) === realpathSync(sessionDir),
        );
        expect(dirTarget).toBeDefined();
        if (dirTarget?.kind === "directory" && dirTarget.filenameFilter !== undefined) {
            expect(dirTarget.filenameFilter("session-flat.jsonl")).toBe(true);
            expect(dirTarget.filenameFilter("notes.txt")).toBe(false);
        } else {
            expect(dirTarget?.kind === "directory" ? dirTarget.filenameFilter : undefined).toBeTypeOf("function");
        }
    });

    it("includes the hierarchical sessions root and project subdirectories, including newly created ones", async () => {
        const root = createTempDir("pivia-catalog-hier-");
        const agentDir = join(root, "agent");
        const sessionsRoot = join(agentDir, "sessions");
        const projectOneDir = defaultProjectSessionDir(sessionsRoot, "/tmp/project-one");
        mkdirSync(projectOneDir, { recursive: true });
        writeSessionFixture(join(projectOneDir, "s1.jsonl"), "session-one", {
            cwd: "/tmp/project-one",
            messages: [{ role: "user", text: "One" }],
        });

        const catalog = new SessionCatalog({
            agentDir,
            cwd: root,
            env: {},
            logger: createLogger({ level: "silent" }),
        });

        const initialTargets = await catalog.resolveWatchTargets();
        const initialDirs = initialTargets
            .filter((target): target is Extract<typeof target, { kind: "directory" }> => target.kind === "directory")
            .map((target) => realpathSync(target.path));
        expect(initialDirs).toContain(realpathSync(sessionsRoot));
        expect(initialDirs).toContain(realpathSync(projectOneDir));

        const projectTwoDir = defaultProjectSessionDir(sessionsRoot, "/tmp/project-two");
        mkdirSync(projectTwoDir, { recursive: true });
        writeSessionFixture(join(projectTwoDir, "s2.jsonl"), "session-two", {
            cwd: "/tmp/project-two",
            messages: [{ role: "user", text: "Two" }],
        });

        const scanned = await catalog.scan();
        expect(scanned.root.isCustom).toBe(false);
        expect(scanned.watchDirs.map((dir) => realpathSync(dir))).toEqual(
            expect.arrayContaining([
                realpathSync(sessionsRoot),
                realpathSync(projectOneDir),
                realpathSync(projectTwoDir),
            ]),
        );

        const updatedTargets = await catalog.resolveWatchTargets();
        const updatedDirs = updatedTargets
            .filter((target): target is Extract<typeof target, { kind: "directory" }> => target.kind === "directory")
            .map((target) => realpathSync(target.path));
        expect(updatedDirs).toContain(realpathSync(sessionsRoot));
        expect(updatedDirs).toContain(realpathSync(projectOneDir));
        expect(updatedDirs).toContain(realpathSync(projectTwoDir));
    });
});

describe("SessionRegistry disk synchronization", () => {
    it("publishes upsert, patch, and remove catalog deltas for external disk changes", async () => {
        const fixture = createRegistryFixture();
        const catalog = attachCatalogCollector(fixture.registry);
        await catalog.ready;

        const filePath = join(fixture.sessionDir, "external.jsonl");
        const sessionId = sid("session-external");

        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Created externally" }],
            name: "Initial Name",
        });
        await fixture.registry.reconcileDisk();

        const upsertDelta = await waitForCatalogDelta(
            catalog.frames,
            (delta) => delta.op === "upsert" && delta.item.id === sessionId,
        );
        expect(upsertDelta).toMatchObject({
            op: "upsert",
            item: {
                id: sessionId,
                name: "Initial Name",
                firstMessage: "Created externally",
                messageCount: 1,
            },
        });

        // Keep the header timestamp unchanged so immutable `createdAtMs` stays constant and the
        // external modification emits an incremental `patch` rather than a full `upsert`.
        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [
                { role: "user", text: "Created externally" },
                { role: "assistant", text: "External reply" },
            ],
            name: "Updated Name",
        });
        bumpFileMtime(filePath);
        await fixture.registry.reconcileDisk();

        const patchDelta = await waitForCatalogDelta(
            catalog.frames,
            (delta) => delta.op === "patch" && delta.id === sessionId && delta.patch.name === "Updated Name",
        );
        expect(patchDelta).toMatchObject({
            op: "patch",
            id: sessionId,
            patch: {
                name: "Updated Name",
                messageCount: 2,
            },
        });

        rmSync(filePath);
        await fixture.registry.reconcileDisk();

        const removeDelta = await waitForCatalogDelta(
            catalog.frames,
            (delta) => delta.op === "remove" && delta.id === sessionId,
        );
        expect(removeDelta).toEqual({ op: "remove", id: sessionId });
        await expect(fixture.catalog.resolveById(sessionId)).resolves.toEqual({ kind: "missing" });

        catalog.detach();
    });

    it("watches real filesystem writes with chokidar and publishes upsert to catalog subscribers", async () => {
        const backendReady = Promise.withResolvers<void>();
        const fixture = createRegistryFixture({
            useRealWatcher: true,
            debounceMs: 20,
            pollIntervalMs: 0,
            onRealBackendReady: () => {
                backendReady.resolve();
            },
        });
        const catalog = attachCatalogCollector(fixture.registry);
        await catalog.ready;
        await backendReady.promise;

        const sessionId = sid("session-real-watch");
        const filePath = join(fixture.sessionDir, "real-watch.jsonl");
        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Watched from real fs.watch" }],
            name: "Real Watch",
        });

        const delta = await waitForCatalogDelta(
            catalog.frames,
            (candidate) => candidate.op === "upsert" && candidate.item.id === sessionId,
            3_000,
        );
        expect(delta).toMatchObject({
            op: "upsert",
            item: {
                id: sessionId,
                name: "Real Watch",
                firstMessage: "Watched from real fs.watch",
            },
        });

        catalog.detach();
    });

    it("evicts an idle clientless ActiveSession when its disk file is modified externally", async () => {
        const fixture = createRegistryFixture();
        const sessionId = sid("session-idle-evict");
        const filePath = join(fixture.sessionDir, "idle-evict.jsonl");
        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Before edit" }],
            name: "Before",
        });

        await fixture.registry.open(sessionId);
        await waitForRuntimeState(fixture.registry, sessionId, "idle");
        const firstRuntime = fixture.harness.find(sessionId);
        expect(firstRuntime).toBeDefined();
        expect(fixture.registry.activeSessionCount).toBe(1);

        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            timestamp: "2026-04-01T00:10:00.000Z",
            messages: [
                { role: "user", text: "Before edit" },
                { role: "assistant", text: "Added externally" },
            ],
            name: "After",
        });
        bumpFileMtime(filePath);

        await fixture.registry.reconcileDisk();

        expect(firstRuntime?.disposeCalls).toBe(1);
        expect(fixture.registry.activeSessionCount).toBe(0);

        const detail = await fixture.registry.getById(sessionId);
        expect(detail?.session).toMatchObject({
            id: sessionId,
            name: "After",
            messageCount: 2,
        });
        expect(detail?.entries).toHaveLength(4);

        const reopened = await fixture.registry.open(sessionId);
        await waitForRuntimeState(fixture.registry, sessionId, "idle");
        expect(fixture.harness.runtimes).toHaveLength(2);
        expect(reopened.session.getEntries()).toHaveLength(4);
    });

    it("closes attached clients with goingAway (1001) and disposes runtime on external file modification", async () => {
        const fixture = createRegistryFixture();
        const sessionId = sid("session-client-reload");
        const filePath = join(fixture.sessionDir, "client-reload.jsonl");
        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Original" }],
        });

        await fixture.registry.open(sessionId);
        await waitForRuntimeState(fixture.registry, sessionId, "idle");
        const runtime = fixture.harness.find(sessionId);
        const collector = createSessionClientCollector();
        fixture.registry.attach(sessionId, collector.client);

        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            timestamp: "2026-04-01T00:15:00.000Z",
            messages: [
                { role: "user", text: "Original" },
                { role: "assistant", text: "External update" },
            ],
        });
        bumpFileMtime(filePath);

        await fixture.registry.reconcileDisk();

        expect(collector.closes).toHaveLength(1);
        expect(collector.closes[0]?.code).toBe(WS_CLOSE_CODE.goingAway);
        expect(runtime?.disposeCalls).toBe(1);
        expect(fixture.registry.activeSessionCount).toBe(0);

        await fixture.registry.open(sessionId);
        await waitForRuntimeState(fixture.registry, sessionId, "idle");
        const reconnected = createSessionClientCollector();
        const attachment = fixture.registry.attach(sessionId, reconnected.client);
        const snapshot = await waitForSessionMessage(
            reconnected.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:snapshot" }> =>
                message.type === "sync:snapshot",
        );
        expect(snapshot.snapshot.entries.mode).toBe("inline");
        if (snapshot.snapshot.entries.mode === "inline") {
            expect(snapshot.snapshot.entries.data).toHaveLength(3);
        }
        attachment.detach();
    });

    it("closes attached clients with sessionNotFound (4404) and removes catalog entry when open session file is deleted", async () => {
        const fixture = createRegistryFixture();
        const sessionId = sid("session-deleted-open");
        const filePath = join(fixture.sessionDir, "deleted-open.jsonl");
        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Will disappear" }],
        });

        const catalog = attachCatalogCollector(fixture.registry);
        await catalog.ready;

        await fixture.registry.open(sessionId);
        await waitForRuntimeState(fixture.registry, sessionId, "idle");
        const runtime = fixture.harness.find(sessionId);
        const collector = createSessionClientCollector();
        fixture.registry.attach(sessionId, collector.client);

        rmSync(filePath);
        await fixture.registry.reconcileDisk();

        expect(collector.closes).toHaveLength(1);
        expect(collector.closes[0]?.code).toBe(SESSION_CLOSE_CODE.sessionNotFound);
        expect(runtime?.disposeCalls).toBe(1);
        expect(fixture.registry.activeSessionCount).toBe(0);

        const removeDelta = await waitForCatalogDelta(
            catalog.frames,
            (delta) => delta.op === "remove" && delta.id === sessionId,
        );
        expect(removeDelta).toEqual({ op: "remove", id: sessionId });
        catalog.detach();
    });

    it("defers external reload while streaming until agent_settled", async () => {
        const fixture = createRegistryFixture();
        const sessionId = sid("session-busy-streaming");
        const filePath = join(fixture.sessionDir, "busy-streaming.jsonl");
        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Initial" }],
        });

        await fixture.registry.open(sessionId);
        await waitForRuntimeState(fixture.registry, sessionId, "idle");
        const session = fakeSession(fixture, sessionId);
        const runtime = fixture.harness.find(sessionId);
        const collector = createSessionClientCollector();
        fixture.registry.attach(sessionId, collector.client);

        session.setState({ isStreaming: true });
        session.emit({ type: "agent_start" });

        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            timestamp: "2026-04-01T00:20:00.000Z",
            messages: [
                { role: "user", text: "Initial" },
                { role: "assistant", text: "External change during stream" },
            ],
        });
        bumpFileMtime(filePath);
        await fixture.registry.reconcileDisk();

        expect(runtime?.disposeCalls).toBe(0);
        expect(collector.closes).toHaveLength(0);
        expect(fixture.registry.activeSessionCount).toBe(1);

        session.setState({ isStreaming: false });
        session.emit({ type: "agent_end", messages: [], willRetry: false });
        session.emit({ type: "agent_settled", aborted: false });

        await waitUntil(
            () =>
                (runtime?.disposeCalls ?? 0) === 1 &&
                collector.closes.length === 1 &&
                fixture.registry.activeSessionCount === 0,
        );
        expect(collector.closes[0]?.code).toBe(WS_CLOSE_CODE.goingAway);
        expect(fixture.registry.activeSessionCount).toBe(0);
    });

    it("defers external reload while compacting until compaction_end", async () => {
        const fixture = createRegistryFixture();
        const sessionId = sid("session-busy-compacting");
        const filePath = join(fixture.sessionDir, "busy-compacting.jsonl");
        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Initial" }],
        });

        await fixture.registry.open(sessionId);
        await waitForRuntimeState(fixture.registry, sessionId, "idle");
        const session = fakeSession(fixture, sessionId);
        const runtime = fixture.harness.find(sessionId);
        const collector = createSessionClientCollector();
        fixture.registry.attach(sessionId, collector.client);

        session.setState({ isCompacting: true });
        session.emit({ type: "compaction_start", reason: "manual" });

        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            timestamp: "2026-04-01T00:25:00.000Z",
            messages: [
                { role: "user", text: "Initial" },
                { role: "assistant", text: "External change during compaction" },
            ],
        });
        bumpFileMtime(filePath);
        await fixture.registry.reconcileDisk();

        expect(runtime?.disposeCalls).toBe(0);
        expect(collector.closes).toHaveLength(0);
        expect(fixture.registry.activeSessionCount).toBe(1);

        session.setState({ isCompacting: false });
        session.emit({
            type: "compaction_end",
            reason: "manual",
            result: undefined,
            aborted: false,
            willRetry: false,
        });

        await waitUntil(
            () =>
                (runtime?.disposeCalls ?? 0) === 1 &&
                collector.closes.length === 1 &&
                fixture.registry.activeSessionCount === 0,
        );
        expect(collector.closes[0]?.code).toBe(WS_CLOSE_CODE.goingAway);
        expect(fixture.registry.activeSessionCount).toBe(0);
    });

    it("defers external reload while a UI dialog is pending until it resolves", async () => {
        const fixture = createRegistryFixture();
        const sessionId = sid("session-busy-ui");
        const filePath = join(fixture.sessionDir, "busy-ui.jsonl");
        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Initial" }],
        });

        await fixture.registry.open(sessionId);
        await waitForRuntimeState(fixture.registry, sessionId, "idle");
        const session = fakeSession(fixture, sessionId);
        const runtime = fixture.harness.find(sessionId);
        const collector = createSessionClientCollector();
        const attachment: SessionAttachment = fixture.registry.attach(sessionId, collector.client);

        const ui = session.bindings?.uiContext;
        if (ui === undefined) {
            throw new Error("Expected extension UI bindings");
        }
        const confirmed = ui.confirm("Proceed?", "Confirm action");
        const uiRequest = await waitForSessionMessage(
            collector.messages,
            (message): message is Extract<SessionWsServerMessage, { type: "sync:delta" }> =>
                message.type === "sync:delta" && message.delta.kind === "ui_request",
        );
        if (uiRequest.delta.kind !== "ui_request") {
            throw new Error("Expected ui_request delta");
        }

        writeSessionFixture(filePath, sessionId, {
            cwd: fixture.projectDir,
            timestamp: "2026-04-01T00:30:00.000Z",
            messages: [
                { role: "user", text: "Initial" },
                { role: "assistant", text: "External change during dialog" },
            ],
        });
        bumpFileMtime(filePath);
        await fixture.registry.reconcileDisk();

        expect(runtime?.disposeCalls).toBe(0);
        expect(collector.closes).toHaveLength(0);
        expect(fixture.registry.activeSessionCount).toBe(1);

        await attachment.handleMessage({
            type: "rpc:ui_response",
            response: {
                type: "extension_ui_response",
                id: uiRequest.delta.request.id,
                confirmed: true,
            },
        });
        await expect(confirmed).resolves.toBe(true);

        await waitUntil(
            () =>
                (runtime?.disposeCalls ?? 0) === 1 &&
                collector.closes.length === 1 &&
                fixture.registry.activeSessionCount === 0,
        );
        expect(collector.closes[0]?.code).toBe(WS_CLOSE_CODE.goingAway);
        expect(fixture.registry.activeSessionCount).toBe(0);
    });

    it("suppresses self-writes made through SessionManager on opened and newly flushed sessions", async () => {
        const fixture = createRegistryFixture();
        const scanSpy = vi.spyOn(fixture.catalog, "scan");

        // 1. Opened persisted session receiving a Pivia SessionManager write.
        const persistedId = sid("session-self-persisted");
        const persistedPath = join(fixture.sessionDir, "self-persisted.jsonl");
        writeSessionFixture(persistedPath, persistedId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Seed" }],
        });

        await fixture.registry.open(persistedId);
        await waitForRuntimeState(fixture.registry, persistedId, "idle");
        const persistedRuntime = fixture.harness.find(persistedId);
        const persistedSession = fakeSession(fixture, persistedId);
        const persistedCollector = createSessionClientCollector();
        const persistedAttachment = fixture.registry.attach(persistedId, persistedCollector.client);

        persistedSession.appendUserMessage("Self write on opened session");
        await fixture.registry.reconcileDisk();
        const scansBeforePersistedEvent = scanSpy.mock.calls.length;
        fixture.fakeWatch.trigger(fixture.sessionDir, "change", basename(persistedPath));
        await waitUntil(() => scanSpy.mock.calls.length > scansBeforePersistedEvent);
        await fixture.registry.reconcileDisk();

        expect(persistedRuntime?.disposeCalls).toBe(0);
        expect(persistedCollector.closes).toHaveLength(0);
        expect(fixture.registry.activeSessionCount).toBe(1);

        // 2. Newly created session flushing its initial file on first conversation message.
        const created = await fixture.registry.createSession(fixture.projectDir);
        await waitForRuntimeState(fixture.registry, created.sessionId, "idle");
        const createdRuntime = fixture.harness.find(created.sessionId);
        const createdSession = fakeSession(fixture, created.sessionId);
        const createdCollector = createSessionClientCollector();
        const createdAttachment = fixture.registry.attach(created.sessionId, createdCollector.client);

        createdSession.appendUserMessage("First prompt flushing file");
        await fixture.registry.reconcileDisk();

        const createdInput = fixture.harness.inputs.find(
            (input) => input.sessionManager.getSessionId() === created.sessionId,
        );
        const flushedFile = createdInput?.sessionManager.getSessionFile();
        if (flushedFile !== undefined) {
            const scansBeforeFlushedEvent = scanSpy.mock.calls.length;
            fixture.fakeWatch.trigger(fixture.sessionDir, "add", basename(flushedFile));
            await waitUntil(() => scanSpy.mock.calls.length > scansBeforeFlushedEvent);
            await fixture.registry.reconcileDisk();
        }

        expect(createdRuntime?.disposeCalls).toBe(0);
        expect(createdCollector.closes).toHaveLength(0);
        expect(fixture.registry.activeSessionCount).toBe(2);

        persistedAttachment.detach();
        createdAttachment.detach();
    });

    it("stops the disk watcher on disposeAll so later external writes emit no errors or catalog updates", async () => {
        const fixture = createRegistryFixture();
        const frames: WorkspaceWsServerMessage[] = [];
        const errors: unknown[] = [];
        const catalogReady = Promise.withResolvers<void>();

        const detach = fixture.registry.attachCatalog({
            sendRaw(raw) {
                const frame = JSON.parse(raw) as WorkspaceWsServerMessage;
                frames.push(frame);
                if (frame.type === "sync:snapshot") {
                    catalogReady.resolve();
                }
            },
            close() {},
        });
        await catalogReady.promise;
        await fixture.registry.reconcileDisk();

        expect(fixture.fakeWatch.handles.length).toBeGreaterThan(0);
        expect(fixture.fakeWatch.activeCount()).toBeGreaterThan(0);

        const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
            errors.push(args);
        });
        try {
            await fixture.registry.disposeAll();
            expect(fixture.fakeWatch.activeCount()).toBe(0);
            expect(fixture.fakeWatch.handles.every((handle) => handle.closed)).toBe(true);

            vi.useFakeTimers();
            const frameCountAtDispose = frames.length;
            writeSessionFixture(join(fixture.sessionDir, "after-dispose.jsonl"), "session-after-dispose", {
                cwd: fixture.projectDir,
                messages: [{ role: "user", text: "Late write" }],
            });

            await vi.advanceTimersByTimeAsync(5_000);
            expect(frames).toHaveLength(frameCountAtDispose);
            expect(errors).toEqual([]);
        } finally {
            errorSpy.mockRestore();
            detach();
        }
    });

    it("does not report active sessions as deleted when temporarily unreadable on disk, and suppresses remove deltas on incomplete scans", async () => {
        const fixture = createRegistryFixture();
        const catalogCollector = attachCatalogCollector(fixture.registry);
        await catalogCollector.ready;

        const activeId = sid("session-unreadable-active");
        const activePath = join(fixture.sessionDir, "active.jsonl");
        writeSessionFixture(activePath, activeId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Keep open during rewrite" }],
        });

        const closedId = sid("session-hidden-during-partial-scan");
        const closedPath = join(fixture.sessionDir, "closed.jsonl");
        writeSessionFixture(closedPath, closedId, {
            cwd: fixture.projectDir,
            messages: [{ role: "user", text: "Closed session" }],
        });

        await fixture.registry.reconcileDisk();
        await waitForCatalogDelta(
            catalogCollector.frames,
            (delta) => delta.op === "upsert" && delta.item.id === closedId,
        );

        await fixture.registry.open(activeId);
        await waitForRuntimeState(fixture.registry, activeId, "idle");
        const collector = createSessionClientCollector();
        const attachment = fixture.registry.attach(activeId, collector.client);

        // Simulate a partial/truncated rewrite: file is empty on disk (still exists -> stat succeeds),
        // and scan() omits both active & closed sessions while reporting `incomplete: true`.
        writeFileSync(activePath, "", "utf8");
        const realScan = fixture.catalog.scan.bind(fixture.catalog);
        const scanSpy = vi.spyOn(fixture.catalog, "scan").mockResolvedValueOnce({
            root: (await realScan()).root,
            entries: [],
            watchDirs: [realpathSync(fixture.sessionDir)],
            incomplete: true,
            updatedAtMs: Date.now(),
        });

        const frameCountBeforeIncomplete = catalogCollector.frames.length;
        await fixture.registry.reconcileDisk();
        expect(scanSpy).toHaveBeenCalledTimes(1);

        expect(collector.closes).toHaveLength(0);
        expect(fixture.registry.activeSessionCount).toBe(1);
        const emittedRemovals = catalogCollector.frames
            .slice(frameCountBeforeIncomplete)
            .filter((frame) => frame.type === "sync:delta" && frame.delta.op === "remove");
        expect(emittedRemovals).toEqual([]);

        // Once the file is actually unlinked and a clean scan completes, both active close and remove delta fire.
        scanSpy.mockRestore();
        rmSync(activePath);
        rmSync(closedPath);
        await fixture.registry.reconcileDisk();

        await waitUntil(() => collector.closes.length === 1 && fixture.registry.activeSessionCount === 0);
        expect(collector.closes[0]?.code).toBe(SESSION_CLOSE_CODE.sessionNotFound);
        await waitForCatalogDelta(catalogCollector.frames, (delta) => delta.op === "remove" && delta.id === closedId);

        attachment.detach();
        catalogCollector.detach();
    });

    it("marks scan incomplete on unreadable directories while treating missing roots as complete", async () => {
        const root = createTempDir("pivia-catalog-incomplete-");
        const missingDir = join(root, "missing-sessions");
        const catalog = new SessionCatalog({
            sessionDir: missingDir,
            agentDir: join(root, "agent"),
            cwd: root,
            env: {},
            logger: createLogger({ level: "silent" }),
        });

        const missingScan = await catalog.scan();
        expect(missingScan.incomplete).toBe(false);
        expect(missingScan.entries).toEqual([]);

        if (process.getuid?.() !== 0) {
            const lockedDir = join(root, "locked-sessions");
            mkdirSync(lockedDir, { recursive: true });
            chmodSync(lockedDir, 0o000);
            try {
                const lockedCatalog = new SessionCatalog({
                    sessionDir: lockedDir,
                    agentDir: join(root, "agent"),
                    cwd: root,
                    env: {},
                    logger: createLogger({ level: "silent" }),
                });
                const lockedScan = await lockedCatalog.scan();
                expect(lockedScan.incomplete).toBe(true);
            } finally {
                chmodSync(lockedDir, 0o755);
            }
        }
    });

    it("forwards usePolling and awaitWriteFinish options, reuses scan targets without re-walking, and enables diskSync by default", async () => {
        const root = createTempDir("pivia-registry-options-");
        const agentDir = join(root, "agent");
        const sessionsRoot = join(agentDir, "sessions");
        mkdirSync(sessionsRoot, { recursive: true });

        const catalog = new SessionCatalog({
            agentDir,
            cwd: root,
            env: {},
            logger: createLogger({ level: "silent" }),
        });
        const resolveSpy = vi.spyOn(catalog, "resolveWatchTargets");
        const scanSpy = vi.spyOn(catalog, "scan");
        const fakeWatch = createFakeWatchHarness();
        const harness = createFakeRuntimeHarness();

        const registry = new SessionRegistry({
            catalog,
            logger: createLogger({ level: "silent" }),
            agentDir,
            runtimeFactory: harness.factory,
            idleTimeoutMs: 0,
            diskSync: {
                enabled: true,
                debounceMs: 10,
                pollIntervalMs: 0,
                usePolling: true,
                awaitWriteFinish: { stabilityThresholdMs: 120, pollIntervalMs: 30 },
                backendFactory: fakeWatch.factory,
            },
        });
        registries.push(registry);

        await waitUntil(() => scanSpy.mock.calls.length >= 1);
        expect(resolveSpy).toHaveBeenCalledTimes(1);
        expect(fakeWatch.handles[0]?.options).toMatchObject({
            usePolling: true,
            awaitWriteFinish: { stabilityThresholdMs: 120, pollIntervalMs: 30 },
        });

        // Creating a new project directory updates watched paths during reconcile without calling resolveWatchTargets again.
        const projectDir = defaultProjectSessionDir(sessionsRoot, "/tmp/new-proj");
        mkdirSync(projectDir, { recursive: true });
        await registry.reconcileDisk();

        expect(resolveSpy).toHaveBeenCalledTimes(1);
        expect(scanSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        const watched = new Set(
            fakeWatch.handles.flatMap((handle) => [...handle.watchedPaths].map((p) => realpathSync(p))),
        );
        expect(watched.has(realpathSync(projectDir))).toBe(true);

        // Verify omitted `diskSync` defaults to enabled on SessionRegistry.
        const defaultCatalog = new SessionCatalog({
            agentDir,
            cwd: root,
            env: {},
            logger: createLogger({ level: "silent" }),
        });
        const defaultScanSpy = vi.spyOn(defaultCatalog, "scan");
        const defaultRegistry = new SessionRegistry({
            catalog: defaultCatalog,
            logger: createLogger({ level: "silent" }),
            agentDir,
            runtimeFactory: harness.factory,
            idleTimeoutMs: 0,
        });
        registries.push(defaultRegistry);
        await waitUntil(() => defaultScanSpy.mock.calls.length >= 1);
    });
});
