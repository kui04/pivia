import type { SessionId } from "@pivia/protocol";

import { createSessionStore, type SessionState, type SessionStoreOptions } from "./store";

/** One per-session Zustand store created and owned by {@link SessionPool}. */
export type SessionStoreInstance = ReturnType<typeof createSessionStore>;

/** Default number of non-visible sessions kept attached in the background LRU. */
export const DEFAULT_MAX_BACKGROUND_SESSIONS = 8;

/** Options for {@link createSessionPool}. */
export interface SessionPoolOptions extends SessionStoreOptions {
    /**
     * Maximum number of sessions NOT currently visible in any split pane that stay connected in
     * the background. Must be a non-negative integer; defaults to {@link DEFAULT_MAX_BACKGROUND_SESSIONS}.
     */
    readonly maxBackgroundSessions?: number | undefined;
}

/** Reactive read-only summary of which sessions currently hold store entries in the pool. */
export interface SessionPoolSnapshot {
    /** Every session that currently has a store entry in the pool. */
    readonly attachedIds: ReadonlySet<SessionId>;
}

/**
 * Multi-session connection and state manager.
 *
 * Owns one isolated {@link SessionStoreInstance} per attached {@link SessionId}, keeping every
 * pane-visible session connected and retaining recently visited background sessions up to an LRU
 * budget while protecting busy (`streaming`, `compacting`, or pending extension UI) sessions.
 */
export interface SessionPool {
    /** Return the existing store for `sessionId` if attached, without creating or touching it. */
    getStore: (sessionId: SessionId) => SessionStoreInstance | null;
    /** Ensure `sessionId` has an attached store, connect its socket if needed, and mark it MRU. */
    attach: (sessionId: SessionId) => SessionStoreInstance;
    /**
     * Declare the exact set of sessions currently displayed in workspace panes.
     *
     * Newly visible sessions are attached and protected from eviction; newly hidden sessions remain
     * attached as background entries subject to LRU eviction.
     */
    setVisibleSessions: (sessionIds: ReadonlySet<SessionId>) => void;
    /** Explicitly disconnect and evict `sessionId` from the pool (for example on close/404). */
    detach: (sessionId: SessionId) => void;
    /** Disconnect every store, clear all in-memory session caches, and empty the pool. */
    clearAll: () => void;
    /** Current immutable snapshot for `useSyncExternalStore` subscribers. */
    getSnapshot: () => SessionPoolSnapshot;
    /** Subscribe to changes in {@link getSnapshot}. */
    subscribe: (listener: () => void) => () => void;
    /** Release all internal subscriptions and sockets when tearing down the app graph. */
    dispose: () => void;
}

interface PoolEntry {
    readonly store: SessionStoreInstance;
    unsubscribe: () => void;
    wasBusy: boolean;
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const item of a) {
        if (!b.has(item)) {
            return false;
        }
    }
    return true;
}

function resolveMaxBackgroundSessions(raw: number | undefined): number {
    if (raw === undefined) {
        return DEFAULT_MAX_BACKGROUND_SESSIONS;
    }
    if (!Number.isInteger(raw) || raw < 0) {
        throw new RangeError("maxBackgroundSessions must be a non-negative integer.");
    }
    return raw;
}

/**
 * True when a session is actively streaming, compacting, or awaiting an extension UI reply and
 * therefore must not be evicted from the background keep-alive pool.
 */
export function isSessionKeepAliveBusy(state: SessionState): boolean {
    return (
        state.state?.isStreaming === true || state.state?.isCompacting === true || state.pendingUiRequests.length > 0
    );
}

/**
 * Creates a multi-session pool backed by per-session {@link createSessionStore} instances.
 */
