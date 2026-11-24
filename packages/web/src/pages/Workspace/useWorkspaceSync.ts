import { useCallback, useEffect, useRef } from "react";

import { assertNever, WS_CLOSE_CODE, type CatalogDelta, type CatalogSnapshot } from "@pivia/protocol";

import { Log } from "@/lib/log";
import {
    createReconnectController,
    DEFAULT_AUTH_PROBE_THRESHOLD,
    DEFAULT_RECONNECT_DELAYS_MS,
    SyncStreamClient,
} from "@/lib/sync";
import { showError } from "@/lib/toast";
import { apiClient as defaultApiClient, type ApiClient } from "@/lib/transport/http";
import type { WebSocketConstructor } from "@/lib/transport/websocket";
import { connectWorkspaceSocket, type WorkspaceSocket } from "@/lib/transport/workspace-socket";
import { useAuthStore as defaultAuthStore, useWorkspaceStore as defaultWorkspaceStore } from "@/stores";
import { createCatalogSyncReducer, type CatalogSyncState } from "@/stores/workspace/model";

export { DEFAULT_AUTH_PROBE_THRESHOLD, DEFAULT_RECONNECT_DELAYS_MS };

/** Minimum visible duration of a manual refresh so fast local responses still show feedback. */
export const DEFAULT_MIN_REFRESH_DURATION_MS = 300;

/** Dependencies injected into {@link createWorkspaceSyncController} and {@link useWorkspaceSync}. */
export interface WorkspaceSyncOptions {
    readonly apiClient?: Pick<ApiClient, "listSessions" | "getAuthStatus"> | undefined;
    readonly workspaceStore?: typeof defaultWorkspaceStore | undefined;
    readonly WebSocket?: WebSocketConstructor | undefined;
    readonly reconnectDelaysMs?: readonly number[] | undefined;
    readonly minRefreshDurationMs?: number | undefined;
    readonly authProbeFailureThreshold?: number | undefined;
    readonly onUnauthorized?: (() => void) | undefined;
    readonly onError?: ((message: string) => void) | undefined;
}

/** Public workspace synchronization actions returned by {@link useWorkspaceSync}. */
export interface WorkspaceSync {
    /** Triggers an immediate HTTP catalog refresh with single-flight protection. */
    readonly refresh: () => void;
}

/** Imperative workspace sync controller for React integration and unit tests. */
export interface WorkspaceSyncController extends WorkspaceSync {
    start(): void;
    stop(): void;
    handleVisibilityChange(visible: boolean): void;
}

function defaultNotifyError(message: string): void {
    showError({
        id: "workspace-sync",
        title: "Cannot refresh sessions",
        description: message,
    });
}

function defaultUnauthorized(): void {
    defaultAuthStore.getState().markUnauthorized();
}

/**
 * Create a framework-free controller that keeps the workspace catalog synchronized over
 * `/ws/workspace`, hydrates cached entries from IndexedDB on startup, reconnects with backoff,
 * probes auth expiry after repeated socket failures, and supports single-flight manual HTTP refreshes.
 */
