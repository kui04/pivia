import { parseSessionId, type SessionId, type SessionSummary } from "@pivia/protocol";
import { memo, useCallback, useEffect, useMemo, useSyncExternalStore, type DragEvent, type ReactElement } from "react";

import {
    SplitPane,
    type DropDockZone,
    type PaneSizePx,
    type SplitPaneDropConfig,
    type SplitTreeLeaf,
} from "@components";
import { ALL_DOCK_ZONES, getDragData, hasDragType, startDragPayload } from "@components/SplitPane/dnd";
import type { SessionPool, SessionStoreInstance } from "@/stores/session";
import { sessionTitle, type SelectedSession } from "@/stores/workspace";

import {
    findLeafPane,
    listLeafPanes,
    MAX_WORKSPACE_PANES,
    MIN_PANE_HEIGHT_PX,
    MIN_PANE_WIDTH_PX,
    parsePaneId,
    WORKSPACE_DRAG_MIME,
    type PaneId,
    type PaneTarget,
    type SplitId,
    type WorkspaceSplitLayout,
} from "../../splitLayout";
import { SessionPane, type SessionPaneHeaderProps } from "../SessionPane";
import styles from "./SplitWorkspace.module.css";

/** Active internal drag source tracked so `dragover` can suppress no-op self-drops before `drop`. */
export type WorkspaceDragSource =
    | { readonly kind: "session"; readonly sessionId: SessionId }
    | { readonly kind: "pane"; readonly paneId: PaneId }
    | null;

/** Props for {@link SplitWorkspace}. */
export interface SplitWorkspaceProps {
    readonly layout: WorkspaceSplitLayout;
    readonly sessionPool: SessionPool;
    readonly sessions: readonly SessionSummary[];
    readonly narrow: boolean;
    readonly sidebarOpen: boolean;
    readonly closingIds: ReadonlySet<SessionId>;
    readonly compactingIds: ReadonlySet<SessionId>;
    readonly minPaneWidthPx?: number | undefined;
    readonly minPaneHeightPx?: number | undefined;
    readonly activeDrag: WorkspaceDragSource;
    readonly onDragSourceChange: (source: WorkspaceDragSource) => void;
    readonly onToggleSidebar: () => void;
    readonly onFocusPane: (paneId: PaneId) => void;
    readonly onClosePane: (paneId: PaneId) => void;
    readonly onResizeSplit: (splitId: SplitId, ratio: number) => void;
    readonly onDockSession: (sessionId: SessionId, targetPaneId: PaneId, zone: DropDockZone) => void;
    readonly onDockPane: (sourcePaneId: PaneId, targetPaneId: PaneId, zone: DropDockZone) => void;
    readonly onLeafSizesChange?: ((sizes: ReadonlyMap<PaneId, PaneSizePx>) => void) | undefined;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onDetachSession: (id: SessionId) => void;
    readonly onRenameSession: (session: SelectedSession) => void;
    readonly onCompactSession: (id: SessionId) => void;
    readonly onOpenLink: (href: string) => void;
}

const CENTER_ONLY_ZONES: readonly DropDockZone[] = ["center"];
const NO_DOCK_ZONES: readonly DropDockZone[] = [];

function toSelectedSession(summary: SessionSummary | undefined, sessionId: SessionId): SelectedSession {
    if (summary === undefined) {
        return {
            id: sessionId,
            title: sessionId,
            named: false,
            cwd: "",
            runtimeState: "idle",
            attachedClients: 0,
        };
    }
    return {
        id: summary.id,
        cwd: summary.cwd,
        runtimeState: summary.runtimeState,
        attachedClients: summary.attachedClients,
        ...sessionTitle(summary),
    };
}

function formatDockLabel(
    zone: DropDockZone,
    targetLeaf: SplitTreeLeaf<PaneTarget>,
    activeDrag: WorkspaceDragSource,
): string {
    switch (zone) {
        case "left":
            return activeDrag?.kind === "pane" ? "Move left" : "Split left";
        case "right":
            return activeDrag?.kind === "pane" ? "Move right" : "Split right";
        case "top":
            return activeDrag?.kind === "pane" ? "Move up" : "Split up";
        case "bottom":
            return activeDrag?.kind === "pane" ? "Move down" : "Split down";
        case "center":
            if (activeDrag?.kind === "pane") {
                return "Swap pane";
            }
            return targetLeaf.data.kind === "empty" ? "Open here" : "Open in pane";
    }
}

interface WorkspacePaneItemProps {
    readonly paneId: PaneId;
    readonly target: PaneTarget;
    readonly sessionStore: SessionStoreInstance | null;
    readonly selected: SelectedSession | null;
    readonly sidebarOpen: boolean;
    readonly showSidebarToggle: boolean;
    readonly focused: boolean;
    readonly paneCount: number;
    readonly closing: boolean;
    readonly compacting: boolean;
    readonly draggable: boolean;
    readonly onDragSourceChange: (source: WorkspaceDragSource) => void;
    readonly onFocusPane: (paneId: PaneId) => void;
    readonly onClosePane: (paneId: PaneId) => void;
    readonly onToggleSidebar: () => void;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onDetachSession: (id: SessionId) => void;
    readonly onRenameSession: (session: SelectedSession) => void;
    readonly onCompactSession: (id: SessionId) => void;
    readonly onOpenLink: (href: string) => void;
}

