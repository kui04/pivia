import { parseSessionId, type SessionId } from "@pivia/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router";

import { Drawer, type DropDockZone, type PaneSizePx } from "@components";
import { startDragPayload } from "@components/SplitPane/dnd";
import { canSplitWithinMinSize } from "@components/SplitPane/tree";
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
    sessionPool as defaultSessionPool,
    useAuthStore as defaultAuthStore,
    useWorkspaceStore as defaultWorkspaceStore,
} from "@/stores";
import { createSessionPool, type SessionPool } from "@/stores/session";
import { buildWorkspaceModel, collectKnownCwds, selectedSession } from "@/stores/workspace";

import {
    CreateSessionDialog,
    RenameSessionDialog,
    SettingsDialog,
    Sidebar,
    SplitWorkspace,
    type CreateSessionResult,
    type CreateSessionSubmitOptions,
    type SettingsAuthAction,
    type WorkspaceDragSource,
} from "./components";
import {
    closePane,
    createInitialSplitLayout,
    detachSessionFromLayout,
    dockPaneAtPane,
    dockSessionAtPane,
    findLeafPane,
    findPaneBySessionId,
    focusPane,
    listLeafPanes,
    loadWorkspaceSplitLayout,
    MAX_WORKSPACE_PANES,
    MIN_PANE_HEIGHT_PX,
    MIN_PANE_WIDTH_PX,
    openSessionInFocusedPane,
    openSessionInSplit,
    pruneMissingSessions,
    resizeSplit,
    saveWorkspaceSplitLayout,
    syncLayoutWithRoute,
    WORKSPACE_DRAG_MIME,
    type PaneId,
    type SplitAxis,
    type SplitId,
    type WorkspaceSplitLayout,
} from "./splitLayout";
import { parseWorkspaceSessionRoute } from "./useWorkspaceSession";
import { useWorkspaceSync } from "./useWorkspaceSync";
import styles from "./WorkspaceLayout.module.css";

/** Below this width the sidebar becomes a drawer and secondary split panes collapse behind the focused pane. */
const NARROW_QUERY = "(max-width: 720px)";

/** Subset of {@link ApiClient} used by {@link WorkspaceLayout}. */
export type WorkspaceApiClient = Pick<
    ApiClient,
    "listSessions" | "getAuthStatus" | "listDirectories" | "createSession" | "closeSession"
>;

/** Optional dependency injection props used by layout tests and Storybook harnesses. */
export interface WorkspaceLayoutProps {
    readonly apiClient?: WorkspaceApiClient | undefined;
    readonly sessionApiClient?: Pick<ApiClient, "getSession"> | undefined;
    readonly workspaceStore?: typeof defaultWorkspaceStore | undefined;
    readonly sessionPool?: SessionPool | undefined;
    readonly authStore?: typeof defaultAuthStore | undefined;
    readonly WebSocket?: WebSocketConstructor | undefined;
    readonly minRefreshDurationMs?: number | undefined;
    /** Whether to persist and restore split layouts via `localStorage` (defaults to `true`). */
    readonly persistLayout?: boolean | undefined;
    /** Optional starting split layout used by tests and Storybook stories. */
    readonly initialLayout?: WorkspaceSplitLayout | undefined;
    /** Minimum horizontal pane width (px) required when splitting or resizing. Defaults to {@link MIN_PANE_WIDTH_PX}. */
    readonly minPaneWidthPx?: number | undefined;
    /** Minimum vertical pane height (px) required when splitting or resizing. Defaults to {@link MIN_PANE_HEIGHT_PX}. */
    readonly minPaneHeightPx?: number | undefined;
    /** Forwarded to Markdown links rendered inside transcripts. */
    readonly onOpenLink?: ((href: string) => void) | undefined;
}

function openExternalLink(href: string): void {
    window.open(href, "_blank", "noopener,noreferrer");
}

function focusedRouteSessionId(layout: WorkspaceSplitLayout): string | undefined {
    const focused = findLeafPane(layout.root, layout.focusedPaneId);
    return focused?.data.kind === "session" ? focused.data.sessionId : undefined;
}

function hasGetSession(client: WorkspaceApiClient): client is WorkspaceApiClient & Pick<ApiClient, "getSession"> {
    return "getSession" in client && typeof (client as { getSession?: unknown }).getSession === "function";
}

/**
 * The workspace shell.
 *
 * Owns the sidebar column or drawer, settings/create/rename dialogs, live catalog sync, split-pane
 * layout state, and multi-session background keep-alive pool.
 */
