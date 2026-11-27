import { watch as chokidarWatch, type ChokidarOptions, type FSWatcher as ChokidarFSWatcher } from "chokidar";
import { posix, win32 } from "node:path";

/** Reason a disk watcher reconciliation pass was scheduled. */
export type WatchTriggerReason = "startup" | "fs_event" | "poll" | "manual";

/**
 * Target on disk monitored by {@link DiskWatcher}.
 *
 * File targets are matched through their parent directory watch so atomic write-and-rename
 * replacements and deletions continue firing events across Linux, macOS, and Windows.
 */
export type WatchTarget =
    | {
          readonly kind: "directory";
          readonly path: string;
          /** Maximum subdirectory traversal depth (`0` = direct children only; `"recursive"` = unbounded). Defaults to `0`. */
          readonly depth?: number | "recursive" | undefined;
          /** Optional basename filter; omitted matches any changed entry. */
          readonly filenameFilter?: ((filename: string) => boolean) | undefined;
      }
    | {
          readonly kind: "file";
          readonly path: string;
      };

/** Fine-grained write stabilization options passed through to `chokidar`. */
export interface AwaitWriteFinishOptions {
    /** Time in milliseconds a file size must remain unchanged before emitting; defaults to chokidar's 2000 ms. */
    readonly stabilityThresholdMs?: number | undefined;
    /** Polling interval in milliseconds while checking size stability; defaults to chokidar's 100 ms. */
    readonly pollIntervalMs?: number | undefined;
}

/** Normalized filesystem event emitted by a {@link WatchBackend}. */
export type WatchBackendEventName = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

/** Event payload delivered from a {@link WatchBackend} to {@link DiskWatcher}. */
export interface WatchBackendEvent {
    readonly event: WatchBackendEventName;
    readonly path: string;
}

/** Configuration passed to a {@link WatchBackendFactory} for one watch profile. */
export interface WatchBackendOptions {
    /** Directory traversal depth (`0` = direct children; `undefined` = recursive). */
    readonly depth?: number | undefined;
    readonly followSymlinks: boolean;
    readonly usePolling: boolean;
    readonly pollIntervalMs: number;
    readonly awaitWriteFinish: boolean | AwaitWriteFinishOptions;
    readonly onEvent: (event: WatchBackendEvent) => void;
    readonly onError: (error: unknown) => void;
    /** Optional callback invoked once the underlying backend finishes attaching initial watches. */
    readonly onReady?: (() => void) | undefined;
}

/** Optional hooks passed to `onReconcile` so callers can hand off targets without re-walking disk. */
export interface ReconcileSyncControls {
    /** Replace desired watch targets for this reconcile pass instead of calling `resolveTargets`. */
    setTargets(targets: readonly WatchTarget[]): void;
    /** Keep the active watch targets untouched (for example after an incomplete disk scan). */
    preserveTargets(): void;
}

/** Pluggable low-level watch backend (defaults to `chokidar`). */
export interface WatchBackend {
    add(paths: readonly string[]): void;
    unwatch(paths: readonly string[]): void;
    close(): Promise<void>;
}

/** Factory creating one {@link WatchBackend} instance per distinct traversal depth profile. */
export type WatchBackendFactory = (options: WatchBackendOptions) => WatchBackend;

/** Structured logger contract used by {@link DiskWatcher}. */
export interface DiskWatcherLogger {
    warn(record: Record<string, unknown>, message: string): void;
}

/** Cross-platform error classification for watcher creation and runtime error events. */
export type WatchErrorKind = "missing" | "permission_or_busy" | "watch_limit" | "unexpected";

