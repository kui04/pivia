import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createChokidarWatchBackend,
    DiskWatcher,
    classifyWatchError,
    normalizePathKey,
    type DiskWatcherLogger,
    type WatchBackend,
    type WatchBackendEvent,
    type WatchBackendFactory,
    type WatchBackendOptions,
    type WatchTriggerReason,
} from "./watcher.ts";

interface FakeBackendRecord {
    readonly options: WatchBackendOptions;
    readonly watchedPaths: Set<string>;
    readonly addCalls: Array<readonly string[]>;
    readonly unwatchCalls: Array<readonly string[]>;
    readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    closed: boolean;
}

interface FakeBackendHarness {
    readonly backendFactory: WatchBackendFactory;
    readonly records: FakeBackendRecord[];
    openRecords(): FakeBackendRecord[];
    emitEvent(event: WatchBackendEvent): void;
    emitError(error: unknown): void;
}

function createErrnoError(code: string, message = code, filePath?: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(message);
    error.code = code;
    if (filePath !== undefined) {
        error.path = filePath;
    }
    return error;
}

function createDeferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createFakeBackendHarness(): FakeBackendHarness {
    const records: FakeBackendRecord[] = [];

    const backendFactory: WatchBackendFactory = (options) => {
        const watchedPaths = new Set<string>();
        const addCalls: Array<readonly string[]> = [];
        const unwatchCalls: Array<readonly string[]> = [];

        const record: FakeBackendRecord = {
            options,
            watchedPaths,
            addCalls,
            unwatchCalls,
            closed: false,
            close: vi.fn<() => Promise<void>>(() => {
                record.closed = true;
                watchedPaths.clear();
                return Promise.resolve();
            }),
        };

        const backend: WatchBackend = {
            add(paths) {
                addCalls.push([...paths]);
                for (const p of paths) {
                    watchedPaths.add(p);
                }
            },
            unwatch(paths) {
                unwatchCalls.push([...paths]);
                for (const p of paths) {
                    watchedPaths.delete(p);
                }
            },
            close: record.close,
        };

        records.push(record);
        return backend;
    };

    function openRecords(): FakeBackendRecord[] {
        return records.filter((entry) => !entry.closed);
    }

    return {
        backendFactory,
        records,
        openRecords,
        emitEvent(event) {
            for (const entry of openRecords()) {
                entry.options.onEvent(event);
            }
        },
        emitError(error) {
            for (const entry of openRecords()) {
                entry.options.onError(error);
            }
        },
    };
}

function createFakeLogger(): {
    logger: DiskWatcherLogger;
    warnings: Array<{ record: Record<string, unknown>; message: string }>;
} {
    const warnings: Array<{ record: Record<string, unknown>; message: string }> = [];
    const logger: DiskWatcherLogger = {
        warn(record, message) {
            warnings.push({ record, message });
        },
    };
    return { logger, warnings };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
}

describe("watcher boundary helpers", () => {
    it("normalizes path keys across separators and dot segments with platform case semantics", () => {
        expect(normalizePathKey("/var/pi/../sessions/", "linux")).toBe(normalizePathKey("/var/sessions", "linux"));
        expect(normalizePathKey("/var/./sessions", "linux")).toBe(normalizePathKey("/var/sessions", "linux"));
        expect(normalizePathKey("/var/Sessions", "linux")).not.toBe(normalizePathKey("/var/sessions", "linux"));

        expect(normalizePathKey("C:\\Users\\Alice\\..\\Sessions/", "win32")).toBe(
            normalizePathKey("c:/users/sessions", "win32"),
        );
        expect(normalizePathKey("C:\\Users\\Sessions", "win32")).toBe(normalizePathKey("c:\\users\\sessions", "win32"));
    });

    it("classifies watcher errors into missing, permission_or_busy, watch_limit, and unexpected", () => {
        expect(classifyWatchError(createErrnoError("ENOENT"))).toBe("missing");
        expect(classifyWatchError(createErrnoError("ENOTDIR"))).toBe("missing");

        expect(classifyWatchError(createErrnoError("EPERM"))).toBe("permission_or_busy");
        expect(classifyWatchError(createErrnoError("EACCES"))).toBe("permission_or_busy");
        expect(classifyWatchError(createErrnoError("EBUSY"))).toBe("permission_or_busy");

        expect(classifyWatchError(createErrnoError("ENOSPC"))).toBe("watch_limit");
        expect(classifyWatchError(createErrnoError("EMFILE"))).toBe("watch_limit");

        expect(classifyWatchError(createErrnoError("EIO"))).toBe("unexpected");
        expect(classifyWatchError(new Error("unknown failure"))).toBe("unexpected");
        expect(classifyWatchError("plain string error")).toBe("unexpected");
        expect(classifyWatchError(null)).toBe("unexpected");
    });
});