const WorkspacePaneItem = memo(function WorkspacePaneItem({
    paneId,
    target,
    sessionStore,
    selected,
    sidebarOpen,
    showSidebarToggle,
    focused,
    paneCount,
    closing,
    compacting,
    draggable,
    onDragSourceChange,
    onFocusPane,
    onClosePane,
    onToggleSidebar,
    onCopySessionId,
    onDetachSession,
    onRenameSession,
    onCompactSession,
    onOpenLink,
}: WorkspacePaneItemProps): ReactElement {
    const handleFocus = useCallback(() => {
        onFocusPane(paneId);
    }, [onFocusPane, paneId]);

    const handleClosePane = useCallback(() => {
        onClosePane(paneId);
    }, [onClosePane, paneId]);

    const handleDragStart = useCallback(
        (event: DragEvent<HTMLElement>) => {
            const previewTitle = selected?.title ?? "Empty pane";
            startDragPayload(event.dataTransfer, WORKSPACE_DRAG_MIME.pane, paneId, previewTitle);
            onDragSourceChange({ kind: "pane", paneId });
        },
        [onDragSourceChange, paneId, selected?.title],
    );

    const handleDragEnd = useCallback(() => {
        onDragSourceChange(null);
    }, [onDragSourceChange]);

    const header = useMemo<SessionPaneHeaderProps>(
        () => ({
            session: selected,
            sidebarOpen,
            showSidebarToggle,
            headingLevel: focused ? 1 : 2,
            focused,
            paneCount,
            closing,
            compacting,
            draggable,
            onDragStart: draggable ? handleDragStart : undefined,
            onDragEnd: draggable ? handleDragEnd : undefined,
            onToggleSidebar,
            onCopySessionId,
            onDetachSession,
            onRenameSession,
            onCompactSession,
            onClosePane: handleClosePane,
        }),
        [
            closing,
            compacting,
            draggable,
            focused,
            handleClosePane,
            handleDragEnd,
            handleDragStart,
            onCompactSession,
            onCopySessionId,
            onDetachSession,
            onRenameSession,
            onToggleSidebar,
            paneCount,
            selected,
            showSidebarToggle,
            sidebarOpen,
        ],
    );

    return (
        <SessionPane
            target={target}
            sessionStore={sessionStore}
            header={header}
            onFocus={handleFocus}
            onOpenLink={onOpenLink}
        />
    );
});

/**
 * Connects {@link SplitPane} to {@link SessionPool}, {@link SessionPane}, and workspace
 * drag-and-drop docking rules.
 */
