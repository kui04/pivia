import {
    SESSION_CLOSE_CODE,
    type EntriesVersion,
    type FileEntry,
    type RpcExtensionUIResponse,
    type SequencedSessionEvent,
    type SessionId,
    type SessionPrefixAnchor,
    type SessionStateSnapshot,
    type WsResponseMessage,
    type WsServerMessage,
} from "@pivia/protocol";
import { create } from "zustand";

import { sessionCache, type SessionCacheStore } from "@/lib/cache/session-cache";
import { Log } from "@/lib/log";
import { ApiClientError, apiClient as defaultApiClient, type ApiClient } from "@/lib/transport/http";
import {
    SessionSocket,
    SessionSocketClosedError,
    type SessionCommand,
    type SessionSocketClose,
    type SessionSocketConstructor,
    type SessionSocketHandshakeParams,
} from "@/lib/transport/session-socket";
import { useWorkspaceStore } from "@/stores/workspace/store";

import { initialSessionState, reduceSessionState, type SessionState } from "./reducer";

/** Snapshot kept in the in-memory LRU cache (1 active + up to 4 off-hand sessions). */
export interface SessionMemoryCacheEntry {
    readonly sessionId: SessionId;
    readonly entriesVersion: EntriesVersion | null;
    readonly entries: readonly FileEntry[];
    readonly runtimeId: string | null;
    readonly seq: number;
    readonly state: SessionStateSnapshot | null;
    readonly liveEvents: readonly SequencedSessionEvent[];
}

/** Dependencies that let a test replace the socket, cache, HTTP client, and retry timings. */
export interface SessionStoreOptions {
    readonly WebSocket?: SessionSocketConstructor | undefined;
    readonly cache?: SessionCacheStore | undefined;
    readonly apiClient?: ApiClient | undefined;
    readonly reconnectDelayMs?: number | undefined;
    readonly maxReconnectAttempts?: number | undefined;
    readonly retryDelaysMs?: readonly number[] | undefined;
    /**
     * Delay before an automatic retry after the HTTP entry sync exhausted `retryDelaysMs`.
     * A manual `retryEntriesSync` call skips the delay. Defaults to 5 seconds.
     */
    readonly entriesSyncCooldownMs?: number | undefined;
    readonly maxMemoryCacheEntries?: number | undefined;
    readonly onSessionMissing?: ((sessionId: SessionId) => void) | undefined;
}

/** What a caller may do with the active session. */
export interface SessionStoreActions {
    /** Opens one session, hydrating cached entries immediately and replacing any previous socket. */
    connect: (sessionId: SessionId, options?: { readonly afterSeq?: number | undefined }) => void;
    /** Closes the socket and returns the store to its initial state. */
    disconnect: () => void;
    /** Clears in-memory LRU cache and aborts any in-flight HTTP entry fetch (used on logout / 401). */
    clearCache: () => void;
    /** Manually retries a failed HTTP entry synchronization (`entriesSync.kind === "error"`). */
    retryEntriesSync: () => void;
    sendCommand: (command: SessionCommand) => Promise<WsResponseMessage>;
    sendUiResponse: (response: RpcExtensionUIResponse) => Promise<void>;
}

export type SessionStore = SessionState & SessionStoreActions;

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_HTTP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const DEFAULT_ENTRIES_SYNC_COOLDOWN_MS = 5_000;
const DEFAULT_MAX_MEMORY_CACHE_ENTRIES = 5;

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
        return Promise.resolve(false);
    }
    if (ms <= 0) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve(true);
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function derivePrefixAnchor(
    entriesVersion: EntriesVersion | null,
    entries: readonly FileEntry[],
    count = entries.length,
): SessionPrefixAnchor | undefined {
    if (entriesVersion === null || count < 1) {
        return undefined;
    }
    const anchorEntry = entries[count - 1];
    if (anchorEntry === undefined) {
        return undefined;
    }
    return {
        entriesVersion,
        afterCount: count,
        afterEntryId: anchorEntry.id,
    };
}

/**
 * Creates the store of the active session runtime.
 *
 * The store owns the single active socket, a 5-session in-memory LRU cache (1 active + 4 off-hand),
 * and the single-flight HTTP synchronization pipeline for `entriesMode: "http"` and gap self-heal.
 */
