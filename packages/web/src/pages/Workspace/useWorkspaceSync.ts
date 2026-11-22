import { useCallback, useEffect, useRef } from "react";

import { assertNever, SESSION_CLOSE_CODE, type CatalogCursor, type WorkspaceWsCatalogEvent } from "@pivia/protocol";

import { Log } from "@/lib/log";
import { showError } from "@/lib/toast";
import { apiClient as defaultApiClient, type ApiClient } from "@/lib/transport/http";
import type { SessionSocketConstructor } from "@/lib/transport/session-socket";
import { connectWorkspaceSocket, type WorkspaceSocket } from "@/lib/transport/workspace-socket";
import { useAuthStore as defaultAuthStore, useWorkspaceStore as defaultWorkspaceStore } from "@/stores";
import { canApplyCatalogSnapshot, mergeRefreshSnapshot } from "@/stores/workspace/model";

/** Exponential backoff intervals between `/ws/workspace` reconnect attempts. */
export const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** Minimum visible duration of a manual refresh so fast local responses still show feedback. */
export const DEFAULT_MIN_REFRESH_DURATION_MS = 300;

/** Consecutive WebSocket close failures before probing `/api/auth/status` for expiry. */
export const DEFAULT_AUTH_PROBE_THRESHOLD = 2;

/** Dependencies injected into {@link createWorkspaceSyncController} and {@link useWorkspaceSync}. */
export interface WorkspaceSyncOptions {
    readonly apiClient?: Pick<ApiClient, "listSessions" | "getAuthStatus"> | undefined;
    readonly workspaceStore?: typeof defaultWorkspaceStore | undefined;
    readonly WebSocket?: SessionSocketConstructor | undefined;
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

type RefreshState =
    | { readonly kind: "idle" }
    | {
          readonly kind: "in_flight";
          readonly buffered: WorkspaceWsCatalogEvent[];
          wsSnapshotCursor: CatalogCursor | null;
      };

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
    let refreshState: RefreshState = { kind: "idle" };
    let probingAuth = false;
    let attempt = 0;
    let consecutiveCloseFailures = 0;
    let socket: WorkspaceSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshDelayTimer: ReturnType<typeof setTimeout> | undefined;

    const clearReconnectTimer = (): void => {
        if (reconnectTimer !== undefined) {
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
        }
    };

    const clearRefreshDelayTimer = (): void => {
        if (refreshDelayTimer !== undefined) {
            clearTimeout(refreshDelayTimer);
            refreshDelayTimer = undefined;
        }
    };

    const scheduleReconnect = (): void => {
        // A visibility change or a manual refresh may already have opened a new socket while an
        // auth probe was in flight; that socket owns the connection state now.
        if (stopped || reconnectTimer !== undefined || socket !== null) {
            return;
        }
        attempt += 1;
        workspaceStore.getState().markReconnecting(attempt);
        const delayMs = reconnectDelays[Math.min(attempt - 1, reconnectDelays.length - 1)] ?? 1_000;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            if (!stopped && socket === null) {
                openSocket();
            }
        }, delayMs);
    };

    const probeAuthOrReconnect = (): void => {
        if (stopped) {
            return;
        }
        if (consecutiveCloseFailures < authProbeFailureThreshold) {
            scheduleReconnect();
            return;
        }
        if (probingAuth) {
            return;
        }
        probingAuth = true;
        void apiClient
            .getAuthStatus()
            .then((status) => {
                probingAuth = false;
                if (stopped) {
                    return;
                }
                if (status.authRequired && !status.authenticated) {
                    stopped = true;
                    clearReconnectTimer();
                    clearRefreshDelayTimer();
                    onUnauthorized();
                    return;
                }
                scheduleReconnect();
            })
            .catch(() => {
                probingAuth = false;
                if (!stopped) {
                    scheduleReconnect();
                }
            });
    };

    const openSocket = (): void => {
        if (stopped || socket !== null) {
            return;
        }
        clearReconnectTimer();
        socket = connectWorkspaceSocket({
            WebSocket: options.WebSocket,
            handlers: {
                onMessage(message) {
                    if (stopped) {
                        return;
                    }
                    switch (message.type) {
                        case "catalog_snapshot": {
                            attempt = 0;
                            consecutiveCloseFailures = 0;
                            const cursor: CatalogCursor = { epoch: message.catalogEpoch, seq: message.catalogSeq };
                            if (refreshState.kind === "in_flight") {
                                // A fresh WS snapshot supersedes any events buffered before it.
                                refreshState.buffered.length = 0;
                                refreshState.wsSnapshotCursor = cursor;
                            }
                            workspaceStore.getState().applyCatalog(message.sessions, message.updatedAtMs, cursor);
                            return;
                        }
                        case "session_upserted":
                        case "session_updated":
                        case "session_removed":
                            if (refreshState.kind === "in_flight") {
                                refreshState.buffered.push(message);
                            }
                            workspaceStore.getState().applyCatalogEvent(message);
                            return;
                        default:
                            assertNever(message, "Unknown workspace socket message");
                    }
                },
                onClose() {
                    socket = null;
                    if (!stopped) {
                        consecutiveCloseFailures += 1;
                        probeAuthOrReconnect();
                    }
                },
            },
        });
    };

    return {
        start() {
            stopped = false;
            consecutiveCloseFailures = 0;
            void workspaceStore.getState().hydrateCatalog();
            openSocket();
        },
        stop() {
            stopped = true;
            refreshState = { kind: "idle" };
            probingAuth = false;
            clearReconnectTimer();
            clearRefreshDelayTimer();
            const current = socket;
            socket = null;
            current?.close(SESSION_CLOSE_CODE.normal, "Workspace closed");
        },
        handleVisibilityChange(visible) {
            if (visible && !stopped && socket === null) {
                clearReconnectTimer();
                openSocket();
            }
        },
        refresh() {
            if (stopped || refreshState.kind !== "idle") {
                return;
            }
            refreshState = { kind: "in_flight", buffered: [], wsSnapshotCursor: null };
            const startedAtMs = Date.now();
            workspaceStore.getState().beginSync();

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
                        const currentRefresh = refreshState;
                        refreshState = { kind: "idle" };
                        if (stopped) {
                            return;
                        }
                        consecutiveCloseFailures = 0;
                        const responseCursor: CatalogCursor = {
                            epoch: response.catalogEpoch,
                            seq: response.catalogSeq,
                        };
                        const supersededByWsSnapshot =
                            currentRefresh.kind === "in_flight" &&
                            currentRefresh.wsSnapshotCursor !== null &&
                            !canApplyCatalogSnapshot(currentRefresh.wsSnapshotCursor, responseCursor);
                        if (!supersededByWsSnapshot) {
                            const buffered = currentRefresh.kind === "in_flight" ? currentRefresh.buffered : [];
                            const merged = mergeRefreshSnapshot(
                                { sessions: response.sessions, cursor: responseCursor },
                                buffered,
                            );
                            workspaceStore
                                .getState()
                                .applyCatalog(merged.sessions, response.scannedAtMs, merged.cursor);
                        }
                        if (socket === null) {
                            attempt = 0;
                            clearReconnectTimer();
                            openSocket();
                        }
                    });
                })
                .catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    Log.warn(`Cannot refresh workspace sessions: ${message}`);
                    afterMinDuration(() => {
                        refreshState = { kind: "idle" };
                        if (stopped) {
                            return;
                        }
                        workspaceStore.getState().failSync(message);
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