/** Options for constructing {@link DiskWatcher}. */
export interface DiskWatcherOptions {
    /** Return the current set of disk targets to watch. Called on startup and when `onReconcile` does not update targets. */
    readonly resolveTargets: () => Promise<readonly WatchTarget[]> | readonly WatchTarget[];
    /** Called sequentially (never overlapping) after coalesced disk changes or fallback polls. */
    readonly onReconcile: (
        reasons: ReadonlySet<WatchTriggerReason>,
        sync?: ReconcileSyncControls,
    ) => Promise<void> | void;
    /** Debounce window in milliseconds for coalescing filesystem event bursts; defaults to 100 ms. */
    readonly debounceMs?: number | undefined;
    /** Fallback polling interval in milliseconds (`0` disables polling); defaults to 5000 ms. */
    readonly pollIntervalMs?: number | undefined;
    /** Maximum simultaneous watched paths; defaults to 256. */
    readonly maxWatchers?: number | undefined;
    /** Whether to follow symbolic links inside watched directories; defaults to `true`. */
    readonly followSymlinks?: boolean | undefined;
    /** Force stat-based polling in the underlying watcher; defaults to `false`. */
    readonly usePolling?: boolean | undefined;
    /** Wait for chunked writes to stabilize before triggering reconcile; defaults to `false`. */
    readonly awaitWriteFinish?: boolean | AwaitWriteFinishOptions | undefined;
    /** Target OS platform for path-matching semantics; defaults to `process.platform`. */
    readonly platform?: NodeJS.Platform | undefined;
    /** Clock used for backend error cooldown calculations; defaults to `Date.now`. */
    readonly nowMs?: (() => number) | undefined;
    /** Injectable {@link WatchBackendFactory} for deterministic testing; defaults to `chokidar`. */
    readonly backendFactory?: WatchBackendFactory | undefined;
    /** Optional logger for watch-limit or permission warnings. */
    readonly logger?: DiskWatcherLogger | undefined;
}

/**
 * Single-flight reconciliation sub-state while {@link DiskWatcher} is running.
 *
 * Prevents overlapping scans while guaranteeing that events arriving during an active scan trigger
 * one follow-up pass once it settles.
 */
export type WatcherSyncPhase =
    | { readonly kind: "idle" }
    | {
          readonly kind: "debouncing";
          readonly timer: NodeJS.Timeout;
          readonly reasons: Set<WatchTriggerReason>;
      }
    | {
          readonly kind: "running";
          readonly promise: Promise<void>;
          readonly rerunRequested: boolean;
          readonly rerunReasons: Set<WatchTriggerReason>;
      };

type DepthProfileKey = `depth:${number}` | "depth:recursive";

interface BackendGroup {
    readonly profileKey: DepthProfileKey;
    readonly backend: WatchBackend;
    readonly watchedPaths: Map<string, string>;
}

interface ErrorCooldown {
    readonly untilMs: number;
    readonly failures: number;
}

interface NormalizedTarget {
    readonly key: string;
    readonly watchPath: string;
    readonly profileKey: DepthProfileKey;
    readonly depth: number | undefined;
    readonly matchesEvent: (event: WatchBackendEvent, changedKey: string, changedParentKey: string) => boolean;
}

/** Lifecycle state machine of {@link DiskWatcher}. */
export type WatcherLifecycle =
    | { readonly kind: "idle" }
    | {
          readonly kind: "running";
          syncPhase: WatcherSyncPhase;
          initialSyncDone: boolean;
          readonly backends: Map<DepthProfileKey, BackendGroup>;
          readonly targets: Map<string, NormalizedTarget>;
          readonly blockedPaths: Map<string, ErrorCooldown>;
          readonly profileCooldowns: Map<DepthProfileKey, ErrorCooldown>;
          readonly pollTimer: NodeJS.Timeout | undefined;
      }
    | { readonly kind: "disposing"; readonly done: Promise<void> }
    | { readonly kind: "disposed" };

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WATCHERS = 256;
const INITIAL_ERROR_COOLDOWN_MS = 30_000;
const MAX_ERROR_COOLDOWN_MS = 300_000;