export function createWorkspaceSyncController(options: WorkspaceSyncOptions = {}): WorkspaceSyncController {
    const apiClient = options.apiClient ?? defaultApiClient;
    const workspaceStore = options.workspaceStore ?? defaultWorkspaceStore;
    const reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    const minRefreshDurationMs = Math.max(0, options.minRefreshDurationMs ?? DEFAULT_MIN_REFRESH_DURATION_MS);
    const authProbeFailureThreshold = Math.max(1, options.authProbeFailureThreshold ?? DEFAULT_AUTH_PROBE_THRESHOLD);
    const onUnauthorized = options.onUnauthorized ?? defaultUnauthorized;
    const onError = options.onError ?? defaultNotifyError;

    let stopped = false;
    let refreshInFlight = false;
    let socket: WorkspaceSocket | null = null;
    let refreshDelayTimer: ReturnType<typeof setTimeout> | undefined;

    const clearRefreshDelayTimer = (): void => {
        if (refreshDelayTimer !== undefined) {
            clearTimeout(refreshDelayTimer);
            refreshDelayTimer = undefined;
        }
    };

    const syncClient = new SyncStreamClient<"catalog", CatalogSyncState, CatalogSnapshot, CatalogDelta>({
        initialState: { sessions: [], updatedAtMs: null },
        reducer: createCatalogSyncReducer(),
        onStateChange(nextState, meta) {
            if (stopped) {
                return;
            }
            switch (meta.source) {
                case "snapshot":
                    workspaceStore.getState().commitSyncedCatalog({
                        sessions: nextState.sessions,
                        updatedAtMs: nextState.updatedAtMs ?? Date.now(),
                        ...(refreshInFlight ? {} : { sync: { kind: "live" } }),
                        persistCache: true,
                    });
                    return;
                case "external_refresh":
                    workspaceStore.getState().commitSyncedCatalog({
                        sessions: nextState.sessions,
                        updatedAtMs: nextState.updatedAtMs ?? Date.now(),
                        sync: { kind: "live" },
                        persistCache: true,
                    });
                    return;
                case "replay":
                    workspaceStore.getState().commitSyncedCatalog({
                        sessions: nextState.sessions,
                        updatedAtMs: nextState.updatedAtMs,
                        ...(refreshInFlight ? {} : { sync: { kind: "live" } }),
                    });
                    return;
                case "delta":
                    workspaceStore.getState().commitSyncedCatalog({
                        sessions: nextState.sessions,
                        updatedAtMs: nextState.updatedAtMs,
                    });
                    return;
                case "hydrate":
                case "phase":
                    return;
                default:
                    assertNever(meta.source);
            }
        },
        onResyncRequired(reason) {
            if (stopped) {
                return;
            }
            const current = socket;
            socket = null;
            current?.close(WS_CLOSE_CODE.normal, "Catalog resync");
            reconnect.scheduleResync(reason);
        },
    });

    const openSocket = (): void => {
        if (stopped || socket !== null) {
            return;
        }
        syncClient.markConnecting();
        const createdSocket = connectWorkspaceSocket({
            WebSocket: options.WebSocket,
            cursor: syncClient.handshakeCursor(),
            handlers: {
                onMessage(message) {
                    if (stopped || socket !== createdSocket) {
                        return;
                    }
                    if (message.type === "sync:snapshot" || message.type === "sync:replay") {
                        reconnect.markConnected();
                    }
                    syncClient.handleFrame(message);
                },
                onClose() {
                    if (socket !== createdSocket) {
                        return;
                    }
                    socket = null;
                    if (!stopped) {
                        reconnect.notifyClosed();
                    }
                },
            },
        });
        socket = createdSocket;
    };

    const reconnect = createReconnectController({
        delaysMs: reconnectDelays,
        authProbeFailureThreshold,
        authProbe: () => apiClient.getAuthStatus(),
        onUnauthorized: () => {
            stopped = true;
            clearRefreshDelayTimer();
            const current = socket;
            socket = null;
            current?.close(WS_CLOSE_CODE.normal, "Unauthorized");
            onUnauthorized();
        },
        onScheduled(nextAttempt) {
            if (stopped || socket !== null) {
                return;
            }
            syncClient.markReconnecting(nextAttempt);
            if (!refreshInFlight) {
                workspaceStore.getState().setSync({ kind: "reconnecting", attempt: nextAttempt });
            }
        },
        onReconnect() {
            openSocket();
        },
        listenBrowserEvents: false,
    });

    return {
        start() {
            stopped = false;
            refreshInFlight = false;
            reconnect.start();
            void workspaceStore.getState().hydrateCatalog();
            openSocket();
        },
        stop() {
            stopped = true;
            refreshInFlight = false;
            reconnect.stop();
            syncClient.reset({ sessions: [], updatedAtMs: null }, null);
            clearRefreshDelayTimer();
            const current = socket;
            socket = null;
            current?.close(WS_CLOSE_CODE.normal, "Workspace closed");
        },
        handleVisibilityChange(visible) {
            if (visible && !stopped && socket === null) {
                reconnect.wake();
            }
        },
        refresh() {
            if (stopped || refreshInFlight) {
                return;
            }
            refreshInFlight = true;
            syncClient.beginExternalRefresh();
            const startedAtMs = Date.now();
            workspaceStore.getState().setSync({ kind: "syncing" });

            const afterMinDuration = (task: () => void): void => {
                const remainingMs = Math.max(0, minRefreshDurationMs - (Date.now() - startedAtMs));
                if (remainingMs === 0) {
                    task();
                    return;
                }
                clearRefreshDelayTimer();
                refreshDelayTimer = setTimeout(() => {
                    refreshDelayTimer = undefined;
                    task();
                }, remainingMs);
            };

            void apiClient
                .listSessions()
                .then((response) => {
                    afterMinDuration(() => {
                        refreshInFlight = false;
                        if (stopped) {
                            return;
                        }
                        reconnect.markConnected();
                        const applied = syncClient.completeExternalRefresh(
                            { sessions: response.sessions, updatedAtMs: response.updatedAtMs },
                            response.cursor,
                        );
                        if (!applied) {
                            const phase = syncClient.currentPhase;
                            if (phase.kind === "live") {
                                workspaceStore.getState().setSync({ kind: "live" });
                            } else if (phase.kind === "reconnecting") {
                                workspaceStore.getState().setSync({ kind: "reconnecting", attempt: phase.attempt });
                            } else if (phase.kind === "error") {
                                workspaceStore.getState().setSync({ kind: "failed", message: phase.message });
                            } else {
                                workspaceStore.getState().setSync({ kind: "idle" });
                            }
                        }
                        if (socket === null) {
                            reconnect.wake();
                        }
                    });
                })
                .catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    Log.warn(`Cannot refresh workspace sessions: ${message}`);
                    afterMinDuration(() => {
                        refreshInFlight = false;
                        syncClient.failExternalRefresh();
                        if (stopped) {
                            return;
                        }
                        workspaceStore.getState().setSync({ kind: "failed", message });
                        onError(message);
                    });
                });
        },
    };
}