export function SplitWorkspace({
    layout,
    sessionPool,
    sessions,
    narrow,
    sidebarOpen,
    closingIds,
    compactingIds,
    minPaneWidthPx = MIN_PANE_WIDTH_PX,
    minPaneHeightPx = MIN_PANE_HEIGHT_PX,
    activeDrag,
    onDragSourceChange,
    onToggleSidebar,
    onFocusPane,
    onClosePane,
    onResizeSplit,
    onDockSession,
    onDockPane,
    onLeafSizesChange,
    onCopySessionId,
    onDetachSession,
    onRenameSession,
    onCompactSession,
    onOpenLink,
}: SplitWorkspaceProps): ReactElement {
    const poolSnapshot = useSyncExternalStore(sessionPool.subscribe, sessionPool.getSnapshot);
    const leaves = useMemo(() => listLeafPanes(layout.root), [layout.root]);
    const firstLeafId = leaves[0]?.id ?? layout.focusedPaneId;
    const focusedLeaf = useMemo(
        () => findLeafPane(layout.root, layout.focusedPaneId) ?? leaves[0] ?? null,
        [layout.focusedPaneId, layout.root, leaves],
    );

    const sessionById = useMemo(() => {
        const map = new Map<SessionId, SessionSummary>();
        for (const summary of sessions) {
            map.set(summary.id, summary);
        }
        return map;
    }, [sessions]);

    // Ensure every session currently shown in any pane stays attached in the pool (even on narrow
    // viewports where secondary panes are collapsed behind the focused pane).
    const visibleSessionIds = useMemo(() => {
        const ids = new Set<SessionId>();
        for (const leaf of leaves) {
            if (leaf.data.kind === "session") {
                ids.add(leaf.data.sessionId);
            }
        }
        return ids;
    }, [leaves]);

    useEffect(() => {
        sessionPool.setVisibleSessions(visibleSessionIds);
    }, [sessionPool, visibleSessionIds]);

    const storeForSession = useCallback(
        (target: PaneTarget): SessionStoreInstance | null => {
            if (target.kind !== "session") {
                return null;
            }
            // Subscribe via poolSnapshot.attachedIds so panes resolve stores once setVisibleSessions commits.
            if (!poolSnapshot.attachedIds.has(target.sessionId)) {
                return sessionPool.getStore(target.sessionId);
            }
            return sessionPool.getStore(target.sessionId);
        },
        [poolSnapshot.attachedIds, sessionPool],
    );

    const dropConfig = useMemo<SplitPaneDropConfig<PaneTarget> | undefined>(() => {
        if (narrow) {
            return undefined;
        }
        const atPaneLimit = leaves.length >= MAX_WORKSPACE_PANES;
        return {
            canDrop: (dt) => hasDragType(dt, WORKSPACE_DRAG_MIME.pane) || hasDragType(dt, WORKSPACE_DRAG_MIME.session),
            allowedZones: (_dt, targetLeaf) => {
                if (activeDrag?.kind === "pane") {
                    return activeDrag.paneId === targetLeaf.id ? NO_DOCK_ZONES : ALL_DOCK_ZONES;
                }
                if (activeDrag?.kind === "session") {
                    if (targetLeaf.data.kind === "session" && targetLeaf.data.sessionId === activeDrag.sessionId) {
                        return NO_DOCK_ZONES;
                    }
                    const alreadyOpenElsewhere = leaves.some(
                        (leaf) => leaf.data.kind === "session" && leaf.data.sessionId === activeDrag.sessionId,
                    );
                    return atPaneLimit && !alreadyOpenElsewhere ? CENTER_ONLY_ZONES : ALL_DOCK_ZONES;
                }
                return atPaneLimit ? CENTER_ONLY_ZONES : ALL_DOCK_ZONES;
            },
            zoneLabel: (zone, targetLeaf) => formatDockLabel(zone, targetLeaf, activeDrag),
            onDrop: (dt, targetLeaf, zone) => {
                onDragSourceChange(null);
                const rawPaneId = getDragData(dt, WORKSPACE_DRAG_MIME.pane);
                if (rawPaneId !== null) {
                    const sourcePaneId = parsePaneId(rawPaneId);
                    if (sourcePaneId !== null) {
                        onDockPane(sourcePaneId, targetLeaf.id, zone);
                    }
                    return;
                }
                const rawSessionId = getDragData(dt, WORKSPACE_DRAG_MIME.session);
                if (rawSessionId !== null) {
                    const sessionId = parseSessionId(rawSessionId);
                    if (sessionId !== null) {
                        onDockSession(sessionId, targetLeaf.id, zone);
                    }
                }
            },
        };
    }, [activeDrag, leaves, narrow, onDockPane, onDockSession, onDragSourceChange]);

    const renderLeaf = useCallback(
        (leaf: SplitTreeLeaf<PaneTarget>, { isFocused }: { readonly isFocused: boolean }): ReactElement => {
            const paneCount = narrow ? 1 : leaves.length;
            const isFirstPane = narrow || leaf.id === firstLeafId;
            const effectiveFocused = narrow || isFocused;
            const selected =
                leaf.data.kind === "session"
                    ? toSelectedSession(sessionById.get(leaf.data.sessionId), leaf.data.sessionId)
                    : null;
            const sessionId = leaf.data.kind === "session" ? leaf.data.sessionId : null;
            const canDragPane = !narrow && (paneCount > 1 || sessionId !== null);

            return (
                <WorkspacePaneItem
                    paneId={leaf.id}
                    target={leaf.data}
                    sessionStore={storeForSession(leaf.data)}
                    selected={selected}
                    sidebarOpen={sidebarOpen}
                    showSidebarToggle={isFirstPane}
                    focused={effectiveFocused}
                    paneCount={paneCount}
                    closing={sessionId !== null && closingIds.has(sessionId)}
                    compacting={sessionId !== null && compactingIds.has(sessionId)}
                    draggable={canDragPane}
                    onDragSourceChange={onDragSourceChange}
                    onFocusPane={onFocusPane}
                    onClosePane={onClosePane}
                    onToggleSidebar={onToggleSidebar}
                    onCopySessionId={onCopySessionId}
                    onDetachSession={onDetachSession}
                    onRenameSession={onRenameSession}
                    onCompactSession={onCompactSession}
                    onOpenLink={onOpenLink}
                />
            );
        },
        [
            closingIds,
            compactingIds,
            firstLeafId,
            leaves.length,
            narrow,
            onClosePane,
            onCompactSession,
            onCopySessionId,
            onDetachSession,
            onDragSourceChange,
            onFocusPane,
            onOpenLink,
            onRenameSession,
            onToggleSidebar,
            sessionById,
            sidebarOpen,
            storeForSession,
        ],
    );

    if (narrow && focusedLeaf !== null) {
        return <div className={styles.root}>{renderLeaf(focusedLeaf, { isFocused: true })}</div>;
    }

    return (
        <SplitPane
            className={styles.root}
            node={layout.root}
            focusedPaneId={layout.focusedPaneId}
            minPaneWidthPx={minPaneWidthPx}
            minPaneHeightPx={minPaneHeightPx}
            dropConfig={dropConfig}
            onLeafSizesChange={onLeafSizesChange}
            renderLeaf={renderLeaf}
            onResizeSplit={onResizeSplit}
        />
    );
}