export function WorkspaceLayout(props: WorkspaceLayoutProps = {}): ReactElement {
    const client = props.apiClient ?? defaultApiClient;
    const workspaceStore = props.workspaceStore ?? defaultWorkspaceStore;
    const authStore = props.authStore ?? defaultAuthStore;
    const persistLayout = props.persistLayout ?? true;
    const minPaneWidthPx = props.minPaneWidthPx ?? MIN_PANE_WIDTH_PX;
    const minPaneHeightPx = props.minPaneHeightPx ?? MIN_PANE_HEIGHT_PX;
    const onOpenLink = props.onOpenLink ?? openExternalLink;

    const { sessionId: rawSessionId } = useParams<{ sessionId?: string }>();
    const navigate = useNavigate();
    const narrow = useMediaQuery(NARROW_QUERY);
    const nowMs = useNow();

    const [fallbackPool] = useState<SessionPool | null>(() => {
        if (props.sessionPool !== undefined) {
            return null;
        }
        if (props.WebSocket === undefined && props.sessionApiClient === undefined) {
            return null;
        }
        const sessionApi = props.sessionApiClient ?? (hasGetSession(client) ? client : defaultApiClient);
        return createSessionPool({
            apiClient: sessionApi,
            ...(props.WebSocket === undefined ? {} : { WebSocket: props.WebSocket }),
            onSessionMissing: (missingId) => {
                workspaceStore.getState().applyCatalogDelta({ op: "remove", id: missingId });
            },
        });
    });

    const activePool = props.sessionPool ?? fallbackPool ?? defaultSessionPool;

    useEffect(() => {
        if (fallbackPool === null) {
            return undefined;
        }
        return () => {
            fallbackPool.clearAll();
        };
    }, [fallbackPool]);

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
    const [activeDrag, setActiveDrag] = useState<WorkspaceDragSource>(null);
    const [leafSizes, setLeafSizes] = useState<ReadonlyMap<PaneId, PaneSizePx>>(() => new Map());
    const leafSizesRef = useRef(leafSizes);

    const handleLeafSizesChange = useCallback((nextSizes: ReadonlyMap<PaneId, PaneSizePx>) => {
        leafSizesRef.current = nextSizes;
        setLeafSizes(nextSizes);
    }, []);

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

    const [layout, setLayout] = useState<WorkspaceSplitLayout>(() => {
        const initialRoute = parseWorkspaceSessionRoute(rawSessionId);
        const restored =
            props.initialLayout ?? (persistLayout ? loadWorkspaceSplitLayout() : null) ?? createInitialSplitLayout();
        return initialRoute.kind === "none" ? restored : syncLayoutWithRoute(restored, initialRoute);
    });
    const layoutRef = useRef(layout);

    const expectedRouteRef = useRef<string | undefined>(rawSessionId);

    const commitLayout = useCallback(
        (
            next: WorkspaceSplitLayout,
            options: { readonly syncRoute?: boolean; readonly replaceRoute?: boolean } = {},
        ) => {
            if (next === layoutRef.current) {
                return;
            }
            layoutRef.current = next;
            setLayout(next);
            if (persistLayout) {
                saveWorkspaceSplitLayout(next);
            }
            const nextFocusedSession = focusedRouteSessionId(next);
            const parsedSelected = nextFocusedSession === undefined ? null : parseSessionId(nextFocusedSession);
            select(parsedSelected);

            if (options.syncRoute === false) {
                return;
            }
            const focusedPane = findLeafPane(next.root, next.focusedPaneId);
            if (focusedPane?.data.kind === "invalid") {
                return;
            }
            if (nextFocusedSession !== expectedRouteRef.current) {
                expectedRouteRef.current = nextFocusedSession;
                const path =
                    nextFocusedSession === undefined
                        ? "/workspace"
                        : `/workspace/${encodeURIComponent(nextFocusedSession)}`;
                void navigate(path, options.replaceRoute ? { replace: true } : undefined);
            }
        },
        [navigate, persistLayout, select],
    );

    // Keep sidebar selection & URL aligned with initial restored layout on first mount.
    useEffect(() => {
        const initialFocused = focusedRouteSessionId(layoutRef.current);
        select(initialFocused === undefined ? null : parseSessionId(initialFocused));
        if (rawSessionId === undefined && initialFocused !== undefined) {
            expectedRouteRef.current = initialFocused;
            void navigate(`/workspace/${encodeURIComponent(initialFocused)}`, { replace: true });
        }
        // Run once on mount for restored layouts; subsequent route changes are handled below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // React to external URL changes (browser Back/Forward or link navigation).
    useEffect(() => {
        if (rawSessionId === expectedRouteRef.current) {
            return;
        }
        expectedRouteRef.current = rawSessionId;
        const nextRoute = parseWorkspaceSessionRoute(rawSessionId);
        const nextLayout = syncLayoutWithRoute(layoutRef.current, nextRoute);
        commitLayout(nextLayout, { syncRoute: false });
    }, [commitLayout, rawSessionId]);

    // Clear panes whose sessions disappeared from the live catalog.
    useEffect(() => {
        if (sync.kind !== "live") {
            return;
        }
        const validIds = new Set(sessions.map((session) => session.id));
        const current = layoutRef.current;
        const pruned = pruneMissingSessions(current, validIds);
        commitLayout(pruned, { replaceRoute: true });
    }, [commitLayout, sessions, sync.kind]);

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
    const renameTarget = useMemo(() => selectedSession(sessions, renameSessionId), [renameSessionId, sessions]);
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
            commitLayout(openSessionInFocusedPane(layoutRef.current, id));
            if (narrow) {
                setDrawerOpen(false);
            }
        },
        [commitLayout, narrow],
    );

    const handleSplitSession = useCallback(
        (id: SessionId, axis: SplitAxis) => {
            const current = layoutRef.current;
            const existing = findPaneBySessionId(current.root, id);
            if (existing === null) {
                const focused = findLeafPane(current.root, current.focusedPaneId);
                if (focused !== null && focused.data.kind !== "empty") {
                    const focusedSize = leafSizesRef.current.get(current.focusedPaneId);
                    if (!canSplitWithinMinSize(focusedSize, axis, minPaneWidthPx, minPaneHeightPx)) {
                        return;
                    }
                }
            }
            commitLayout(openSessionInSplit(current, id, axis));
            if (narrow) {
                setDrawerOpen(false);
            }
        },
        [commitLayout, minPaneHeightPx, minPaneWidthPx, narrow],
    );

    const handleFocusPane = useCallback(
        (paneId: PaneId) => {
            commitLayout(focusPane(layoutRef.current, paneId));
        },
        [commitLayout],
    );

    const handleClosePane = useCallback(
        (paneId: PaneId) => {
            commitLayout(closePane(layoutRef.current, paneId));
        },
        [commitLayout],
    );

    const handleResizeSplit = useCallback(
        (splitId: SplitId, ratio: number) => {
            commitLayout(resizeSplit(layoutRef.current, splitId, ratio), { syncRoute: false });
        },
        [commitLayout],
    );

    const handleDockSession = useCallback(
        (sessionId: SessionId, targetPaneId: PaneId, zone: DropDockZone) => {
            if (zone !== "center") {
                const axis: SplitAxis = zone === "left" || zone === "right" ? "row" : "column";
                const targetSize = leafSizesRef.current.get(targetPaneId);
                if (!canSplitWithinMinSize(targetSize, axis, minPaneWidthPx, minPaneHeightPx)) {
                    return;
                }
            }
            commitLayout(dockSessionAtPane(layoutRef.current, sessionId, targetPaneId, zone));
        },
        [commitLayout, minPaneHeightPx, minPaneWidthPx],
    );

    const handleDockPane = useCallback(
        (sourcePaneId: PaneId, targetPaneId: PaneId, zone: DropDockZone) => {
            if (zone !== "center") {
                const axis: SplitAxis = zone === "left" || zone === "right" ? "row" : "column";
                const targetSize = leafSizesRef.current.get(targetPaneId);
                if (!canSplitWithinMinSize(targetSize, axis, minPaneWidthPx, minPaneHeightPx)) {
                    return;
                }
            }
            commitLayout(dockPaneAtPane(layoutRef.current, sourcePaneId, targetPaneId, zone));
        },
        [commitLayout, minPaneHeightPx, minPaneWidthPx],
    );

    const handleSessionDragStart = useCallback((id: SessionId, title: string, event: DragEvent<HTMLElement>) => {
        startDragPayload(event.dataTransfer, WORKSPACE_DRAG_MIME.session, id, title);
        setActiveDrag({ kind: "session", sessionId: id });
    }, []);

    const handleSessionDragEnd = useCallback(() => {
        setActiveDrag(null);
    }, []);

    const handleCreateSession = useCallback(
        async (cwd: string, options?: CreateSessionSubmitOptions): Promise<CreateSessionResult> => {
            try {
                const response = await client.createSession(cwd, options);
                applyCatalogDelta({ op: "upsert", item: response.session });
                commitLayout(openSessionInFocusedPane(layoutRef.current, response.session.id));
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
        [applyCatalogDelta, client, commitLayout, narrow],
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
                activePool.detach(id);
                const pane = findPaneBySessionId(layoutRef.current.root, id);
                if (pane !== null) {
                    commitLayout(closePane(layoutRef.current, pane.id), { replaceRoute: true });
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
        [activePool, client, closingIds, commitLayout],
    );

    const handleCloseSessionClick = useCallback(
        (id: SessionId) => {
            void handleCloseSession(id);
        },
        [handleCloseSession],
    );

    const handleDetachSession = useCallback(
        (id: SessionId) => {
            activePool.detach(id);
            commitLayout(detachSessionFromLayout(layoutRef.current, id), { replaceRoute: true });
        },
        [activePool, commitLayout],
    );

    const handleToggleSidebar = useCallback(() => {
        if (narrow) {
            setDrawerOpen((open) => !open);
        } else {
            setSidebarOpen((open) => !open);
        }
    }, [narrow]);

    const handleRenameSession = useCallback((target: { readonly id: SessionId }) => {
        setRenameError(null);
        setRenameSessionId(target.id);
    }, []);

    const handleCompactSession = useCallback(
        (id: SessionId) => {
            const store = activePool.getStore(id);
            if (store === null || store.getState().status !== "open" || compactingIds.has(id)) {
                return;
            }
            setCompactingIds((prev) => new Set(prev).add(id));
            void store
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
        [activePool, compactingIds],
    );

    const handleRenameSubmit = useCallback(
        async (nextName: string) => {
            if (renameSessionId === null || renamePending) {
                return;
            }
            const store = activePool.getStore(renameSessionId);
            if (store === null || store.getState().status !== "open") {
                setRenameError("Session is not connected.");
                return;
            }
            setRenamePending(true);
            setRenameError(null);
            try {
                const response = await store.getState().sendCommand({
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
        [activePool, renamePending, renameSessionId],
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

    // `location` is absent in Node test runs, but the DOM types declare it always present.
    const pageLocation = globalThis.location as Location | undefined;
    const origin = pageLocation?.origin ?? "Single host";

    const focusedSize = leafSizes.get(layout.focusedPaneId);
    const leafCount = useMemo(() => listLeafPanes(layout.root).length, [layout.root]);
    const canSplitRow =
        !narrow &&
        leafCount < MAX_WORKSPACE_PANES &&
        canSplitWithinMinSize(focusedSize, "row", minPaneWidthPx, minPaneHeightPx);
    const canSplitColumn =
        !narrow &&
        leafCount < MAX_WORKSPACE_PANES &&
        canSplitWithinMinSize(focusedSize, "column", minPaneWidthPx, minPaneHeightPx);

    const sidebar = (
        <Sidebar
            model={model}
            sync={sync}
            query={query}
            nowMs={nowMs}
            closingIds={closingIds}
            canSplitRow={canSplitRow}
            canSplitColumn={canSplitColumn}
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
            onSplitSession={narrow ? undefined : handleSplitSession}
            onSessionDragStart={narrow ? undefined : handleSessionDragStart}
            onSessionDragEnd={narrow ? undefined : handleSessionDragEnd}
            onTogglePinned={togglePinned}
            onToggleFolder={toggleFolder}
            onCopySessionId={handleCopySessionId}
            onCloseSession={handleCloseSessionClick}
        />
    );

    return (
        <div className={styles.window} data-dragging={activeDrag !== null || undefined}>
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
                <SplitWorkspace
                    layout={layout}
                    sessionPool={activePool}
                    sessions={sessions}
                    narrow={narrow}
                    sidebarOpen={narrow ? drawerOpen : sidebarOpen}
                    closingIds={closingIds}
                    compactingIds={compactingIds}
                    minPaneWidthPx={minPaneWidthPx}
                    minPaneHeightPx={minPaneHeightPx}
                    activeDrag={activeDrag}
                    onDragSourceChange={setActiveDrag}
                    onToggleSidebar={handleToggleSidebar}
                    onFocusPane={handleFocusPane}
                    onClosePane={handleClosePane}
                    onResizeSplit={handleResizeSplit}
                    onDockSession={handleDockSession}
                    onDockPane={handleDockPane}
                    onLeafSizesChange={handleLeafSizesChange}
                    onCopySessionId={handleCopySessionId}
                    onDetachSession={handleDetachSession}
                    onRenameSession={handleRenameSession}
                    onCompactSession={handleCompactSession}
                    onOpenLink={onOpenLink}
                />
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
                open={renameSessionId !== null && renameTarget !== null && renameTarget.id === renameSessionId}
                onOpenChange={(open) => {
                    if (!open) {
                        setRenameSessionId(null);
                    }
                }}
                initialName={renameTarget?.named ? renameTarget.title : ""}
                pending={renamePending}
                error={renameError}
                onSubmit={handleRenameSubmit}
            />
        </div>
    );
}