/**
 * Subscribe the workspace shell to live `/ws/workspace` catalog updates and provide a
 * single-flight manual refresh trigger.
 */
export function useWorkspaceSync(options: WorkspaceSyncOptions = {}): WorkspaceSync {
    const controllerRef = useRef<WorkspaceSyncController | null>(null);
    const {
        apiClient,
        workspaceStore,
        WebSocket: WebSocketCtor,
        reconnectDelaysMs,
        minRefreshDurationMs,
        authProbeFailureThreshold,
        onUnauthorized,
        onError,
    } = options;

    useEffect(() => {
        const controller = createWorkspaceSyncController({
            apiClient,
            workspaceStore,
            WebSocket: WebSocketCtor,
            reconnectDelaysMs,
            minRefreshDurationMs,
            authProbeFailureThreshold,
            onUnauthorized,
            onError,
        });
        controllerRef.current = controller;
        controller.start();

        const onVisibilityChange = (): void => {
            controller.handleVisibilityChange(document.visibilityState === "visible");
        };
        document.addEventListener("visibilitychange", onVisibilityChange);

        return () => {
            document.removeEventListener("visibilitychange", onVisibilityChange);
            controller.stop();
            if (controllerRef.current === controller) {
                controllerRef.current = null;
            }
        };
    }, [
        WebSocketCtor,
        apiClient,
        authProbeFailureThreshold,
        minRefreshDurationMs,
        onError,
        onUnauthorized,
        reconnectDelaysMs,
        workspaceStore,
    ]);

    const refresh = useCallback(() => {
        controllerRef.current?.refresh();
    }, []);

    return { refresh };
}
