import type { SessionId } from "@pivia/protocol";
import { FolderClosed, FolderOpen } from "lucide-react";
import type { ReactElement } from "react";

import { Icon, VisuallyHidden } from "@components";
import type { FolderSection as FolderSectionModel } from "@/stores/workspace/model";

import { SessionRow } from "../SessionRow/SessionRow";
import styles from "./FolderSection.module.css";

export interface FolderSectionProps {
    readonly folder: FolderSectionModel;
    readonly nowMs: number;
    readonly closingIds: ReadonlySet<SessionId>;
    readonly onToggle: () => void;
    readonly onSelect: (id: SessionId) => void;
    readonly onTogglePinned: (id: SessionId) => void;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onCloseSession: (id: SessionId) => void;
}

/**
 * One working directory and its unpinned sessions.
 *
 * The header sticks while its rows scroll underneath, shows the last path segment visually, and
 * keeps the full working directory in its accessible name and title tooltip.
 */
export function FolderSection({
    folder,
    nowMs,
    closingIds,
    onToggle,
    onSelect,
    onTogglePinned,
    onCopySessionId,
    onCloseSession,
}: FolderSectionProps): ReactElement {
    return (
        <section className={styles.section}>
            <h2 className={styles.heading}>
                <button
                    type="button"
                    className={styles.toggle}
                    aria-expanded={!folder.collapsed}
                    title={folder.cwd || undefined}
                    onClick={onToggle}
                >
                    <Icon className={styles.folder}>{folder.collapsed ? <FolderClosed /> : <FolderOpen />}</Icon>
                    <span className={styles.label}>{folder.label}</span>
                    {folder.cwd === "" ? null : <VisuallyHidden>, {folder.cwd}</VisuallyHidden>}
                </button>
            </h2>
            <div className={styles.collapse} data-collapsed={folder.collapsed}>
                <ul className={styles.list} inert={folder.collapsed}>
                    {folder.sessions.map((session) => (
                        <SessionRow
                            key={session.id}
                            session={session}
                            nowMs={nowMs}
                            closing={closingIds.has(session.id)}
                            onSelect={onSelect}
                            onTogglePinned={onTogglePinned}
                            onCopySessionId={onCopySessionId}
                            onCloseSession={onCloseSession}
                        />
                    ))}
                </ul>
            </div>
        </section>
    );
}
