import { parseSessionId, type SessionId } from "@pivia/protocol";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Outlet, useNavigate, useParams } from "react-router";

import { Drawer } from "@components";
import { useMediaQuery, useNow } from "@/hooks";
import { Clipboard, Log } from "@/lib";
import { showError, showWarning } from "@/lib/toast";
import {
    ApiClientError,
    apiClient as defaultApiClient,
    type ApiClient,
    type WebSocketConstructor,
} from "@/lib/transport";
import {
    useAuthStore as defaultAuthStore,
    useSessionStore as defaultSessionStore,
    useWorkspaceStore as defaultWorkspaceStore,
} from "@/stores";
import { buildWorkspaceModel, collectKnownCwds, selectedSession } from "@/stores/workspace";

import {
    CreateSessionDialog,
    RenameSessionDialog,
    SettingsDialog,
    Sidebar,
    Topbar,
    type CreateSessionResult,
    type CreateSessionSubmitOptions,
    type SettingsAuthAction,
} from "./components";
import { useWorkspaceSync } from "./useWorkspaceSync";
import styles from "./WorkspaceLayout.module.css";

/** Below this width the sidebar becomes a drawer instead of a persistent column. */
const NARROW_QUERY = "(max-width: 720px)";

/** Subset of {@link ApiClient} used by {@link WorkspaceLayout}. */
export type WorkspaceApiClient = Pick<
    ApiClient,
    "listSessions" | "getAuthStatus" | "listDirectories" | "createSession" | "closeSession"
>;

/** Optional dependency injection props used by layout tests and Storybook harnesses. */
export interface WorkspaceLayoutProps {
    readonly apiClient?: WorkspaceApiClient | undefined;
    readonly workspaceStore?: typeof defaultWorkspaceStore | undefined;
    readonly sessionStore?: typeof defaultSessionStore | undefined;
    readonly authStore?: typeof defaultAuthStore | undefined;
    readonly WebSocket?: WebSocketConstructor | undefined;
    readonly minRefreshDurationMs?: number | undefined;
}

/**
 * The workspace shell.
 *
 * Owns the sidebar column or drawer, topbar, settings and create-session dialogs, and live
 * catalog sync, while rendering the active session column through `<Outlet />` so the shell
 * never remounts when switching sessions.
 */
