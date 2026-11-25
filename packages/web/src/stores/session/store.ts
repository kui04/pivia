import type { FileEntry, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import {
    SESSION_CLOSE_CODE,
    type EntriesVersion,
    type SessionDelta,
    type SessionDetailResponse,
    type SessionHandshake,
    type SessionId,
    type SessionPrefixAnchor,
    type SessionRpcCommand,
    type SessionSnapshot,
    type SessionStateSnapshot,
} from "@pivia/protocol";
import { create } from "zustand";

import type { SessionCache } from "@/lib/cache";
import { Log } from "@/lib";
import { createReconnectController, type ReconnectController, SyncStreamClient } from "@/lib/sync";
import { ApiClientError, type ApiClient } from "@/lib/transport/http";
import {
    SessionSocket,
    SessionSocketClosedError,
    type SessionRpcResponseMessage,
    type SessionSocketClose,
} from "@/lib/transport/session-socket";
import type { WebSocketConstructor } from "@/lib/transport/websocket";

import {
    applyHydratedEntries,
    applyLocalSessionHydration,
    applySessionClosed,
    buildSessionPrefixAnchor,
    CLEARED_LIVE_RUNTIME_STATE,
    createSessionSyncReducer,
    initialSessionState,
    type SessionHttpHydrationDescriptor,
    type SessionState,
} from "./reducer";

export { initialSessionState, liveAssistantMessage } from "./reducer";
export type {
    CompactionReason,
    EntriesSyncState,
    LiveMessageState,
    LiveToolExecutionResult,
    LiveToolExecutionState,
    SessionActivityNotice,
    SessionConnectionStatus,
    SessionLiveActivity,
    SessionState,
} from "./reducer";

/** Lightweight in-memory snapshot kept for instant UI display and Tier 2 anchors on switch-back. */
export interface SessionMemoryCacheEntry {
    readonly entriesVersion: EntriesVersion | null;
    readonly entries: readonly FileEntry[];
    readonly state: SessionStateSnapshot | null;
}

/** Options for {@link createSessionStore}. */
export interface SessionStoreOptions {
    readonly WebSocket?: WebSocketConstructor | undefined;
    readonly cache?: SessionCache | undefined;
    readonly apiClient: Pick<ApiClient, "getSession">;
    readonly reconnectDelayMs?: number | undefined;
    readonly maxReconnectAttempts?: number | undefined;
    /** Retry delays (ms) for transient `GET /api/sessions/:id` failures. */
    readonly retryDelaysMs?: readonly number[] | undefined;
    /**
     * Cooldown (ms) before retrying a failed HTTP entry sync once automatically.
     *
     * A manual `retryEntriesSync` call skips the delay. Defaults to 5 seconds.
     */
    readonly entriesSyncCooldownMs?: number | undefined;
    readonly maxMemoryCacheEntries?: number | undefined;
    /** Invoked when a session is evicted after returning 404 or closing with 4404. */
    readonly onSessionMissing?: ((sessionId: SessionId) => void) | undefined;
}

/** Actions the UI and session controller invoke against {@link SessionStore}. */
export interface SessionStoreActions {
    connect: (sessionId: SessionId) => void;
    disconnect: () => void;
    clearCache: () => void;
    /** Manually retries a failed HTTP entry synchronization (`entriesSync.kind === "error"`). */
    retryEntriesSync: () => void;
    sendCommand: (command: SessionRpcCommand) => Promise<SessionRpcResponseMessage>;
    sendUiResponse: (response: RpcExtensionUIResponse) => Promise<void>;
}

/** Combined state and actions of the active session store. */
export type SessionStore = SessionState & SessionStoreActions;

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_HTTP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const DEFAULT_ENTRIES_SYNC_COOLDOWN_MS = 5_000;
const DEFAULT_MAX_MEMORY_CACHE_ENTRIES = 5;

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return signal?.aborted ? Promise.reject(new DOMException("Aborted", "AbortError")) : Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function isTransientHttpError(error: unknown): boolean {
    if (error instanceof ApiClientError) {
        return error.status === 429 || error.status >= 500;
    }
    return error instanceof Error;
}

/** Creates the session store wired to `/ws/sessions/:id`, HTTP entry hydration, and dual caches. */
export function createSessionStore(options: SessionStoreOptions) {
    if (options === undefined || options.apiClient === undefined) {
        throw new Error("createSessionStore requires an apiClient.");
    }
    const { cache, apiClient, onSessionMissing } = options;
    const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_HTTP_RETRY_DELAYS_MS;
    const entriesSyncCooldownMs = options.entriesSyncCooldownMs ?? DEFAULT_ENTRIES_SYNC_COOLDOWN_MS;
    const maxMemoryCacheEntries = options.maxMemoryCacheEntries ?? DEFAULT_MAX_MEMORY_CACHE_ENTRIES;

    return create<SessionStore>()((set, get) => {
        let socket: SessionSocket | null = null;
        let generation = 0;
        let entriesSyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
        let autoRetriedAfterFailure = false;
        const memoryLru = new Map<SessionId, SessionMemoryCacheEntry>();

        const cancelEntriesRetry = (): void => {
            if (entriesSyncRetryTimer !== null) {
                clearTimeout(entriesSyncRetryTimer);
                entriesSyncRetryTimer = null;
            }
        };

        /** Cancel a pending automatic entry-sync retry so the next failure can schedule a fresh one. */
        const resetEntriesSyncRetry = (): void => {
            cancelEntriesRetry();
            autoRetriedAfterFailure = false;
        };

        const closeActiveSocket = (): void => {
            const current = socket;
            socket = null;
            current?.close();
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
            // Memory LRU supplies Tier 2 prefix anchors and instant cached rows on session switches;
            // live-only cursor state is never cached across switch boundaries so fresh snapshots reload
            // liveMessage and pendingUiRequests cleanly.
            memoryLru.delete(state.sessionId);
            memoryLru.set(state.sessionId, {
                entriesVersion: state.entriesVersion,
                entries: state.entries,
                state: state.state,
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
            if (cache !== undefined) {
                void cache.delete(sessionId);
            }
            onSessionMissing?.(sessionId);
        };

        const persistEntriesToCache = (prev: SessionState, next: SessionState): void => {
            if (
                cache === undefined ||
                next.sessionId === null ||
                next.entriesVersion === null ||
                next.entriesSync.kind !== "idle" ||
                next.entries.length === 0
            ) {
                return;
            }
            if (
                prev.sessionId !== next.sessionId ||
                prev.entries.length === 0 ||
                prev.entriesVersion !== next.entriesVersion ||
                next.entries.length < prev.entries.length
            ) {
                void cache.replaceEntries(next.sessionId, next.entriesVersion, next.entries);
                return;
            }
            if (next.entries.length > prev.entries.length) {
                void cache.appendEntries(
                    next.sessionId,
                    next.entriesVersion,
                    prev.entries.length,
                    next.entries.slice(prev.entries.length),
                );
            }
        };

        const buildAnchorForSession = (
            sessionId: SessionId,
            baseEntryCount: number,
        ): SessionPrefixAnchor | undefined => {
            const current = get();
            if (baseEntryCount <= 0 || current.sessionId !== sessionId || current.entriesVersion === null) {
                return undefined;
            }
            const lastPrefixEntry = current.entries[baseEntryCount - 1];
            if (lastPrefixEntry === undefined) {
                return undefined;
            }
            return {
                entriesVersion: current.entriesVersion,
                afterCount: baseEntryCount,
                afterEntryId: lastPrefixEntry.id,
            };
        };

        const fetchSessionWithRetries = async (
            sessionId: SessionId,
            baseEntryCount: number,
            signal: AbortSignal,
        ): Promise<SessionDetailResponse> => {
            const anchor = buildAnchorForSession(sessionId, baseEntryCount);
            let lastError: unknown;
            for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
                if (signal.aborted) {
                    throw new DOMException("Aborted", "AbortError");
                }
                if (attempt > 0) {
                    const delay = retryDelaysMs[attempt - 1] ?? 1_000;
                    await waitWithAbort(delay, signal);
                }
                try {
                    return await apiClient.getSession(
                        sessionId,
                        anchor === undefined ? { signal } : { anchor, signal },
                    );
                } catch (error) {
                    if (isAbortError(error) || signal.aborted) {
                        throw error;
                    }
                    lastError = error;
                    if (error instanceof ApiClientError && error.status === 404) {
                        throw error;
                    }
                    if (!isTransientHttpError(error) || attempt === retryDelaysMs.length) {
                        throw error;
                    }
                }
            }
            throw lastError instanceof Error ? lastError : new Error("Failed to fetch session entries.");
        };

        const triggerHydrationRetry = (): void => {
            syncClient.retryHydration((prev) => ({
                ...prev,
                entriesSync: { kind: "loading" },
            }));
        };

        const scheduleCooldownRetry = (capturedGen: number): void => {
            if (autoRetriedAfterFailure || entriesSyncRetryTimer !== null) {
                return;
            }
            autoRetriedAfterFailure = true;
            entriesSyncRetryTimer = setTimeout(() => {
                entriesSyncRetryTimer = null;
                if (capturedGen === generation) {
                    triggerHydrationRetry();
                }
            }, entriesSyncCooldownMs);
        };

        const syncClient: SyncStreamClient<
            "session",
            SessionState,
            SessionSnapshot,
            SessionDelta,
            SessionHttpHydrationDescriptor
        > = new SyncStreamClient<
            "session",
            SessionState,
            SessionSnapshot,
            SessionDelta,
            SessionHttpHydrationDescriptor
        >({
            initialState: initialSessionState,
            reducer: createSessionSyncReducer(),
            async onHydrateHttp(descriptor, ctx): Promise<SessionState> {
                const sessionId = ctx.currentState.sessionId;
                const capturedGen = generation;
                if (sessionId === null) {
                    return ctx.currentState;
                }
                // For `delta`-triggered HTTP offloads, show loading indicator while request is in flight.
                if (descriptor.kind === "delta") {
                    set((state) => {
                        if (state.sessionId !== sessionId || state.status === "closed") {
                            return state;
                        }
                        return {
                            ...state,
                            entriesSync: { kind: "loading" },
                        };
                    });
                }
                try {
                    const detail = await fetchSessionWithRetries(sessionId, descriptor.baseEntryCount, ctx.signal);
                    if (ctx.signal.aborted || capturedGen !== generation) {
                        throw new DOMException("Aborted", "AbortError");
                    }
                    resetEntriesSyncRetry();
                    return applyHydratedEntries(
                        ctx.getLatestState(),
                        detail.entriesVersion,
                        detail.baseEntryCount,
                        detail.entries,
                    );
                } catch (error) {
                    if (isAbortError(error) || ctx.signal.aborted || capturedGen !== generation) {
                        throw error;
                    }
                    if (error instanceof ApiClientError && error.status === 404) {
                        closeSession(sessionId, ctx.getLatestState(), error.message);
                        throw new DOMException("Session closed", "AbortError");
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    Log.warn(`Session HTTP entry sync failed: ${message}`);
                    scheduleCooldownRetry(capturedGen);
                    throw error;
                }
            },
            onStateChange(nextState, meta) {
                const prev = get();
                let status = nextState.status;
                let lastError = nextState.lastError;
                let clearedLive: Partial<SessionState> = {};
                if (nextState.status !== "closed") {
                    if (meta.phase.kind === "live" || meta.phase.kind === "hydrating_http") {
                        status = "open";
                        if (meta.source === "snapshot" || meta.source === "replay") {
                            lastError = null;
                        }
                    } else if (meta.phase.kind === "reconnecting") {
                        status = "reconnecting";
                    } else if (meta.phase.kind === "error") {
                        status = "error";
                        clearedLive = CLEARED_LIVE_RUNTIME_STATE;
                        lastError = meta.phase.message;
                    }
                }
                const committed: SessionState = {
                    ...nextState,
                    ...clearedLive,
                    status,
                    lastError,
                };
                if (
                    meta.source === "snapshot" ||
                    meta.source === "replay" ||
                    meta.source === "delta" ||
                    meta.source === "hydrate"
                ) {
                    persistEntriesToCache(prev, committed);
                }
                set(committed);
            },
            onResyncRequired(reason) {
                const capturedGen = generation;
                if (get().status === "closed") {
                    return;
                }
                closeActiveSocket();
                if (capturedGen === generation) {
                    reconnect.scheduleResync(reason);
                }
            },
        });

        const openSocket = (sessionId: SessionId, handshake: SessionHandshake, capturedGen: number): void => {
            if (capturedGen !== generation || get().status === "closed") {
                return;
            }
            closeActiveSocket();
            const nextSocket = new SessionSocket({
                sessionId,
                handshake,
                WebSocket: options.WebSocket,
                onSyncFrame: (frame) => {
                    if (capturedGen !== generation || get().status === "closed") {
                        return;
                    }
                    if (frame.type === "sync:snapshot" || frame.type === "sync:replay") {
                        resetEntriesSyncRetry();
                        reconnect.markConnected();
                    } else if (frame.type === "sync:delta" && frame.delta.kind === "extension_error") {
                        Log.warn(
                            `Extension ${frame.delta.extensionPath} failed while handling ${frame.delta.event}`,
                            frame.delta.error,
                        );
                    }
                    syncClient.handleFrame(frame);
                },
                onRpcError: (error) => {
                    if (capturedGen !== generation || get().status === "closed") {
                        return;
                    }
                    set({ lastError: error.message });
                },
                onClose: (close) => {
                    if (capturedGen !== generation) {
                        return;
                    }
                    handleClose(sessionId, close);
                },
                onError: (message) => {
                    if (capturedGen === generation) {
                        Log.warn(`Session socket error: ${message}`);
                    }
                },
            });
            socket = nextSocket;
            nextSocket.connect();
        };

        const reconnect: ReconnectController = createReconnectController({
            delaysMs: [reconnectDelayMs],
            maxAttempts: maxReconnectAttempts,
            listenBrowserEvents: false,
            onScheduled(attempt) {
                if (get().status === "closed") {
                    return;
                }
                syncClient.markReconnecting(attempt);
            },
            onExhausted() {
                if (get().status === "closed") {
                    return;
                }
                syncClient.markError("Cannot reconnect to the session.");
            },
            onReconnect() {
                const state = get();
                if (state.sessionId === null || state.status === "closed") {
                    return;
                }
                const hint = buildSessionPrefixAnchor(state);
                const cursor = syncClient.handshakeCursor();
                const handshake: SessionHandshake = {
                    ...(cursor === undefined ? {} : { cursor }),
                    ...(hint === undefined ? {} : { hint }),
                };
                openSocket(state.sessionId, handshake, generation);
            },
        });

        /**
         * Reset to the terminal `closed` state and release the current transport.
         *
         * A missing session also leaves both caches so the workspace does not reopen a deleted id.
         */
        const closeSession = (missingSessionId: SessionId | null, state: SessionState, message: string): void => {
            reconnect.stop();
            resetEntriesSyncRetry();
            closeActiveSocket();
            if (missingSessionId !== null) {
                evictMissingSession(missingSessionId);
            }
            syncClient.reset(applySessionClosed(state, "session", message), null);
        };

        /**
         * Drop the current transport and replace the synced state, invalidating in-flight work.
         *
         * Returns the new generation guard, which the caller must pass to any asynchronous follow-up.
         */
        const resetRuntime = (nextState: SessionState): number => {
            generation += 1;
            resetEntriesSyncRetry();
            closeActiveSocket();
            reconnect.stop();
            syncClient.reset(nextState, null);
            return generation;
        };

        const handleClose = (sessionId: SessionId, close: SessionSocketClose): void => {
            socket = null;
            if (close.classification === "client") {
                return;
            }
            if (close.code === SESSION_CLOSE_CODE.sessionNotFound) {
                closeSession(sessionId, syncClient.currentState, close.reason);
                return;
            }
            if (close.classification === "session") {
                closeSession(null, syncClient.currentState, close.reason);
                return;
            }
            reconnect.notifyClosed();
        };

        const hydrateAndConnect = (sessionId: SessionId, capturedGen: number): void => {
            const memEntry = memoryLru.get(sessionId);
            if (memEntry !== undefined) {
                const hydrated = applyLocalSessionHydration(syncClient.currentState, {
                    sessionId,
                    entriesVersion: memEntry.entriesVersion,
                    entries: memEntry.entries,
                    state: memEntry.state,
                });
                syncClient.hydrateLocalState(hydrated);
                set(hydrated);
                const hint = buildSessionPrefixAnchor(hydrated);
                openSocket(sessionId, hint === undefined ? {} : { hint }, capturedGen);
                return;
            }

            if (cache === undefined) {
                openSocket(sessionId, {}, capturedGen);
                return;
            }

            void cache
                .get(sessionId)
                .catch((error: unknown) => {
                    Log.warn("Failed to hydrate session from IndexedDB", error);
                    return null;
                })
                .then((record) => {
                    if (capturedGen !== generation || get().status === "closed") {
                        return;
                    }
                    if (record !== null) {
                        const hydrated = applyLocalSessionHydration(syncClient.currentState, {
                            sessionId,
                            entriesVersion: record.meta.entriesVersion,
                            entries: record.entries,
                        });
                        syncClient.hydrateLocalState(hydrated);
                        set(hydrated);
                    }
                    const hint = buildSessionPrefixAnchor(get());
                    openSocket(sessionId, hint === undefined ? {} : { hint }, capturedGen);
                });
        };

        return {
            ...initialSessionState,
            connect: (sessionId) => {
                const current = get();
                if (
                    current.sessionId === sessionId &&
                    (current.status === "connecting" || current.status === "open" || current.status === "reconnecting")
                ) {
                    return;
                }
                if (current.sessionId !== null && current.sessionId !== sessionId) {
                    saveToMemoryLru(current);
                }
                const capturedGen = resetRuntime({ ...initialSessionState, status: "connecting", sessionId });
                reconnect.start();
                hydrateAndConnect(sessionId, capturedGen);
            },
            disconnect: () => {
                saveToMemoryLru(get());
                resetRuntime(initialSessionState);
            },
            clearCache: () => {
                memoryLru.clear();
                resetRuntime(initialSessionState);
            },
            retryEntriesSync: () => {
                resetEntriesSyncRetry();
                triggerHydrationRetry();
            },
            sendCommand: (command) => {
                const current = socket;
                if (current === null || current.isClosed) {
                    return Promise.reject(new SessionSocketClosedError("client"));
                }
                return current.sendCommand(command);
            },
            sendUiResponse: (response) => {
                const current = socket;
                if (current === null || current.isClosed) {
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