export function createSessionPool(options: SessionPoolOptions): SessionPool {
    const { maxBackgroundSessions: rawMaxBackground, onSessionMissing, ...storeBaseOptions } = options;
    const maxBackgroundSessions = resolveMaxBackgroundSessions(rawMaxBackground);

    const entries = new Map<SessionId, PoolEntry>();
    let visibleIds = new Set<SessionId>();
    const listeners = new Set<() => void>();
    let disposed = false;

    let snapshot: SessionPoolSnapshot = {
        attachedIds: new Set<SessionId>(),
    };

    const emitIfChanged = (): void => {
        const nextAttached = new Set<SessionId>(entries.keys());
        if (setsEqual(snapshot.attachedIds, nextAttached)) {
            return;
        }
        snapshot = { attachedIds: nextAttached };
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const touchEntry = (sessionId: SessionId, entry: PoolEntry): void => {
        // Re-inserting moves the session to the MRU tail of Map iteration order.
        entries.delete(sessionId);
        entries.set(sessionId, entry);
    };

    const removeEntry = (sessionId: SessionId, mode: "disconnect" | "clear"): boolean => {
        const entry = entries.get(sessionId);
        if (entry === undefined) {
            return false;
        }
        entries.delete(sessionId);
        entry.unsubscribe();
        if (mode === "clear") {
            entry.store.getState().clearCache();
        } else {
            entry.store.getState().disconnect();
        }
        return true;
    };

    const evictOverflow = (protectedId?: SessionId): void => {
        let backgroundCount = 0;
        for (const id of entries.keys()) {
            if (!visibleIds.has(id)) {
                backgroundCount += 1;
            }
        }
        if (backgroundCount <= maxBackgroundSessions) {
            return;
        }

        for (const [id, entry] of [...entries.entries()]) {
            if (backgroundCount <= maxBackgroundSessions) {
                break;
            }
            if (visibleIds.has(id) || id === protectedId) {
                continue;
            }
            if (isSessionKeepAliveBusy(entry.store.getState())) {
                continue;
            }
            if (removeEntry(id, "disconnect")) {
                backgroundCount -= 1;
            }
        }
    };

    const ensureEntry = (sessionId: SessionId, reconnectExisting: boolean): SessionStoreInstance => {
        const existing = entries.get(sessionId);
        if (existing !== undefined) {
            touchEntry(sessionId, existing);
            // Only explicit attach() retries an existing store (e.g. error/closed); visibility updates
            // from splitting panes must not silently reset another pane's terminated connection state.
            if (reconnectExisting) {
                existing.store.getState().connect(sessionId);
            }
            return existing.store;
        }

        const store = createSessionStore({
            ...storeBaseOptions,
            onSessionMissing: (missingId) => {
                visibleIds.delete(missingId);
                const removed = entries.get(missingId);
                if (removed !== undefined) {
                    entries.delete(missingId);
                    removed.unsubscribe();
                }
                emitIfChanged();
                onSessionMissing?.(missingId);
            },
        });

        const entry: PoolEntry = {
            store,
            unsubscribe: () => undefined,
            wasBusy: isSessionKeepAliveBusy(store.getState()),
        };

        entry.unsubscribe = store.subscribe((state) => {
            if (disposed || entries.get(sessionId) !== entry) {
                return;
            }
            const busy = isSessionKeepAliveBusy(state);
            const becameIdle = entry.wasBusy && !busy;
            entry.wasBusy = busy;
            if (becameIdle && !visibleIds.has(sessionId)) {
                evictOverflow();
                emitIfChanged();
            }
        });

        entries.set(sessionId, entry);
        store.getState().connect(sessionId);
        // Re-check in case `connect` resolved synchronously from memory/tests into a missing or busy state.
        if (entries.get(sessionId) === entry) {
            entry.wasBusy = isSessionKeepAliveBusy(store.getState());
        }
        return store;
    };

    return {
        getStore: (sessionId) => entries.get(sessionId)?.store ?? null,
        attach: (sessionId) => {
            if (disposed) {
                throw new Error("Cannot attach a session to a disposed SessionPool.");
            }
            const store = ensureEntry(sessionId, true);
            evictOverflow(sessionId);
            emitIfChanged();
            return store;
        },
        setVisibleSessions: (sessionIds) => {
            if (disposed) {
                return;
            }
            const previousVisible = visibleIds;
            const nextVisible = new Set<SessionId>(sessionIds);
            // Refresh recency of sessions leaving the visible panes so just-viewed sessions stay MRU.
            for (const prevId of previousVisible) {
                if (!nextVisible.has(prevId)) {
                    const entry = entries.get(prevId);
                    if (entry !== undefined) {
                        touchEntry(prevId, entry);
                    }
                }
            }
            visibleIds = nextVisible;
            for (const id of nextVisible) {
                ensureEntry(id, false);
            }
            evictOverflow();
            emitIfChanged();
        },
        detach: (sessionId) => {
            visibleIds.delete(sessionId);
            removeEntry(sessionId, "disconnect");
            emitIfChanged();
        },
        clearAll: () => {
            visibleIds.clear();
            for (const id of [...entries.keys()]) {
                removeEntry(id, "clear");
            }
            emitIfChanged();
        },
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            visibleIds.clear();
            for (const id of [...entries.keys()]) {
                removeEntry(id, "disconnect");
            }
            listeners.clear();
            snapshot = { attachedIds: new Set<SessionId>() };
        },
    };
}
