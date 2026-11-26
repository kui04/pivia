import type { SessionId } from "@pivia/protocol";
import { Copy, EllipsisVertical, Minimize2, PanelLeft, Pencil, X } from "lucide-react";
import type { ReactElement } from "react";

import { IconButton, Menu, MenuItem, MenuSeparator } from "@components";
import type { SelectedSession } from "@/stores/workspace";

import styles from "./Topbar.module.css";

export interface TopbarProps {
    readonly session: SelectedSession | null;
    readonly sidebarOpen: boolean;
    readonly closing: boolean;
    readonly compacting?: boolean | undefined;
    readonly runtimeReady?: boolean | undefined;
    readonly onToggleSidebar: () => void;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onCloseSession: (id: SessionId) => void;
    readonly onRenameSession?: ((session: SelectedSession) => void) | undefined;
    readonly onCompactSession?: ((id: SessionId) => void) | undefined;
}

/**
 * The top bar above the workspace session column.
 *
 * Holds the sidebar toggle, the active session's title (the single `<h1>` of the workspace),
 * and the session actions menu when a session is selected.
 */
export function Topbar({
    session,
    sidebarOpen,
    closing,
    compacting = false,
    runtimeReady = false,
    onToggleSidebar,
    onCopySessionId,
    onCloseSession,
    onRenameSession,
    onCompactSession,
}: TopbarProps): ReactElement {
    const hasRuntimeMenuItems = onRenameSession !== undefined || onCompactSession !== undefined;

    return (
        <header className={styles.bar}>
            <IconButton
                type="button"
                label={sidebarOpen ? "Hide sessions" : "Show sessions"}
                aria-expanded={sidebarOpen}
                onClick={onToggleSidebar}
            >
                <PanelLeft />
            </IconButton>
            <h1 className={styles.title} title={session !== null && session.cwd !== "" ? session.cwd : undefined}>
                {session?.title ?? "No session selected"}
            </h1>
            <div className={styles.actions}>
                {session === null ? null : (
                    <Menu
                        align="end"
                        trigger={
                            <IconButton type="button" label="Session actions">
                                <EllipsisVertical />
                            </IconButton>
                        }
                    >
                        {onRenameSession === undefined ? null : (
                            <MenuItem
                                icon={<Pencil />}
                                disabled={!runtimeReady || closing || session.runtimeState === "closing"}
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
                                disabled={
                                    !runtimeReady ||
                                    compacting ||
                                    closing ||
                                    session.runtimeState === "compacting" ||
                                    session.runtimeState === "closing"
                                }
                                onClick={() => {
                                    onCompactSession(session.id);
                                }}
                            >
                                {compacting ? "Compacting context..." : "Compact context"}
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
                            icon={<X />}
                            disabled={closing || session.runtimeState === "closing"}
                            onClick={() => {
                                onCloseSession(session.id);
                            }}
                        >
                            Close session
                        </MenuItem>
                    </Menu>
                )}
            </div>
        </header>
    );
}