export function WorkspaceLayout(props: WorkspaceLayoutProps = {}): ReactElement {
    const client = props.apiClient ?? defaultApiClient;
    const workspaceStore = props.workspaceStore ?? defaultWorkspaceStore;
    const sessionStore = props.sessionStore ?? defaultSessionStore;
    const authStore = props.authStore ?? defaultAuthStore;

    const { sessionId: rawSessionId } = useParams<{ sessionId?: string }>();
    const navigate = useNavigate();
    const narrow = useMediaQuery(NARROW_QUERY);
    const nowMs = useNow();

    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [renameSessionId, setRenameSessionId] = useState<SessionId | null>(null);
    const [renamePending, setRenamePending] = useState(false);
    const [renameError, setRenameError] = useState<string | null>(null);
    const [compactingIds, setCompactingIds] = useState<ReadonlySet<SessionId>>(() => new Set());
    const [signingOut, setSigningOut] = useState(false);
    const [closingIds, setClosingIds] = useState<ReadonlySet<SessionId>>(() => new Set());

    const activeSessionId = sessionStore((state) => state.sessionId);
    const activeSessionStatus = sessionStore((state) => state.status);
    const activeSessionState = sessionStore((state) => state.state);

    const authRequired = authStore((state) => state.authRequired);
    const clearAuthError = authStore((state) => state.clearError);
    const logout = authStore((state) => state.logout);

    const sessions = workspaceStore((state) => state.sessions);
    const updatedAtMs = workspaceStore((state) => state.updatedAtMs);
    const sync = workspaceStore((state) => state.sync);
    const query = workspaceStore((state) => state.query);
    const selectedId = workspaceStore((state) => state.selectedId);
    const pins = workspaceStore((state) => state.pins);
    const collapsed = workspaceStore((state) => state.collapsed);
    const setQuery = workspaceStore((state) => state.setQuery);
    const select = workspaceStore((state) => state.select);
    const togglePinned = workspaceStore((state) => state.togglePinned);
    const toggleFolder = workspaceStore((state) => state.toggleFolder);
    const applyCatalogDelta = workspaceStore((state) => state.applyCatalogDelta);

    const routeSessionId = useMemo(
        () => (rawSessionId === undefined ? null : parseSessionId(rawSessionId)),
        [rawSessionId],
    );

    useEffect(() => {
        select(routeSessionId);
    }, [routeSessionId, select]);

    useEffect(() => {
        if (
            routeSessionId !== null &&
            sync.kind === "live" &&
            !sessions.some((session) => session.id === routeSessionId)
        ) {
            select(null);
            void navigate("/workspace", { replace: true });
        }
    }, [navigate, routeSessionId, select, sessions, sync.kind]);

    const handleUnauthorized = useCallback(() => {
        authStore.getState().markUnauthorized();
    }, [authStore]);

    const { refresh } = useWorkspaceSync({
        apiClient: client,
        workspaceStore,
        WebSocket: props.WebSocket,
        minRefreshDurationMs: props.minRefreshDurationMs,
        onUnauthorized: handleUnauthorized,
    });

    const model = useMemo(
        () => buildWorkspaceModel({ sessions, pins, query, selectedId, collapsed }),
        [collapsed, pins, query, selectedId, sessions],
    );
    const current = useMemo(() => selectedSession(sessions, selectedId), [selectedId, sessions]);
    const knownCwds = useMemo(() => collectKnownCwds(sessions), [sessions]);

    const handleCopySessionId = useCallback((id: SessionId) => {
        void Clipboard.copy(id).catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause);
            Log.warn(`Cannot copy session ID: ${message}`);
            showError({
                id: "session-copy-id",
                title: "Cannot copy session ID",
                description: message,
            });
        });
    }, []);

    const handleSelect = useCallback(
        (id: SessionId) => {
            select(id);
            void navigate(`/workspace/${encodeURIComponent(id)}`);
            if (narrow) {
                setDrawerOpen(false);
            }
        },
        [narrow, navigate, select],
    );

    const handleCreateSession = useCallback(
        async (cwd: string, options?: CreateSessionSubmitOptions): Promise<CreateSessionResult> => {
            try {
                const response = await client.createSession(cwd, options);
                applyCatalogDelta({ op: "upsert", item: response.session });
                select(response.session.id);
                void navigate(`/workspace/${encodeURIComponent(response.session.id)}`);
                if (narrow) {
                    setDrawerOpen(false);
                }
                return { ok: true, session: response.session };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (error instanceof ApiClientError && error.code === "directory_not_found") {
                    return { ok: false, code: "directory_not_found", message };
                }
                return { ok: false, code: "error", message };
            }
        },
        [applyCatalogDelta, client, narrow, navigate, select],
    );

    const handleListDirectories = useCallback((path?: string) => client.listDirectories(path), [client]);

    const handleCloseSession = useCallback(
        async (id: SessionId) => {
            if (closingIds.has(id)) {
                return;
            }
            setClosingIds((prev) => new Set(prev).add(id));
            try {
                const response = await client.closeSession(id);
                if (!response.closed) {
                    showWarning({
                        id: `session-close-idle-${id}`,
                        title: "Session is not running",
                        description: "This session does not have an active runtime to close.",
                    });
                    return;
                }
                if (id === routeSessionId) {
                    select(null);
                    void navigate("/workspace", { replace: true });
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                Log.warn(`Cannot close session ${id}: ${message}`);
                showError({
                    id: `session-close-${id}`,
                    title: "Cannot close session",
                    description: message,
                });
            } finally {
                setClosingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
            }
        },
        [client, closingIds, navigate, routeSessionId, select],
    );

    const handleCloseSessionClick = useCallback(
        (id: SessionId) => {
            void handleCloseSession(id);
        },
        [handleCloseSession],
    );

    const activeRuntimeReady = current !== null && activeSessionId === current.id && activeSessionStatus === "open";

    const handleCompactSession = useCallback(
        (id: SessionId) => {
            if (!activeRuntimeReady || activeSessionId !== id || compactingIds.has(id)) {
                return;
            }
            setCompactingIds((prev) => new Set(prev).add(id));
            void sessionStore
                .getState()
                .sendCommand({ type: "compact" })
                .then((response) => {
                    if (!response.success) {
                        showError({
                            id: `session-compact-${id}`,
                            title: "Cannot compact session",
                            description: response.error,
                        });
                    }
                })
                .catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    showError({
                        id: `session-compact-${id}`,
                        title: "Cannot compact session",
                        description: message,
                    });
                })
                .finally(() => {
                    setCompactingIds((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                });
        },
        [activeRuntimeReady, activeSessionId, compactingIds, sessionStore],
    );

    const handleRenameSubmit = useCallback(
        async (nextName: string) => {
            if (current === null || current.id !== renameSessionId || renamePending) {
                return;
            }
            if (!activeRuntimeReady) {
                setRenameError("Session is not connected.");
                return;
            }
            setRenamePending(true);
            setRenameError(null);
            try {
                const response = await sessionStore.getState().sendCommand({
                    type: "set_session_name",
                    name: nextName,
                });
                if (!response.success) {
                    setRenameError(response.error);
                    return;
                }
                setRenameSessionId(null);
            } catch (error) {
                setRenameError(error instanceof Error ? error.message : String(error));
            } finally {
                setRenamePending(false);
            }
        },
        [activeRuntimeReady, current, renamePending, renameSessionId, sessionStore],
    );

    const handleSignOut = useCallback(async () => {
        if (signingOut) {
            return;
        }
        setSigningOut(true);
        clearAuthError();
        await logout();

        const auth = authStore.getState();
        if (auth.phase === "unauthenticated") {
            workspaceStore.getState().reset();
            // AppLayout replaces this shell with AuthGate on the same state change.
            return;
        }

        setSigningOut(false);
        if (auth.error !== null) {
            showError({
                id: "auth-logout",
                title: "Cannot sign out",
                description: auth.error,
            });
        }
    }, [authStore, clearAuthError, logout, signingOut, workspaceStore]);

    const authAction: SettingsAuthAction = authRequired
        ? {
              kind: "sign-out",
              pending: signingOut,
              onSignOut: () => {
                  void handleSignOut();
              },
          }
        : { kind: "none" };

    const origin = typeof globalThis.location?.origin === "string" ? globalThis.location.origin : "Single host";

    const sidebar = (
        <Sidebar
            model={model}
            sync={sync}
            query={query}
            nowMs={nowMs}
            closingIds={closingIds}
            onQueryChange={setQuery}
            onRefresh={refresh}
            onNewSession={() => {
                if (narrow) {
                    setDrawerOpen(false);
                }
                setCreateOpen(true);
            }}
            onOpenSettings={() => {
                setSettingsOpen(true);
            }}
            onSelect={handleSelect}
            onTogglePinned={togglePinned}
            onToggleFolder={toggleFolder}
            onCopySessionId={handleCopySessionId}
            onCloseSession={handleCloseSessionClick}
        />
    );

    return (
        <div className={styles.window}>
            {narrow ? (
                <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} side="left" label="Sessions">
                    {sidebar}
                </Drawer>
            ) : (
                <aside
                    className={styles.sidebar}
                    data-open={sidebarOpen}
                    aria-label="Sessions"
                    aria-hidden={sidebarOpen ? undefined : true}
                    inert={!sidebarOpen}
                >
                    {sidebar}
                </aside>
            )}
            <div className={styles.column}>
                <Topbar
                    session={current}
                    sidebarOpen={narrow ? drawerOpen : sidebarOpen}
                    closing={current !== null && closingIds.has(current.id)}
                    compacting={
                        (current !== null && compactingIds.has(current.id)) || activeSessionState?.isCompacting === true
                    }
                    runtimeReady={activeRuntimeReady}
                    onToggleSidebar={() => {
                        if (narrow) {
                            setDrawerOpen((open) => !open);
                        } else {
                            setSidebarOpen((open) => !open);
                        }
                    }}
                    onCopySessionId={handleCopySessionId}
                    onCloseSession={handleCloseSessionClick}
                    onRenameSession={(target) => {
                        setRenameError(null);
                        setRenameSessionId(target.id);
                    }}
                    onCompactSession={handleCompactSession}
                />
                <Outlet />
            </div>
            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                origin={origin}
                sessionCount={model.total}
                updatedAtMs={updatedAtMs}
                sync={sync}
                onRefresh={refresh}
                authAction={authAction}
            />
            <CreateSessionDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                knownCwds={knownCwds}
                narrow={narrow}
                onListDirectories={handleListDirectories}
                onCreate={handleCreateSession}
            />
            <RenameSessionDialog
                open={renameSessionId !== null && current !== null && current.id === renameSessionId}
                onOpenChange={(open) => {
                    if (!open) {
                        setRenameSessionId(null);
                    }
                }}
                initialName={current?.named ? current.title : ""}
                pending={renamePending}
                error={renameError}
                onSubmit={handleRenameSubmit}
            />
        </div>
    );
}
