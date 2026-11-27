import type { SessionId } from "@pivia/protocol";
import { FolderClosed, FolderOpen } from "lucide-react";
import type { DragEvent, ReactElement } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger, Icon, VisuallyHidden } from "@components";
import type { SplitAxis } from "@components/SplitPane/tree";
import type { FolderSection as FolderSectionModel } from "@/stores/workspace";

import { SessionRow } from "../SessionRow";
import styles from "./FolderSection.module.css";

export interface FolderSectionProps {
    readonly folder: FolderSectionModel;
    readonly nowMs: number;
    readonly closingIds: ReadonlySet<SessionId>;
    readonly canSplitRow?: boolean | undefined;
    readonly canSplitColumn?: boolean | undefined;
    readonly onToggle: () => void;
    readonly onSelect: (id: SessionId) => void;
    readonly onSplitSession?: ((id: SessionId, axis: SplitAxis) => void) | undefined;
    readonly onSessionDragStart?: ((id: SessionId, title: string, event: DragEvent<HTMLElement>) => void) | undefined;
    readonly onSessionDragEnd?: (() => void) | undefined;
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
    canSplitRow,
    canSplitColumn,
    onToggle,
    onSelect,
    onSplitSession,
    onSessionDragStart,
    onSessionDragEnd,
    onTogglePinned,
    onCopySessionId,
    onCloseSession,
}: FolderSectionProps): ReactElement {
    return (
        <Collapsible
            open={!folder.collapsed}
            onOpenChange={() => {
                onToggle();
            }}
            render={<section />}
            className={styles.section}
        >
            <h2 className={styles.heading}>
                <CollapsibleTrigger className={styles.toggle} title={folder.cwd || undefined}>
                    <Icon className={styles.folder}>{folder.collapsed ? <FolderClosed /> : <FolderOpen />}</Icon>
                    <span className={styles.label}>{folder.label}</span>
                    {folder.cwd === "" ? null : <VisuallyHidden>, {folder.cwd}</VisuallyHidden>}
                </CollapsibleTrigger>
            </h2>
            <CollapsiblePanel>
                <ul className={styles.list}>
                    {folder.sessions.map((session) => (
                        <SessionRow
                            key={session.id}
                            session={session}
                            nowMs={nowMs}
                            closing={closingIds.has(session.id)}
                            canSplitRow={canSplitRow}
                            canSplitColumn={canSplitColumn}
                            onSelect={onSelect}
                            onSplitSession={onSplitSession}
                            onDragStart={onSessionDragStart}
                            onDragEnd={onSessionDragEnd}
                            onTogglePinned={onTogglePinned}
                            onCopySessionId={onCopySessionId}
                            onCloseSession={onCloseSession}
                        />
                    ))}
                </ul>
            </CollapsiblePanel>
        </Collapsible>
    );
}