function toChokidarAwaitWriteFinish(
    setting: boolean | AwaitWriteFinishOptions,
): NonNullable<ChokidarOptions["awaitWriteFinish"]> {
    if (typeof setting === "boolean") {
        return setting;
    }
    return {
        ...(setting.stabilityThresholdMs === undefined ? {} : { stabilityThreshold: setting.stabilityThresholdMs }),
        ...(setting.pollIntervalMs === undefined ? {} : { pollInterval: setting.pollIntervalMs }),
    };
}

/** Default production backend powered by `chokidar` v5. */
export const createChokidarWatchBackend: WatchBackendFactory = (options) => {
    const chokidarOptions: ChokidarOptions = {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: options.followSymlinks,
        usePolling: options.usePolling,
        ...(options.usePolling && options.pollIntervalMs > 0 ? { interval: options.pollIntervalMs } : {}),
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        // Let `DiskWatcher`'s debounce window coalesce atomic saves without delaying unlinks by 100 ms.
        atomic: false,
        // Ignore unreadable nested subdirectories inside watched roots so one restricted subfolder
        // does not fail the entire directory watch profile.
        ignorePermissionErrors: true,
        awaitWriteFinish: toChokidarAwaitWriteFinish(options.awaitWriteFinish),
    };

    const requestedDirs = new Map<string, string>();
    const watcher: ChokidarFSWatcher = chokidarWatch([], chokidarOptions);
    watcher.on("all", (event, changedPath) => {
        if (watcher.closed) {
            return;
        }
        switch (event) {
            case "add":
            case "addDir":
            case "change":
            case "unlink":
            case "unlinkDir":
                if (event === "addDir" && options.depth !== undefined) {
                    const key = normalizePathKey(changedPath);
                    const registeredPath = requestedDirs.get(key);
                    if (registeredPath !== undefined) {
                        // When a previously missing target directory is created, chokidar's internal
                        // parent-fallback detects it at depth + 1 (> options.depth) without watching
                        // its children; re-adding the directory promotes it to depth 0.
                        watcher.unwatch(registeredPath);
                        watcher.add(registeredPath);
                    }
                }
                options.onEvent({ event, path: changedPath });
                break;
            default:
                break;
        }
    });
    watcher.on("ready", () => {
        if (!watcher.closed) {
            options.onReady?.();
        }
    });
    watcher.on("error", (error) => {
        options.onError(error);
    });

    return {
        add(paths) {
            if (paths.length > 0 && !watcher.closed) {
                for (const p of paths) {
                    requestedDirs.set(normalizePathKey(p), p);
                }
                watcher.add([...paths]);
            }
        },
        unwatch(paths) {
            if (paths.length > 0 && !watcher.closed) {
                for (const p of paths) {
                    requestedDirs.delete(normalizePathKey(p));
                }
                watcher.unwatch([...paths]);
            }
        },
        close() {
            requestedDirs.clear();
            return watcher.close();
        },
    };
};

function pathApiFor(platform: NodeJS.Platform) {
    return platform === "win32" ? win32 : posix;
}

function stripTrailingSeparators(normalized: string, platform: NodeJS.Platform): string {
    if (platform === "win32") {
        // Keep drive roots like `c:\` or UNC roots intact while trimming trailing slashes on subpaths.
        if (normalized.length <= 3 && /^[a-z]:\\$/i.test(normalized)) {
            return normalized;
        }
        return normalized.replace(/[\\/]+$/, "");
    }
    return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

function errorCodeOf(error: unknown): string | undefined {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
        return error.code;
    }
    return undefined;
}

function errorPathOf(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) {
        return undefined;
    }
    if ("path" in error && typeof error.path === "string" && error.path.length > 0) {
        return error.path;
    }
    if ("filename" in error && typeof error.filename === "string" && error.filename.length > 0) {
        return error.filename;
    }
    return undefined;
}

function nextErrorCooldown(previousFailures: number, now: number): ErrorCooldown {
    const failures = previousFailures + 1;
    const delay = Math.min(MAX_ERROR_COOLDOWN_MS, INITIAL_ERROR_COOLDOWN_MS * 2 ** (failures - 1));
    return { untilMs: now + delay, failures };
}

