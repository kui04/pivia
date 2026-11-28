import type { SessionId } from "@pivia/protocol";
import { ChartColumn, Copy, EllipsisVertical, Minimize2, PanelLeft, Pencil, Unplug, X } from "lucide-react";
import { memo, type DragEvent, type ReactElement } from "react";

import { IconButton, Menu, MenuItem, MenuSeparator } from "@components";
import type { SelectedSession } from "@/stores/workspace";

import styles from "./Topbar.module.css";

export interface TopbarProps {
    readonly session: SelectedSession | null;
    readonly sidebarOpen: boolean;
    readonly closing: boolean;
    readonly compacting?: boolean | undefined;
    readonly runtimeReady?: boolean | undefined;
    /** Whether this pane header owns the global sidebar toggle button (defaults to `true`). */
    readonly showSidebarToggle?: boolean | undefined;
    /** Heading level so only the focused pane renders `<h1>` (`1` by default). */
    readonly headingLevel?: 1 | 2 | undefined;
    /** Whether this pane is the focused pane when multiple panes are open. */
    readonly focused?: boolean | undefined;
    /** Total visible pane count; disambiguates control labels when `> 1`. */
    readonly paneCount?: number | undefined;
    /** Enables dragging this pane header to reorder or re-dock the pane. */
    readonly draggable?: boolean | undefined;
    readonly onDragStart?: ((event: DragEvent<HTMLElement>) => void) | undefined;
    readonly onDragEnd?: (() => void) | undefined;
    readonly onToggleSidebar: () => void;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onDetachSession: (id: SessionId) => void;
    readonly onShowStats?: ((session: SelectedSession) => void) | undefined;
    readonly onRenameSession?: ((session: SelectedSession) => void) | undefined;
    readonly onCompactSession?: ((id: SessionId) => void) | undefined;
    readonly onClosePane?: (() => void) | undefined;
}

/**
 * The top bar of a workspace session pane.
 *
 * Holds the optional sidebar toggle (on the primary pane), the session title (using `<h1>` only
 * on the focused pane so the page keeps a single level-1 heading), and the overflow menu
 * containing session runtime actions, detach, and (when split) close-pane.
 */
function TopbarInner({
    session,
    sidebarOpen,
    closing,
    compacting = false,
    runtimeReady = false,
    showSidebarToggle = true,
    headingLevel = 1,
    focused = true,
    paneCount = 1,
    draggable = false,
    onDragStart,
    onDragEnd,
    onToggleSidebar,
    onCopySessionId,
    onDetachSession,
    onShowStats,
    onRenameSession,
    onCompactSession,
    onClosePane,
}: TopbarProps): ReactElement {
    const hasRuntimeMenuItems =
        onShowStats !== undefined || onRenameSession !== undefined || onCompactSession !== undefined;
    const titleText = session?.title ?? "No session selected";
    const disambiguate = paneCount > 1 ? ` (${titleText})` : "";
    const Heading = headingLevel === 1 ? "h1" : "h2";
    const showClosePane = onClosePane !== undefined && paneCount > 1;
    const showMenu = session !== null || showClosePane;
    const menuLabel = session === null ? `Pane actions${disambiguate}` : `Session actions${disambiguate}`;
    const isClosing = session !== null && (closing || session.runtimeState === "closing");
    const isCompacting = session !== null && (compacting || session.runtimeState === "compacting");

    const content = (
        <>
            {showSidebarToggle ? (
                <IconButton
                    type="button"
                    label={sidebarOpen ? "Hide sessions" : "Show sessions"}
                    aria-expanded={sidebarOpen}
                    onClick={onToggleSidebar}
                >
                    <PanelLeft />
                </IconButton>
            ) : null}
            <Heading
                className={styles.title}
                title={session !== null && session.cwd !== "" ? session.cwd : undefined}
                draggable={draggable || undefined}
                onDragStart={draggable ? onDragStart : undefined}
                onDragEnd={draggable ? onDragEnd : undefined}
            >
                {titleText}
            </Heading>
            <div className={styles.actions}>
                {showMenu ? (
                    <Menu
                        align="end"
                        trigger={
                            <IconButton type="button" label={menuLabel}>
                                <EllipsisVertical />
                            </IconButton>
                        }
                    >
                        {session === null ? null : (
                            <>
                                {onShowStats === undefined ? null : (
                                    <MenuItem
                                        icon={<ChartColumn />}
                                        onClick={() => {
                                            onShowStats(session);
                                        }}
                                    >
                                        Session stats
                                    </MenuItem>
                                )}
                                {onRenameSession === undefined ? null : (
                                    <MenuItem
                                        icon={<Pencil />}
                                        disabled={!runtimeReady || isClosing}
                                        onClick={() => {
                                            onRenameSession(session);
                                        }}
                                    >
                                        Rename session
                                    </MenuItem>
                                )}
                                {onCompactSession === undefined ? null : (
                                    <MenuItem
                                        icon={<Minimize2 />}
                                        disabled={!runtimeReady || isCompacting || isClosing}
                                        onClick={() => {
                                            onCompactSession(session.id);
                                        }}
                                    >
                                        {isCompacting ? "Compacting context..." : "Compact context"}
                                    </MenuItem>
                                )}
                                {hasRuntimeMenuItems ? <MenuSeparator /> : null}
                                <MenuItem
                                    icon={<Copy />}
                                    onClick={() => {
                                        onCopySessionId(session.id);
                                    }}
                                >
                                    Copy session ID
                                </MenuItem>
                                <MenuItem
                                    icon={<Unplug />}
                                    onClick={() => {
                                        onDetachSession(session.id);
                                    }}
                                >
                                    Detach session
                                </MenuItem>
                                {showClosePane ? <MenuSeparator /> : null}
                            </>
                        )}
                        {showClosePane ? (
                            <MenuItem icon={<X />} onClick={onClosePane}>
                                Close pane
                            </MenuItem>
                        ) : null}
                    </Menu>
                ) : null}
            </div>
        </>
    );

    if (showSidebarToggle) {
        return (
            <header className={styles.bar} data-focused={paneCount > 1 ? focused : undefined}>
                {content}
            </header>
        );
    }

    return (
        <div className={styles.bar} data-focused={paneCount > 1 ? focused : undefined}>
            {content}
        </div>
    );
}

/** Memoized pane header bar. */
export const Topbar = memo(TopbarInner);