describe("DiskWatcher", () => {
    const watchers: DiskWatcher[] = [];
    const tempDirs: string[] = [];

    afterEach(async () => {
        try {
            let watcher = watchers.pop();
            while (watcher !== undefined) {
                await watcher.dispose();
                watcher = watchers.pop();
            }
        } finally {
            // Restore spied globals before resetting fake timers so a spy created under fake timers
            // never restores a stale fake `setTimeout` over the real global timer.
            vi.restoreAllMocks();
            vi.useRealTimers();
            let dir = tempDirs.pop();
            while (dir !== undefined) {
                rmSync(dir, { recursive: true, force: true });
                dir = tempDirs.pop();
            }
        }
    });

    it("runs initial startup reconcile, adds target paths, and makes start() idempotent", async () => {
        vi.useFakeTimers();
        const harness = createFakeBackendHarness();
        const reconcileReasons: Array<ReadonlySet<WatchTriggerReason>> = [];

        const watcher = new DiskWatcher({
            resolveTargets: () => [
                { kind: "directory", path: "/root/sessions" },
                { kind: "directory", path: "/root/logs" },
            ],
            onReconcile: (reasons) => {
                reconcileReasons.push(new Set(reasons));
            },
            pollIntervalMs: 0,
            backendFactory: harness.backendFactory,
        });
        watchers.push(watcher);

        watcher.start();
        watcher.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(reconcileReasons).toHaveLength(1);
        expect(reconcileReasons[0]?.has("startup")).toBe(true);
        expect(watcher.activeWatchCount).toBe(2);
        expect(harness.openRecords()).toHaveLength(1);
        expect(harness.openRecords()[0]?.watchedPaths).toEqual(new Set(["/root/sessions", "/root/logs"]));
    });

    it("coalesces rapid fs_event bursts within debounceMs into a single fs_event reconcile", async () => {
        vi.useFakeTimers();
        const harness = createFakeBackendHarness();
        const reconcileReasons: Array<ReadonlySet<WatchTriggerReason>> = [];

        const watcher = new DiskWatcher({
            resolveTargets: () => [{ kind: "directory", path: "/root/sessions" }],
            onReconcile: (reasons) => {
                reconcileReasons.push(new Set(reasons));
            },
            debounceMs: 100,
            pollIntervalMs: 0,
            backendFactory: harness.backendFactory,
        });
        watchers.push(watcher);

        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(reconcileReasons).toHaveLength(1);

        harness.emitEvent({ event: "add", path: "/root/sessions/a.jsonl" });
        await vi.advanceTimersByTimeAsync(20);
        harness.emitEvent({ event: "change", path: "/root/sessions/b.jsonl" });
        await vi.advanceTimersByTimeAsync(20);
        harness.emitEvent({ event: "unlink", path: "/root/sessions/c.jsonl" });

        expect(reconcileReasons).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(100);
        expect(reconcileReasons).toHaveLength(2);
        expect(Array.from(reconcileReasons[1] ?? [])).toEqual(["fs_event"]);
    });

    it("enforces depth 0 filenameFilter and supports recursive directory targets for future extensions", async () => {
        vi.useFakeTimers();
        const harness = createFakeBackendHarness();
        const onReconcile = vi.fn<(reasons: ReadonlySet<WatchTriggerReason>) => void>();

        const watcher = new DiskWatcher({
            resolveTargets: () => [
                {
                    kind: "directory",
                    path: "/root/sessions",
                    depth: 0,
                    filenameFilter: (filename) => filename.endsWith(".jsonl"),
                },
                {
                    kind: "directory",
                    path: "/root/skills",
                    depth: "recursive",
                    filenameFilter: (filename) => filename.endsWith(".md"),
                },
            ],
            onReconcile,
            debounceMs: 50,
            pollIntervalMs: 0,
            backendFactory: harness.backendFactory,
        });
        watchers.push(watcher);

        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        onReconcile.mockClear();

        // Non-matching files and nested subfiles under depth: 0 directory are ignored.
        harness.emitEvent({ event: "change", path: "/root/sessions/notes.txt" });
        harness.emitEvent({ event: "add", path: "/root/sessions/nested/sub.jsonl" });
        harness.emitEvent({ event: "change", path: "/root/skills/skill-a/notes.txt" });
        await vi.advanceTimersByTimeAsync(100);
        expect(onReconcile).not.toHaveBeenCalled();

        // Matching direct file in sessions triggers reconcile.
        harness.emitEvent({ event: "add", path: "/root/sessions/session-1.jsonl" });
        await vi.advanceTimersByTimeAsync(100);
        expect(onReconcile).toHaveBeenCalledTimes(1);

        // Recursive skill file in nested folder triggers reconcile.
        harness.emitEvent({ event: "change", path: "/root/skills/skill-a/SKILL.md" });
        await vi.advanceTimersByTimeAsync(100);
        expect(onReconcile).toHaveBeenCalledTimes(2);
    });

    it("matches file targets with platform-aware path normalization and forwards chokidar options", async () => {
        vi.useFakeTimers();
        const linuxHarness = createFakeBackendHarness();
        const linuxReconcile = vi.fn<(reasons: ReadonlySet<WatchTriggerReason>) => void>();

        const linuxWatcher = new DiskWatcher({
            resolveTargets: () => [{ kind: "file", path: "/var/pi/sessions.json" }],
            onReconcile: linuxReconcile,
            debounceMs: 50,
            pollIntervalMs: 0,
            awaitWriteFinish: { stabilityThresholdMs: 150, pollIntervalMs: 50 },
            followSymlinks: false,
            usePolling: true,
            platform: "linux",
            backendFactory: linuxHarness.backendFactory,
        });
        watchers.push(linuxWatcher);

        linuxWatcher.start();
        await vi.advanceTimersByTimeAsync(0);
        linuxReconcile.mockClear();

        expect(linuxHarness.openRecords()[0]?.options).toMatchObject({
            depth: 0,
            followSymlinks: false,
            usePolling: true,
            awaitWriteFinish: { stabilityThresholdMs: 150, pollIntervalMs: 50 },
        });

        linuxHarness.emitEvent({ event: "change", path: "/var/pi/other.json" });
        await vi.advanceTimersByTimeAsync(100);
        expect(linuxReconcile).not.toHaveBeenCalled();

        linuxHarness.emitEvent({ event: "change", path: "/var/pi/sessions.json" });
        await vi.advanceTimersByTimeAsync(100);
        expect(linuxReconcile).toHaveBeenCalledTimes(1);

        const winHarness = createFakeBackendHarness();
        const winReconcile = vi.fn<(reasons: ReadonlySet<WatchTriggerReason>) => void>();
        const winWatcher = new DiskWatcher({
            resolveTargets: () => [{ kind: "file", path: "C:\\Pi\\Auth.json" }],
            onReconcile: winReconcile,
            debounceMs: 50,
            pollIntervalMs: 0,
            platform: "win32",
            backendFactory: winHarness.backendFactory,
        });
        watchers.push(winWatcher);

        winWatcher.start();
        await vi.advanceTimersByTimeAsync(0);
        winReconcile.mockClear();

        winHarness.emitEvent({ event: "change", path: "c:/pi/auth.json" });
        await vi.advanceTimersByTimeAsync(100);
        expect(winReconcile).toHaveBeenCalledTimes(1);
    });

    it("unwatches removed paths when resolveTargets shrinks", async () => {
        vi.useFakeTimers();
        const harness = createFakeBackendHarness();
        let activeTargets = ["/root/a", "/root/b"];

        const watcher = new DiskWatcher({
            resolveTargets: () => activeTargets.map((path) => ({ kind: "directory" as const, path })),
            onReconcile: () => {},
            debounceMs: 25,
            pollIntervalMs: 0,
            backendFactory: harness.backendFactory,
        });
        watchers.push(watcher);

        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(watcher.activeWatchCount).toBe(2);

        activeTargets = ["/root/a"];
        watcher.trigger("manual");
        await vi.advanceTimersByTimeAsync(50);

        expect(watcher.activeWatchCount).toBe(1);
        expect(harness.openRecords()[0]?.unwatchCalls).toContainEqual(["/root/b"]);
    });

    it("closes backend with backoff on backend-wide EPERM, EBUSY, or ENOSPC and isolates failing path targets", async () => {
        vi.useFakeTimers();
        for (const code of ["EPERM", "EBUSY", "ENOSPC"] as const) {
            const harness = createFakeBackendHarness();
            const { logger, warnings } = createFakeLogger();

            const watcher = new DiskWatcher({
                resolveTargets: () => [{ kind: "directory", path: `/root/${code.toLowerCase()}` }],
                onReconcile: () => {},
                debounceMs: 25,
                pollIntervalMs: 0,
                backendFactory: harness.backendFactory,
                logger,
            });
            watchers.push(watcher);

            watcher.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(watcher.activeWatchCount).toBe(1);

            const record = harness.openRecords()[0];
            expect(() => {
                harness.emitError(createErrnoError(code));
            }).not.toThrow();
            await vi.advanceTimersByTimeAsync(0);

            expect(record?.close).toHaveBeenCalledTimes(1);
            expect(watcher.activeWatchCount).toBe(0);
            expect(warnings.length).toBeGreaterThanOrEqual(1);

            // Reconciling within the profile cooldown does not recreate and immediately tear down a new backend.
            watcher.trigger("manual");
            await vi.advanceTimersByTimeAsync(50);
            expect(harness.records).toHaveLength(1);
            expect(watcher.activeWatchCount).toBe(0);

            // Once the cooldown expires, a subsequent reconcile attempts to watch the profile again.
            await vi.advanceTimersByTimeAsync(35_000);
            watcher.trigger("manual");
            await vi.advanceTimersByTimeAsync(50);
            expect(harness.records).toHaveLength(2);
            expect(watcher.activeWatchCount).toBe(1);
        }

        // A path-scoped permission error drops only the failing directory without closing sibling targets.
        const scopedHarness = createFakeBackendHarness();
        const { logger: scopedLogger } = createFakeLogger();
        const scopedReconcile = vi.fn<(reasons: ReadonlySet<WatchTriggerReason>) => void>();
        const scopedWatcher = new DiskWatcher({
            resolveTargets: () => [
                { kind: "directory", path: "/root/good" },
                { kind: "directory", path: "/root/bad" },
            ],
            onReconcile: scopedReconcile,
            debounceMs: 25,
            pollIntervalMs: 0,
            backendFactory: scopedHarness.backendFactory,
            logger: scopedLogger,
        });
        watchers.push(scopedWatcher);

        scopedWatcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(scopedWatcher.activeWatchCount).toBe(2);
        scopedReconcile.mockClear();

        const scopedRecord = scopedHarness.openRecords()[0];
        scopedHarness.emitError(createErrnoError("EACCES", "permission denied", "/root/bad"));
        await vi.advanceTimersByTimeAsync(0);

        expect(scopedRecord?.close).not.toHaveBeenCalled();
        expect(scopedRecord?.unwatchCalls).toContainEqual(["/root/bad"]);
        expect(scopedWatcher.activeWatchCount).toBe(1);
        expect(scopedRecord?.watchedPaths).toEqual(new Set(["/root/good"]));

        // Reconcile within cooldown keeps `/root/bad` blocked while events under `/root/good` keep working.
        scopedWatcher.trigger("manual");
        await vi.advanceTimersByTimeAsync(50);
        expect(scopedWatcher.activeWatchCount).toBe(1);

        scopedHarness.emitEvent({ event: "change", path: "/root/good/session.jsonl" });
        await vi.advanceTimersByTimeAsync(50);
        expect(scopedReconcile).toHaveBeenCalledTimes(2);
    });

    it("skips re-resolving targets when onReconcile provides updated targets or preserves current targets", async () => {
        vi.useFakeTimers();
        const harness = createFakeBackendHarness();
        const resolveTargets = vi.fn(() => [{ kind: "directory" as const, path: "/root/initial" }]);
        let step = 0;

        const watcher = new DiskWatcher({
            resolveTargets,
            onReconcile: (_reasons, sync) => {
                step += 1;
                if (step === 2) {
                    sync?.setTargets([
                        { kind: "directory", path: "/root/initial" },
                        { kind: "directory", path: "/root/added" },
                    ]);
                } else if (step === 3) {
                    sync?.preserveTargets();
                }
            },
            debounceMs: 25,
            pollIntervalMs: 0,
            backendFactory: harness.backendFactory,
        });
        watchers.push(watcher);

        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(resolveTargets).toHaveBeenCalledTimes(1);
        expect(watcher.activeWatchCount).toBe(1);

        watcher.trigger("manual");
        await vi.advanceTimersByTimeAsync(50);
        expect(resolveTargets).toHaveBeenCalledTimes(1);
        expect(watcher.activeWatchCount).toBe(2);

        watcher.trigger("manual");
        await vi.advanceTimersByTimeAsync(50);
        expect(resolveTargets).toHaveBeenCalledTimes(1);
        expect(watcher.activeWatchCount).toBe(2);
    });

    it("caps watched paths at maxWatchers and logs a warning", async () => {
        vi.useFakeTimers();
        const harness = createFakeBackendHarness();
        const { logger, warnings } = createFakeLogger();

        const watcher = new DiskWatcher({
            resolveTargets: () => [
                { kind: "directory", path: "/root/d1" },
                { kind: "directory", path: "/root/d2" },
                { kind: "directory", path: "/root/d3" },
                { kind: "directory", path: "/root/d4" },
            ],
            onReconcile: () => {},
            maxWatchers: 2,
            pollIntervalMs: 0,
            backendFactory: harness.backendFactory,
            logger,
        });
        watchers.push(watcher);

        watcher.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(watcher.activeWatchCount).toBe(2);
        expect(harness.openRecords()[0]?.watchedPaths.size).toBe(2);
        expect(warnings.length).toBeGreaterThanOrEqual(1);
    });

    it("enforces single-flight reconcile and runs one follow-up pass for events arriving mid-flight", async () => {
        vi.useFakeTimers();
        const harness = createFakeBackendHarness();
        const secondPassBarrier = createDeferred();
        const recordedReasons: Array<ReadonlySet<WatchTriggerReason>> = [];
        let callIndex = 0;
        let inFlight = 0;
        let maxInFlight = 0;

        const watcher = new DiskWatcher({
            resolveTargets: () => [{ kind: "directory", path: "/root/sessions" }],
            onReconcile: async (reasons) => {
                callIndex += 1;
                const currentCall = callIndex;
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                recordedReasons.push(new Set(reasons));
                try {
                    if (currentCall === 2) {
                        await secondPassBarrier.promise;
                    }
                } finally {
                    inFlight -= 1;
                }
            },
            debounceMs: 50,
            pollIntervalMs: 0,
            backendFactory: harness.backendFactory,
        });
        watchers.push(watcher);

        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(callIndex).toBe(1);

        harness.emitEvent({ event: "change", path: "/root/sessions/first.jsonl" });
        await vi.advanceTimersByTimeAsync(60);
        expect(callIndex).toBe(2);
        expect(inFlight).toBe(1);

        harness.emitEvent({ event: "change", path: "/root/sessions/during-1.jsonl" });
        harness.emitEvent({ event: "add", path: "/root/sessions/during-2.jsonl" });
        await vi.advanceTimersByTimeAsync(200);

        expect(callIndex).toBe(2);
        expect(inFlight).toBe(1);

        secondPassBarrier.resolve();
        await vi.advanceTimersByTimeAsync(100);

        expect(callIndex).toBe(3);
        expect(maxInFlight).toBe(1);
        expect(recordedReasons[2]?.has("fs_event")).toBe(true);
    });

    it("closes backends, unrefs timers, clears timers, and awaits in-flight reconcile on dispose()", async () => {
        vi.useFakeTimers();
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
        const harness = createFakeBackendHarness();
        const reconcileBarrier = createDeferred();
        let reconcileCount = 0;

        const watcher = new DiskWatcher({
            resolveTargets: () => [{ kind: "directory", path: "/root/sessions" }],
            onReconcile: async () => {
                reconcileCount += 1;
                if (reconcileCount === 2) {
                    await reconcileBarrier.promise;
                }
            },
            debounceMs: 50,
            pollIntervalMs: 1000,
            backendFactory: harness.backendFactory,
        });
        watchers.push(watcher);

        watcher.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(reconcileCount).toBe(1);

        const openBackend = harness.openRecords()[0];
        harness.emitEvent({ event: "change", path: "/root/sessions/active.jsonl" });

        for (const result of [...setTimeoutSpy.mock.results, ...setIntervalSpy.mock.results]) {
            if (result.type === "return") {
                const timer = result.value as { hasRef?: () => boolean };
                if (typeof timer.hasRef === "function") {
                    expect(timer.hasRef()).toBe(false);
                }
            }
        }

        await vi.advanceTimersByTimeAsync(60);
        expect(reconcileCount).toBe(2);

        harness.emitEvent({ event: "change", path: "/root/sessions/queued.jsonl" });

        let disposeResolved = false;
        const disposePromise = watcher.dispose().then(() => {
            disposeResolved = true;
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(watcher.isDisposed).toBe(true);
        expect(disposeResolved).toBe(false);
        expect(openBackend?.close).toHaveBeenCalledTimes(1);
        expect(watcher.activeWatchCount).toBe(0);

        reconcileBarrier.resolve();
        await disposePromise;
        expect(disposeResolved).toBe(true);

        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(reconcileCount).toBe(2);
    });

    it("handles dispose() before start(), duplicate dispose(), and ignores post-dispose calls", async () => {
        vi.useFakeTimers();
        const harness = createFakeBackendHarness();
        const onReconcile = vi.fn<(reasons: ReadonlySet<WatchTriggerReason>) => void>();

        const preStartWatcher = new DiskWatcher({
            resolveTargets: () => [{ kind: "directory", path: "/root/never" }],
            onReconcile,
            pollIntervalMs: 1000,
            backendFactory: harness.backendFactory,
        });
        watchers.push(preStartWatcher);

        await preStartWatcher.dispose();
        await preStartWatcher.dispose();
        expect(preStartWatcher.isDisposed).toBe(true);

        preStartWatcher.start();
        preStartWatcher.trigger("manual");
        await vi.advanceTimersByTimeAsync(5000);

        expect(onReconcile).not.toHaveBeenCalled();
        expect(harness.records).toHaveLength(0);
        expect(preStartWatcher.activeWatchCount).toBe(0);

        const startedWatcher = new DiskWatcher({
            resolveTargets: () => [{ kind: "directory", path: "/root/started" }],
            onReconcile,
            debounceMs: 50,
            pollIntervalMs: 1000,
            backendFactory: harness.backendFactory,
        });
        watchers.push(startedWatcher);

        startedWatcher.start();
        await vi.advanceTimersByTimeAsync(0);
        onReconcile.mockClear();

        const firstBackend = harness.records[0];
        await startedWatcher.dispose();
        await startedWatcher.dispose();
        startedWatcher.trigger("manual");
        firstBackend?.options.onEvent({ event: "change", path: "/root/started/late.jsonl" });
        await vi.advanceTimersByTimeAsync(5000);

        expect(onReconcile).not.toHaveBeenCalled();
        expect(startedWatcher.activeWatchCount).toBe(0);
    });

    it("watches a real directory via chokidar for .jsonl creation, modification, deletion, and missing root creation", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "pivia-chokidar-watcher-")));
        tempDirs.push(root);
        const sessionDir = join(root, "sessions");

        const fsEvents: Array<ReadonlySet<WatchTriggerReason>> = [];
        let startupSeen = false;
        const backendReady = createDeferred();

        const watcher = new DiskWatcher({
            resolveTargets: () => [
                {
                    kind: "directory",
                    path: sessionDir,
                    depth: 0,
                    filenameFilter: (filename) => filename.endsWith(".jsonl"),
                },
            ],
            onReconcile: (reasons) => {
                if (reasons.has("startup")) {
                    startupSeen = true;
                }
                if (reasons.has("fs_event")) {
                    fsEvents.push(new Set(reasons));
                }
            },
            debounceMs: 25,
            pollIntervalMs: 0,
            backendFactory: (backendOptions) =>
                createChokidarWatchBackend({
                    ...backendOptions,
                    onReady: () => {
                        backendOptions.onReady?.();
                        backendReady.resolve();
                    },
                }),
        });
        watchers.push(watcher);

        watcher.start();
        await waitForCondition(() => startupSeen && watcher.activeWatchCount === 1);
        await backendReady.promise;

        mkdirSync(sessionDir, { recursive: true });
        await waitForCondition(() => fsEvents.length >= 1);

        const sessionFile = join(sessionDir, "session-1.jsonl");
        const countBeforeCreate = fsEvents.length;
        writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");
        await waitForCondition(() => fsEvents.length > countBeforeCreate);

        const countBeforeModify = fsEvents.length;
        appendFileSync(sessionFile, '{"type":"message"}\n', "utf8");
        await waitForCondition(() => fsEvents.length > countBeforeModify);

        const countBeforeDelete = fsEvents.length;
        unlinkSync(sessionFile);
        await waitForCondition(() => fsEvents.length > countBeforeDelete);

        await watcher.dispose();
        expect(watcher.isDisposed).toBe(true);
        expect(watcher.activeWatchCount).toBe(0);
    });
});