function isKeyWithin(parentKey: string, childKey: string, platform: NodeJS.Platform): boolean {
    if (parentKey === childKey) {
        return true;
    }
    const pathApi = pathApiFor(platform);
    const rel = pathApi.relative(parentKey, childKey);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

function profileKeyForDepth(depth: number | undefined): DepthProfileKey {
    return depth === undefined ? "depth:recursive" : `depth:${depth}`;
}

/** Normalize a filesystem path into a map key respecting platform case sensitivity. */
export function normalizePathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
    if (platform === "win32") {
        const normalized = win32.normalize(filePath.replace(/\//g, "\\"));
        return stripTrailingSeparators(normalized, platform).toLowerCase();
    }
    const normalized = posix.normalize(filePath.replace(/\\/g, "/"));
    return stripTrailingSeparators(normalized, platform);
}

/** Classify watcher errors across Linux, macOS, and Windows so transient or missing paths never crash. */
export function classifyWatchError(error: unknown): WatchErrorKind {
    switch (errorCodeOf(error)) {
        case "ENOENT":
        case "ENOTDIR":
            return "missing";
        case "EPERM":
        case "EACCES":
        case "EBUSY":
            return "permission_or_busy";
        case "ENOSPC":
        case "EMFILE":
            return "watch_limit";
        default:
            return "unexpected";
    }
}

/**
 * Cross-platform, resource-bounded disk watcher backed by `chokidar`, adding debouncing,
 * single-flight reconciliation, target-level filtering, and deterministic async disposal.
 */
export class DiskWatcher {
    private readonly options: DiskWatcherOptions;
    private readonly debounceMs: number;
    private readonly pollIntervalMs: number;
    private readonly maxWatchers: number;
    private readonly followSymlinks: boolean;
    private readonly usePolling: boolean;
    private readonly awaitWriteFinish: boolean | AwaitWriteFinishOptions;
    private readonly platform: NodeJS.Platform;
    private readonly nowMs: () => number;
    private readonly backendFactory: WatchBackendFactory;
    private readonly logger: DiskWatcherLogger | undefined;
    private lifecycle: WatcherLifecycle = { kind: "idle" };
    private watchLimitWarned = false;

    constructor(options: DiskWatcherOptions) {
        this.options = options;
        const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        if (!Number.isFinite(debounceMs) || debounceMs < 0) {
            throw new RangeError("DiskWatcher debounceMs must be a non-negative finite number.");
        }
        const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
            throw new RangeError("DiskWatcher pollIntervalMs must be a non-negative finite number.");
        }
        const maxWatchers = options.maxWatchers ?? DEFAULT_MAX_WATCHERS;
        if (!Number.isSafeInteger(maxWatchers) || maxWatchers < 0) {
            throw new RangeError("DiskWatcher maxWatchers must be a non-negative integer.");
        }

        this.debounceMs = debounceMs;
        this.pollIntervalMs = pollIntervalMs;
        this.maxWatchers = maxWatchers;
        this.followSymlinks = options.followSymlinks ?? true;
        this.usePolling = options.usePolling ?? false;
        this.awaitWriteFinish = options.awaitWriteFinish ?? false;
        this.platform = options.platform ?? process.platform;
        this.nowMs = options.nowMs ?? Date.now;
        this.backendFactory = options.backendFactory ?? createChokidarWatchBackend;
        this.logger = options.logger;
    }

    /** Number of currently registered watch paths across active backends. */
    get activeWatchCount(): number {
        if (this.lifecycle.kind !== "running") {
            return 0;
        }
        let total = 0;
        for (const group of this.lifecycle.backends.values()) {
            total += group.watchedPaths.size;
        }
        return total;
    }

    /** True once {@link dispose} has been initiated or completed. */
    get isDisposed(): boolean {
        return this.lifecycle.kind === "disposing" || this.lifecycle.kind === "disposed";
    }

    /** Start watching targets and run the initial reconciliation pass. Idempotent when running or disposed. */
    start(): void {
        if (this.lifecycle.kind !== "idle") {
            return;
        }
        const pollTimer =
            this.pollIntervalMs > 0
                ? setInterval(() => {
                      this.trigger("poll");
                  }, this.pollIntervalMs)
                : undefined;
        pollTimer?.unref();

        this.lifecycle = {
            kind: "running",
            syncPhase: { kind: "idle" },
            initialSyncDone: false,
            backends: new Map(),
            targets: new Map(),
            blockedPaths: new Map(),
            profileCooldowns: new Map(),
            pollTimer,
        };
        this.startReconcile(new Set<WatchTriggerReason>(["startup"]));
    }

    /** Schedule a debounced reconciliation pass (coalesced across rapid filesystem bursts). */
    trigger(reason: WatchTriggerReason = "manual"): void {
        if (this.lifecycle.kind !== "running") {
            return;
        }
        this.scheduleSync(reason);
    }

    /**
     * Close all underlying watcher backends, clear timers, and await any in-flight reconciliation
     * before resolving. Safe to call multiple times or before {@link start}.
     */
    dispose(): Promise<void> {
        switch (this.lifecycle.kind) {
            case "idle":
                this.lifecycle = { kind: "disposed" };
                return Promise.resolve();
            case "disposed":
                return Promise.resolve();
            case "disposing":
                return this.lifecycle.done;
            case "running": {
                const running = this.lifecycle;
                if (running.pollTimer !== undefined) {
                    clearInterval(running.pollTimer);
                }
                let inFlight: Promise<void> | undefined;
                if (running.syncPhase.kind === "debouncing") {
                    clearTimeout(running.syncPhase.timer);
                } else if (running.syncPhase.kind === "running") {
                    inFlight = running.syncPhase.promise;
                }

                const closePromises: Array<Promise<void>> = [];
                for (const group of running.backends.values()) {
                    closePromises.push(
                        group.backend.close().catch((error: unknown) => {
                            this.logger?.warn({ err: error }, "failed to close disk watch backend");
                        }),
                    );
                }
                running.backends.clear();
                running.targets.clear();
                running.blockedPaths.clear();
                running.profileCooldowns.clear();

                const allSettled = Promise.all([inFlight ?? Promise.resolve(), Promise.all(closePromises)]).then(() => {
                    this.lifecycle = { kind: "disposed" };
                });
                this.lifecycle = { kind: "disposing", done: allSettled };
                return allSettled;
            }
        }
    }

    private runningLifecycle(): Extract<WatcherLifecycle, { readonly kind: "running" }> | null {
        return this.lifecycle.kind === "running" ? this.lifecycle : null;
    }

    private armDebounceTimer(reasons: Set<WatchTriggerReason>): void {
        const timer = setTimeout(() => {
            if (this.lifecycle.kind !== "running" || this.lifecycle.syncPhase.kind !== "debouncing") {
                return;
            }
            const collected = this.lifecycle.syncPhase.reasons;
            this.lifecycle.syncPhase = { kind: "idle" };
            this.startReconcile(collected);
        }, this.debounceMs);
        timer.unref();
        if (this.lifecycle.kind === "running") {
            this.lifecycle.syncPhase = { kind: "debouncing", timer, reasons };
        }
    }

    private scheduleSync(reason: WatchTriggerReason): void {
        if (this.lifecycle.kind !== "running") {
            return;
        }
        const phase = this.lifecycle.syncPhase;
        switch (phase.kind) {
            case "idle": {
                if (this.debounceMs === 0) {
                    this.startReconcile(new Set<WatchTriggerReason>([reason]));
                    return;
                }
                this.armDebounceTimer(new Set<WatchTriggerReason>([reason]));
                return;
            }
            case "debouncing": {
                phase.reasons.add(reason);
                clearTimeout(phase.timer);
                this.armDebounceTimer(phase.reasons);
                return;
            }
            case "running": {
                phase.rerunReasons.add(reason);
                this.lifecycle.syncPhase = {
                    ...phase,
                    rerunRequested: true,
                };
                return;
            }
        }
    }

    private startReconcile(reasons: Set<WatchTriggerReason>): void {
        if (this.lifecycle.kind !== "running") {
            return;
        }
        const promise = this.executeReconcile(reasons);
        this.lifecycle.syncPhase = {
            kind: "running",
            promise,
            rerunRequested: false,
            rerunReasons: new Set(),
        };
    }

    private async executeReconcile(reasons: Set<WatchTriggerReason>): Promise<void> {
        try {
            const runningAtStart = this.runningLifecycle();
            if (runningAtStart === null) {
                return;
            }
            const shouldPreSync = reasons.has("startup") || !runningAtStart.initialSyncDone;
            if (shouldPreSync) {
                await this.syncWatchers();
                const runningAfterPreSync = this.runningLifecycle();
                if (runningAfterPreSync === null) {
                    return;
                }
                runningAfterPreSync.initialSyncDone = true;
            }

            type TargetSyncAction =
                | { readonly kind: "use_resolved" }
                | { readonly kind: "set"; readonly targets: readonly WatchTarget[] }
                | { readonly kind: "preserve" };
            let pendingAction: TargetSyncAction = { kind: "use_resolved" };
            const currentAction = (): TargetSyncAction => pendingAction;
            const controls: ReconcileSyncControls = {
                setTargets(targets) {
                    pendingAction = { kind: "set", targets };
                },
                preserveTargets() {
                    pendingAction = { kind: "preserve" };
                },
            };

            try {
                await this.options.onReconcile(reasons, controls);
            } catch (error) {
                this.logger?.warn({ err: error }, "disk watcher reconcile failed");
            }
            if (this.runningLifecycle() === null) {
                return;
            }

            const nextSync = currentAction();
            switch (nextSync.kind) {
                case "set":
                    await this.syncWatchers(nextSync.targets);
                    break;
                case "preserve":
                    break;
                case "use_resolved":
                    if (!shouldPreSync) {
                        await this.syncWatchers();
                    }
                    break;
            }
        } finally {
            if (this.lifecycle.kind === "running" && this.lifecycle.syncPhase.kind === "running") {
                const { rerunRequested, rerunReasons } = this.lifecycle.syncPhase;
                this.lifecycle.syncPhase = { kind: "idle" };
                if (rerunRequested) {
                    this.startReconcile(rerunReasons);
                }
            }
        }
    }

    private normalizeTarget(target: WatchTarget): NormalizedTarget {
        const pathApi = pathApiFor(this.platform);
        if (target.kind === "file") {
            const targetKey = normalizePathKey(target.path, this.platform);
            const parentDir = pathApi.dirname(target.path);
            const parentKey = normalizePathKey(parentDir, this.platform);
            return {
                key: `file:${targetKey}`,
                watchPath: target.path,
                profileKey: profileKeyForDepth(0),
                depth: 0,
                matchesEvent: (_event, changedKey, changedParentKey) =>
                    changedKey === targetKey || (changedKey === parentKey && changedParentKey !== parentKey),
            };
        }

        const depth = target.depth === "recursive" ? undefined : (target.depth ?? 0);
        const targetKey = normalizePathKey(target.path, this.platform);
        const filter = target.filenameFilter;
        return {
            key: `dir:${profileKeyForDepth(depth)}:${targetKey}`,
            watchPath: target.path,
            profileKey: profileKeyForDepth(depth),
            depth,
            matchesEvent: (event, changedKey, changedParentKey) => {
                if (depth === 0) {
                    if (changedKey === targetKey) {
                        return true;
                    }
                    if (changedParentKey !== targetKey) {
                        return false;
                    }
                    return filter === undefined || filter(pathApi.basename(event.path));
                }
                if (!isKeyWithin(targetKey, changedKey, this.platform)) {
                    return false;
                }
                if (changedKey === targetKey || event.event === "addDir" || event.event === "unlinkDir") {
                    return true;
                }
                return filter === undefined || filter(pathApi.basename(event.path));
            },
        };
    }

    private getOrCreateBackend(
        running: Extract<WatcherLifecycle, { readonly kind: "running" }>,
        profileKey: DepthProfileKey,
        depth: number | undefined,
    ): BackendGroup {
        const existing = running.backends.get(profileKey);
        if (existing !== undefined) {
            return existing;
        }
        const backend = this.backendFactory({
            depth,
            followSymlinks: this.followSymlinks,
            usePolling: this.usePolling,
            pollIntervalMs: this.pollIntervalMs,
            awaitWriteFinish: this.awaitWriteFinish,
            onEvent: (event) => {
                this.handleBackendEvent(event);
            },
            onError: (error) => {
                this.handleBackendError(profileKey, error);
            },
        });
        const group: BackendGroup = {
            profileKey,
            backend,
            watchedPaths: new Map(),
        };
        running.backends.set(profileKey, group);
        return group;
    }

    private handleBackendEvent(event: WatchBackendEvent): void {
        const running = this.runningLifecycle();
        if (running === null) {
            return;
        }
        const pathApi = pathApiFor(this.platform);
        const changedKey = normalizePathKey(event.path, this.platform);
        const changedParentKey = normalizePathKey(pathApi.dirname(event.path), this.platform);

        for (const target of running.targets.values()) {
            if (target.matchesEvent(event, changedKey, changedParentKey)) {
                this.scheduleSync("fs_event");
                return;
            }
        }
    }

    private findMatchingWatchedPath(group: BackendGroup, rawErrorPath: string): readonly [string, string] | undefined {
        const errorKey = normalizePathKey(rawErrorPath, this.platform);
        const exact = group.watchedPaths.get(errorKey);
        if (exact !== undefined) {
            return [errorKey, exact];
        }
        let bestMatch: readonly [string, string] | undefined;
        for (const [pathKey, watchedPath] of group.watchedPaths) {
            if (
                isKeyWithin(pathKey, errorKey, this.platform) &&
                (bestMatch === undefined || pathKey.length > bestMatch[0].length)
            ) {
                bestMatch = [pathKey, watchedPath];
            }
        }
        return bestMatch;
    }

    private handleBackendError(profileKey: DepthProfileKey, error: unknown): void {
        const running = this.runningLifecycle();
        if (running === null) {
            return;
        }
        const kind = classifyWatchError(error);
        const rawErrorPath = errorPathOf(error);
        this.logger?.warn(
            { err: error, profileKey, kind, ...(rawErrorPath === undefined ? {} : { path: rawErrorPath }) },
            "disk watch backend encountered an error",
        );

        const group = running.backends.get(profileKey);
        if (group === undefined) {
            return;
        }

        const now = this.nowMs();
        if (kind === "permission_or_busy" && rawErrorPath !== undefined) {
            const matched = this.findMatchingWatchedPath(group, rawErrorPath);
            if (matched !== undefined) {
                const [matchedKey, matchedPath] = matched;
                group.watchedPaths.delete(matchedKey);
                group.backend.unwatch([matchedPath]);
                const previousFailures = running.blockedPaths.get(matchedKey)?.failures ?? 0;
                running.blockedPaths.set(matchedKey, nextErrorCooldown(previousFailures, now));
                return;
            }
        }

        if (kind === "watch_limit" || kind === "permission_or_busy") {
            running.backends.delete(profileKey);
            const previousFailures = running.profileCooldowns.get(profileKey)?.failures ?? 0;
            running.profileCooldowns.set(profileKey, nextErrorCooldown(previousFailures, now));
            void group.backend.close().catch(() => {});
        }
    }

    /** Apply an explicit target snapshot immediately when running (without invoking `resolveTargets`). */
    applyTargets(rawTargets: readonly WatchTarget[]): void {
        const running = this.runningLifecycle();
        if (running === null) {
            return;
        }

        const nextTargets = new Map<string, NormalizedTarget>();
        const desiredByProfile = new Map<
            DepthProfileKey,
            { readonly depth: number | undefined; readonly paths: Map<string, string> }
        >();

        for (const rawTarget of rawTargets) {
            const normalized = this.normalizeTarget(rawTarget);
            nextTargets.set(normalized.key, normalized);
            let bucket = desiredByProfile.get(normalized.profileKey);
            if (bucket === undefined) {
                bucket = { depth: normalized.depth, paths: new Map() };
                desiredByProfile.set(normalized.profileKey, bucket);
            }
            const pathKey = normalizePathKey(normalized.watchPath, this.platform);
            if (!bucket.paths.has(pathKey)) {
                bucket.paths.set(pathKey, normalized.watchPath);
            }
        }

        running.targets.clear();
        for (const [key, target] of nextTargets) {
            running.targets.set(key, target);
        }

        // Unwatch removed paths and close unused depth profiles before adding new paths so freed
        // slots remain available under `maxWatchers`.
        for (const [profileKey, group] of [...running.backends.entries()]) {
            const desiredBucket = desiredByProfile.get(profileKey);
            if (desiredBucket === undefined) {
                running.backends.delete(profileKey);
                void group.backend.close().catch((error: unknown) => {
                    this.logger?.warn({ err: error, profileKey }, "failed to close unused watch backend");
                });
                continue;
            }
            const toUnwatch: string[] = [];
            for (const [pathKey, watchedPath] of [...group.watchedPaths.entries()]) {
                if (!desiredBucket.paths.has(pathKey)) {
                    group.watchedPaths.delete(pathKey);
                    toUnwatch.push(watchedPath);
                }
            }
            if (toUnwatch.length > 0) {
                group.backend.unwatch(toUnwatch);
            }
        }

        const now = this.nowMs();
        let currentCount = this.activeWatchCount;
        for (const [profileKey, bucket] of desiredByProfile) {
            const profileCooldown = running.profileCooldowns.get(profileKey);
            if (profileCooldown !== undefined) {
                if (running.backends.has(profileKey)) {
                    // The recreated backend stayed healthy into a new reconcile pass; clear backoff.
                    running.profileCooldowns.delete(profileKey);
                } else if (now < profileCooldown.untilMs) {
                    continue;
                }
            }

            const group = this.getOrCreateBackend(running, profileKey, bucket.depth);
            const toAdd: string[] = [];
            for (const [pathKey, watchPath] of bucket.paths) {
                if (group.watchedPaths.has(pathKey)) {
                    running.blockedPaths.delete(pathKey);
                    continue;
                }
                const blocked = running.blockedPaths.get(pathKey);
                if (blocked !== undefined && now < blocked.untilMs) {
                    continue;
                }
                if (currentCount >= this.maxWatchers) {
                    if (!this.watchLimitWarned) {
                        this.watchLimitWarned = true;
                        this.logger?.warn(
                            { maxWatchers: this.maxWatchers, watchPath },
                            "reached maximum watched path limit; relying on polling for remaining paths",
                        );
                    }
                    break;
                }
                group.watchedPaths.set(pathKey, watchPath);
                toAdd.push(watchPath);
                currentCount += 1;
            }
            if (toAdd.length > 0) {
                group.backend.add(toAdd);
            }
        }
    }

    private async syncWatchers(preResolvedTargets?: readonly WatchTarget[]): Promise<void> {
        if (this.runningLifecycle() === null) {
            return;
        }
        let rawTargets: readonly WatchTarget[];
        if (preResolvedTargets !== undefined) {
            rawTargets = preResolvedTargets;
        } else {
            try {
                rawTargets = await this.options.resolveTargets();
            } catch (error) {
                this.logger?.warn({ err: error }, "failed to resolve disk watch targets");
                return;
            }
        }
        this.applyTargets(rawTargets);
    }
}