export function createSessionStore(options: SessionStoreOptions = {}) {
    const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_HTTP_RETRY_DELAYS_MS;
    const entriesSyncCooldownMs = options.entriesSyncCooldownMs ?? DEFAULT_ENTRIES_SYNC_COOLDOWN_MS;
    const maxMemoryCacheEntries = options.maxMemoryCacheEntries ?? DEFAULT_MAX_MEMORY_CACHE_ENTRIES;
    const client = options.apiClient ?? defaultApiClient;
    const cache = options.cache;

    return create<SessionStore>()((set, get) => {
        let socket: SessionSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let reconnectAttempts = 0;
        let generation = 0;
        const memoryLru = new Map<SessionId, SessionMemoryCacheEntry>();
        let httpSyncAbort: AbortController | null = null;
        let httpSyncInFlightGeneration: number | null = null;
        let entriesSyncRetryTimer: ReturnType<typeof setTimeout> | null = null;

        const clearReconnectTimer = (): void => {
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        const cancelHttpSync = (): void => {
            if (entriesSyncRetryTimer !== null) {
                clearTimeout(entriesSyncRetryTimer);
                entriesSyncRetryTimer = null;
            }
            httpSyncAbort?.abort();
            httpSyncAbort = null;
            httpSyncInFlightGeneration = null;
        };

        const saveToMemoryLru = (state: SessionState): void => {
            if (
                state.sessionId === null ||
                state.entriesSync.kind === "loading" ||
                state.entries.length === 0 ||
                state.entriesVersion === null
            ) {
                return;
            }
            memoryLru.delete(state.sessionId);
            memoryLru.set(state.sessionId, {
                sessionId: state.sessionId,
                entriesVersion: state.entriesVersion,
                entries: state.entries,
                runtimeId: state.runtimeId,
                seq: state.seq,
                state: state.state,
                liveEvents: state.liveEvents,
            });
            while (memoryLru.size > maxMemoryCacheEntries) {
                const oldestKey = memoryLru.keys().next().value;
                if (oldestKey === undefined) {
                    break;
                }
                memoryLru.delete(oldestKey);
            }
        };

        const evictMissingSession = (sessionId: SessionId): void => {
            memoryLru.delete(sessionId);
            void cache?.deleteSession(sessionId);
            options.onSessionMissing?.(sessionId);
        };

        const buildHandshakeParams = (state: SessionState, explicitAfterSeq?: number): SessionSocketHandshakeParams => {
            const afterSeq = explicitAfterSeq ?? (state.seq > 0 ? state.seq : undefined);
            const prefixAnchor = derivePrefixAnchor(state.entriesVersion, state.entries);
            return {
                ...(afterSeq === undefined ? {} : { afterSeq }),
                ...(state.runtimeId === null ? {} : { runtimeId: state.runtimeId }),
                ...(prefixAnchor === undefined ? {} : { prefixAnchor }),
            };
        };

        const syncEntriesFromHttp = (sessionId: SessionId, baseEntryCount: number): void => {
            if (httpSyncInFlightGeneration === generation && httpSyncAbort !== null) {
                return;
            }
            cancelHttpSync();
            const abortController = new AbortController();
            httpSyncAbort = abortController;
            const syncGeneration = generation;
            httpSyncInFlightGeneration = syncGeneration;

            const run = async (): Promise<void> => {
                for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
                    if (abortController.signal.aborted || generation !== syncGeneration) {
                        return;
                    }
                    const snapshotBefore = get();
                    const anchor = derivePrefixAnchor(
                        snapshotBefore.entriesVersion,
                        snapshotBefore.entries,
                        baseEntryCount,
                    );

                    try {
                        const detail = await client.getSession(sessionId, {
                            signal: abortController.signal,
                            ...(anchor === undefined ? {} : { anchor }),
                        });
                        if (abortController.signal.aborted || generation !== syncGeneration) {
                            return;
                        }
                        set((state) =>
                            reduceSessionState(state, {
                                type: "entries_sync_succeeded",
                                sessionId,
                                entriesVersion: detail.entriesVersion,
                                baseEntryCount: detail.baseEntryCount,
                                entries: detail.entries,
                            }),
                        );
                        const after = get();
                        if (detail.entriesVersion !== null && cache !== undefined) {
                            if (detail.baseEntryCount === 0) {
                                void cache.replaceEntries(sessionId, detail.entriesVersion, after.entries);
                            } else {
                                void cache.appendEntries(
                                    sessionId,
                                    detail.entriesVersion,
                                    detail.baseEntryCount,
                                    after.entries.slice(detail.baseEntryCount),
                                );
                            }
                        }
                        if (httpSyncAbort === abortController) {
                            httpSyncAbort = null;
                            httpSyncInFlightGeneration = null;
                        }
                        if (after.entriesSync.kind === "loading") {
                            syncEntriesFromHttp(sessionId, after.entries.length);
                        }
                        return;
                    } catch (error) {
                        if (abortController.signal.aborted || generation !== syncGeneration) {
                            return;
                        }
                        if (error instanceof ApiClientError && error.status === 401) {
                            Log.warn(`Session history sync was rejected for ${sessionId}`, error.message);
                            get().clearCache();
                            return;
                        }
                        if (error instanceof ApiClientError && error.status === 404) {
                            Log.warn(`Session ${sessionId} no longer exists on the server`);
                            if (httpSyncAbort === abortController) {
                                httpSyncAbort = null;
                                httpSyncInFlightGeneration = null;
                            }
                            const currentSocket = socket;
                            socket = null;
                            currentSocket?.close();
                            clearReconnectTimer();
                            evictMissingSession(sessionId);
                            set((state) =>
                                reduceSessionState(state, {
                                    type: "closed",
                                    reason: "session",
                                    message: "Session not found",
                                }),
                            );
                            return;
                        }
                        const retryDelay = retryDelaysMs[attempt];
                        if (retryDelay !== undefined) {
                            Log.warn(
                                `Session history sync failed, retrying in ${String(retryDelay)} ms (${sessionId}, attempt ${String(attempt + 1)})`,
                                error,
                            );
                            const continued = await sleepWithSignal(retryDelay, abortController.signal);
                            if (!continued) {
                                return;
                            }
                            continue;
                        }
                        if (httpSyncAbort === abortController) {
                            httpSyncAbort = null;
                            httpSyncInFlightGeneration = null;
                        }
                        const message =
                            error instanceof Error && error.message !== ""
                                ? error.message
                                : "Cannot load session history.";
                        Log.warn(
                            `Session history sync gave up after ${String(attempt + 1)} attempts (${sessionId})`,
                            error,
                        );
                        set((state) =>
                            reduceSessionState(state, {
                                type: "entries_sync_failed",
                                sessionId,
                                message,
                            }),
                        );
                        scheduleEntriesSyncRetry(sessionId);
                        return;
                    }
                }
            };

            void run();
        };

        /**
         * Retry the entry sync once after the retry ladder ran out, unless a manual retry comes first.
         *
         * The failure stays visible for the whole cooldown. Without this gate every later
         * `entries_appended` frame would restart the whole ladder, so a persistent server failure
         * would be retried at append frequency.
         */
        const scheduleEntriesSyncRetry = (sessionId: SessionId): void => {
            if (entriesSyncRetryTimer !== null) {
                return;
            }
            entriesSyncRetryTimer = setTimeout(() => {
                entriesSyncRetryTimer = null;
                const state = get();
                if (state.sessionId !== sessionId || state.entriesSync.kind !== "error") {
                    return;
                }
                const { targetEntryCount } = state.entriesSync;
                set((current) =>
                    reduceSessionState(current, {
                        type: "entries_sync_started",
                        baseEntryCount: current.entries.length,
                        targetEntryCount,
                    }),
                );
                syncEntriesFromHttp(sessionId, get().entries.length);
            }, entriesSyncCooldownMs);
        };

        const applyMessage = (message: WsServerMessage): void => {
            switch (message.type) {
                case "snapshot":
                    reconnectAttempts = 0;
                    set((state) => reduceSessionState(state, { type: "snapshot", message }));
                    if (message.entriesMode === "http") {
                        syncEntriesFromHttp(message.sessionId, message.baseEntryCount);
                    } else if (cache !== undefined) {
                        if (message.baseEntryCount === 0) {
                            void cache.replaceEntries(message.sessionId, message.entriesVersion, message.entries);
                        } else {
                            void cache.appendEntries(
                                message.sessionId,
                                message.entriesVersion,
                                message.baseEntryCount,
                                message.entries,
                            );
                        }
                    }
                    return;
                case "replay":
                    reconnectAttempts = 0;
                    set((state) => reduceSessionState(state, { type: "replay", message }));
                    if (
                        cache !== undefined &&
                        message.appendedSlice !== undefined &&
                        message.appendedSlice.entries.length > 0
                    ) {
                        void cache.appendEntries(
                            message.sessionId,
                            message.entriesVersion,
                            message.appendedSlice.baseEntryCount,
                            message.appendedSlice.entries,
                        );
                    }
                    // A reconnect cancels the in-flight sync. The replay settled the prefix, so a
                    // sync still marked loading has to be restarted from the entries it now holds.
                    if (get().entriesSync.kind === "loading") {
                        syncEntriesFromHttp(message.sessionId, get().entries.length);
                    }
                    return;
                case "entries_appended": {
                    const before = get();
                    if (before.status === "closed" || message.sessionId !== before.sessionId) {
                        return;
                    }
                    if (message.entriesMode === "http") {
                        const baseCount = before.entries.length;
                        set((state) =>
                            reduceSessionState(state, {
                                type: "entries_sync_started",
                                baseEntryCount: state.entries.length,
                                targetEntryCount: message.entryCount,
                            }),
                        );
                        syncEntriesFromHttp(message.sessionId, baseCount);
                        return;
                    }
                    if (before.entriesSync.kind === "idle" && message.baseEntryCount > before.entries.length) {
                        const baseCount = before.entries.length;
                        const targetCount = message.baseEntryCount + message.entries.length;
                        set((state) =>
                            reduceSessionState(state, {
                                type: "entries_sync_started",
                                baseEntryCount: state.entries.length,
                                targetEntryCount: targetCount,
                            }),
                        );
                        set((state) => reduceSessionState(state, { type: "entries_appended", message }));
                        syncEntriesFromHttp(message.sessionId, baseCount);
                        return;
                    }
                    set((state) => reduceSessionState(state, { type: "entries_appended", message }));
                    if (before.entriesSync.kind === "idle" && cache !== undefined) {
                        void cache.appendEntries(
                            message.sessionId,
                            message.entriesVersion,
                            message.baseEntryCount,
                            message.entries,
                        );
                    }
                    return;
                }
                case "event":
                    reconnectAttempts = 0;
                    set((state) => reduceSessionState(state, { type: "event", message }));
                    return;
                case "extension_ui_request":
                    set((state) => reduceSessionState(state, { type: "extension_ui_request", message }));
                    return;
                case "extension_ui_resolved":
                    set((state) => reduceSessionState(state, { type: "extension_ui_resolved", message }));
                    return;
                case "extension_error":
                    Log.warn(
                        `Extension ${message.extensionPath} failed while handling ${message.event}`,
                        message.error,
                    );
                    return;
                case "error":
                    set((state) => reduceSessionState(state, { type: "server_error", message }));
                    return;
                case "response":
                    // The socket settles the matching command promise before this callback runs.
                    return;
            }
        };

        const open = (sessionId: SessionId, handshake: SessionSocketHandshakeParams): void => {
            const currentGeneration = generation;
            const nextSocket = new SessionSocket({
                sessionId,
                handshake,
                ...(options.WebSocket === undefined ? {} : { WebSocket: options.WebSocket }),
                onOpen: () => {
                    if (generation !== currentGeneration) {
                        return;
                    }
                    set((state) => reduceSessionState(state, { type: "open" }));
                },
                onMessage: (message: WsServerMessage) => {
                    if (generation !== currentGeneration) {
                        return;
                    }
                    applyMessage(message);
                },
                onClose: (close) => {
                    if (generation !== currentGeneration) {
                        return;
                    }
                    handleClose(sessionId, close);
                },
                onError: (message) => {
                    if (generation === currentGeneration) {
                        Log.warn(`Session socket error: ${message}`);
                    }
                },
            });
            socket = nextSocket;
            try {
                nextSocket.connect();
            } catch (error) {
                socket = null;
                const message = error instanceof Error ? error.message : String(error);
                set((state) => reduceSessionState(state, { type: "failed", message }));
            }
        };

        const scheduleReconnect = (): void => {
            const state = get();
            if (state.sessionId === null || state.status === "closed") {
                set((current) => reduceSessionState(current, { type: "closed", reason: "client" }));
                return;
            }
            if (reconnectAttempts >= maxReconnectAttempts) {
                set((current) =>
                    reduceSessionState(current, {
                        type: "failed",
                        message: "Cannot reconnect to the session.",
                    }),
                );
                return;
            }
            reconnectAttempts += 1;
            set((current) => reduceSessionState(current, { type: "reconnecting" }));
            const scheduledGeneration = generation;
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                const next = get();
                if (generation !== scheduledGeneration || next.sessionId === null || next.status !== "reconnecting") {
                    return;
                }
                open(next.sessionId, buildHandshakeParams(next));
            }, reconnectDelayMs);
        };

        const handleClose = (sessionId: SessionId, close: SessionSocketClose): void => {
            socket = null;
            clearReconnectTimer();
            if (close.code === SESSION_CLOSE_CODE.sessionNotFound) {
                cancelHttpSync();
                evictMissingSession(sessionId);
            }
            if (close.classification === "client" || close.classification === "session") {
                set((state) =>
                    reduceSessionState(state, {
                        type: "closed",
                        reason: close.classification,
                        message: close.reason,
                    }),
                );
                return;
            }
            Log.warn(`The session connection closed (${close.classification}, code ${String(close.code)})`);
            // The handshake re-anchors the transcript from the client's prefix, so a response that
            // was computed for the pre-drop prefix must not land afterwards: it can be shorter than
            // what the reconnect already delivered.
            cancelHttpSync();
            scheduleReconnect();
        };

        const hydrateAndConnect = (sessionId: SessionId, explicitAfterSeq: number | undefined): void => {
            const memEntry = memoryLru.get(sessionId);
            if (memEntry !== undefined) {
                // Touch LRU order.
                memoryLru.delete(sessionId);
                memoryLru.set(sessionId, memEntry);
                set((state) =>
                    reduceSessionState(state, {
                        type: "hydrate_cache",
                        sessionId,
                        entriesVersion: memEntry.entriesVersion,
                        entries: memEntry.entries,
                        runtimeId: memEntry.runtimeId,
                        seq: memEntry.seq,
                        state: memEntry.state,
                        liveEvents: memEntry.liveEvents,
                    }),
                );
                open(sessionId, buildHandshakeParams(get(), explicitAfterSeq));
                return;
            }

            if (cache === undefined) {
                open(sessionId, buildHandshakeParams(get(), explicitAfterSeq));
                return;
            }

            const connectGeneration = generation;
            void cache
                .getSession(sessionId)
                .then((cached) => {
                    if (generation !== connectGeneration) {
                        return;
                    }
                    if (cached !== null) {
                        set((state) =>
                            reduceSessionState(state, {
                                type: "hydrate_cache",
                                sessionId,
                                entriesVersion: cached.meta.entriesVersion,
                                entries: cached.entries,
                            }),
                        );
                    }
                    open(sessionId, buildHandshakeParams(get(), explicitAfterSeq));
                })
                .catch((error: unknown) => {
                    Log.warn("Failed to hydrate session from IndexedDB", error);
                    if (generation !== connectGeneration) {
                        return;
                    }
                    open(sessionId, buildHandshakeParams(get(), explicitAfterSeq));
                });
        };

        return {
            ...initialSessionState,
            connect: (sessionId, connectOptions = {}) => {
                const current = get();
                if (
                    current.sessionId === sessionId &&
                    socket !== null &&
                    (current.status === "connecting" || current.status === "open" || current.status === "reconnecting")
                ) {
                    return;
                }
                if (current.sessionId !== null && current.sessionId !== sessionId) {
                    saveToMemoryLru(current);
                }
                generation += 1;
                clearReconnectTimer();
                cancelHttpSync();
                reconnectAttempts = 0;
                const previous = socket;
                socket = null;
                previous?.close();
                set((state) => reduceSessionState(state, { type: "connect", sessionId }));
                hydrateAndConnect(sessionId, connectOptions.afterSeq);
            },
            disconnect: () => {
                saveToMemoryLru(get());
                generation += 1;
                clearReconnectTimer();
                cancelHttpSync();
                reconnectAttempts = 0;
                const current = socket;
                socket = null;
                current?.close();
                set((state) => reduceSessionState(state, { type: "reset" }));
            },
            clearCache: () => {
                memoryLru.clear();
                generation += 1;
                clearReconnectTimer();
                cancelHttpSync();
                reconnectAttempts = 0;
                const current = socket;
                socket = null;
                current?.close();
                set((state) => reduceSessionState(state, { type: "reset" }));
            },
            retryEntriesSync: () => {
                const current = get();
                if (current.sessionId === null || current.entriesSync.kind !== "error") {
                    return;
                }
                const { baseEntryCount, targetEntryCount } = current.entriesSync;
                set((state) =>
                    reduceSessionState(state, {
                        type: "entries_sync_started",
                        baseEntryCount,
                        targetEntryCount,
                    }),
                );
                syncEntriesFromHttp(current.sessionId, baseEntryCount);
            },
            sendCommand: (command) => {
                const current = socket;
                if (current === null) {
                    return Promise.reject(new SessionSocketClosedError("client"));
                }
                return current.sendCommand(command);
            },
            sendUiResponse: (response) => {
                const current = socket;
                if (current === null) {
                    return Promise.reject(new SessionSocketClosedError("client"));
                }
                try {
                    current.sendUiResponse(response);
                    return Promise.resolve();
                } catch (error) {
                    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
                }
            },
        };
    });
}

/** The app-wide store for the active session. */
export const useSessionStore = createSessionStore({
    cache: sessionCache,
    apiClient: defaultApiClient,
    onSessionMissing: (sessionId) => {
        useWorkspaceStore.getState().removeSession(sessionId);
    },
});
