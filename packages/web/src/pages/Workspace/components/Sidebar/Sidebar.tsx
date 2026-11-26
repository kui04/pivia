import type { SessionId } from "@pivia/protocol";
import { Pin, Plus, RefreshCw, Search, Settings, X } from "lucide-react";
import { useId, useRef, useState, type ReactElement } from "react";

import { Button, Icon, IconButton, Input, ScrollArea, VisuallyHidden } from "@components";
import { cn } from "@/lib";
import type { CatalogSyncPhase, WorkspaceModel } from "@/stores/workspace";

import { FolderSection } from "../FolderSection";
import { SessionRow } from "../SessionRow";
import styles from "./Sidebar.module.css";

export interface SidebarProps {
    readonly model: WorkspaceModel;
    readonly sync: CatalogSyncPhase;
    readonly query: string;
    readonly nowMs: number;
    readonly closingIds: ReadonlySet<SessionId>;
    readonly onQueryChange: (query: string) => void;
    readonly onRefresh: () => void;
    readonly onNewSession: () => void;
    readonly onOpenSettings: () => void;
    readonly onSelect: (id: SessionId) => void;
    readonly onTogglePinned: (id: SessionId) => void;
    readonly onToggleFolder: (cwd: string) => void;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onCloseSession: (id: SessionId) => void;
}

/**
 * The workspace session sidebar: top actions (new session, inline search, settings), pinned group,
 * directory sections, and sync banners.
 */
export function Sidebar({
    model,
    sync,
    query,
    nowMs,
    closingIds,
    onQueryChange,
    onRefresh,
    onNewSession,
    onOpenSettings,
    onSelect,
    onTogglePinned,
    onToggleFolder,
    onCopySessionId,
    onCloseSession,
}: SidebarProps): ReactElement {
    const [searching, setSearching] = useState(false);
    const searchActionRef = useRef<HTMLButtonElement>(null);
    const pinnedTitleId = useId();

    const syncing = sync.kind === "syncing";
    const starting = model.total === 0 && (sync.kind === "idle" || syncing);
    const showSkeleton = starting || syncing;
    const hasRows = model.pinned.length > 0 || model.folders.length > 0;
    const filtering = query.trim() !== "";

    const closeSearch = (): void => {
        setSearching(false);
        onQueryChange("");
    };

    const restoreSearchFocus = (): void => {
        requestAnimationFrame(() => {
            if (document.activeElement === null || document.activeElement === document.body) {
                searchActionRef.current?.focus();
            }
        });
    };

    return (
        <div className={styles.root}>
            <div className={styles.actions}>
                <Button
                    type="button"
                    variant="secondary"
                    className={cn(styles.action, styles.newSession)}
                    onClick={onNewSession}
                >
                    <Icon className={styles.flushIcon}>
                        <Plus />
                    </Icon>
                    New session
                </Button>
                {searching ? (
                    <div className={styles.search}>
                        <Icon className={styles.flushIcon}>
                            <Search />
                        </Icon>
                        <Input
                            // The field replaces the Search action, so it has to take the focus it displaced.
                            autoFocus
                            type="search"
                            aria-label="Search sessions"
                            placeholder="Search sessions"
                            value={query}
                            className={styles.searchInput}
                            onChange={(event) => {
                                onQueryChange(event.currentTarget.value);
                            }}
                            onBlur={(event) => {
                                // An empty field holds no query, so leaving it restores the action
                                // instead of leaving a dead field above the list.
                                if (event.currentTarget.value.trim() !== "") {
                                    return;
                                }
                                closeSearch();
                                restoreSearchFocus();
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                    // The drawer listens for Escape on the document; without this the
                                    // key would close the drawer instead of the search.
                                    event.stopPropagation();
                                    closeSearch();
                                    restoreSearchFocus();
                                }
                            }}
                        />
                        <IconButton
                            type="button"
                            label="Close search"
                            onClick={() => {
                                closeSearch();
                                restoreSearchFocus();
                            }}
                        >
                            <X />
                        </IconButton>
                    </div>
                ) : (
                    <Button
                        ref={searchActionRef}
                        type="button"
                        variant="ghost"
                        className={styles.action}
                        onClick={() => {
                            setSearching(true);
                        }}
                    >
                        <Icon className={styles.flushIcon}>
                            <Search />
                        </Icon>
                        Search
                    </Button>
                )}
                <Button type="button" variant="ghost" className={styles.action} onClick={onOpenSettings}>
                    <Icon className={styles.flushIcon}>
                        <Settings />
                    </Icon>
                    Settings
                </Button>
            </div>

            <div className={styles.listHeader}>
                <p className={styles.listTitle}>Sessions</p>
                <IconButton
                    type="button"
                    label="Refresh sessions"
                    // The click disables the button, so it must keep the focus it took; a second
                    // activation must not start a second request.
                    disabled={syncing}
                    focusableWhenDisabled
                    className={cn(syncing && styles.spinning)}
                    onClick={onRefresh}
                >
                    <RefreshCw />
                </IconButton>
            </div>

            {showSkeleton ? (
                <LoadingRows label={starting ? "Loading sessions" : "Refreshing sessions"} />
            ) : (
                <ScrollArea
                    label="Sessions"
                    landmark
                    className={styles.scroll}
                    viewportClassName={styles.viewport}
                    contentClassName={styles.content}
                >
                    {sync.kind === "reconnecting" ? (
                        <p role="status" className={cn(styles.banner, styles.warning)}>
                            Reconnecting to server…
                        </p>
                    ) : sync.kind === "failed" ? (
                        <p role="status" className={cn(styles.banner, styles.warning)}>
                            {sync.message}
                        </p>
                    ) : null}

                    {!hasRows && filtering ? (
                        <p className={styles.empty}>No session matches “{query.trim()}”.</p>
                    ) : !hasRows ? (
                        sync.kind === "live" ? (
                            <p className={styles.empty}>No sessions yet. Create one to start.</p>
                        ) : null
                    ) : (
                        <>
                            {model.pinned.length === 0 ? null : (
                                <section className={styles.group} aria-labelledby={pinnedTitleId}>
                                    <h2 id={pinnedTitleId} className={styles.groupTitle}>
                                        <Icon className={styles.flushIcon}>
                                            <Pin />
                                        </Icon>
                                        Pinned
                                    </h2>
                                    <ul className={styles.list}>
                                        {model.pinned.map((session) => (
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
                                </section>
                            )}
                            {model.folders.map((folder) => (
                                <FolderSection
                                    key={folder.cwd}
                                    folder={folder}
                                    nowMs={nowMs}
                                    closingIds={closingIds}
                                    onToggle={() => {
                                        onToggleFolder(folder.cwd);
                                    }}
                                    onSelect={onSelect}
                                    onTogglePinned={onTogglePinned}
                                    onCopySessionId={onCopySessionId}
                                    onCloseSession={onCloseSession}
                                />
                            ))}
                        </>
                    )}
                </ScrollArea>
            )}
        </div>
    );
}

/**
 * The list skeleton. It mirrors the loaded list: groups of one folder header and four session
 * rows, drawn in more groups than any window shows so CSS clips the rest to the available height.
 */
function LoadingRows({ label }: { label: string }): ReactElement {
    return (
        <>
            <VisuallyHidden as="p" role="status">
                {label}
            </VisuallyHidden>
            <div className={styles.skeleton} aria-hidden="true">
                {SKELETON_GROUPS.map(({ id, widths }) => (
                    <div key={id} className={styles.skeletonGroup}>
                        {widths.map((width, row) => (
                            <div
                                key={width}
                                className={styles.skeletonRow}
                                data-kind={row === 0 ? "folder" : "session"}
                            >
                                {row === 0 ? <span className={styles.skeletonIcon} /> : null}
                                <span className={styles.skeletonBar} style={{ inlineSize: width }} />
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
}

/** Five widths that read as a list of names rather than as equal bars. */
const SKELETON_WIDTHS = ["72%", "54%", "64%", "46%", "58%"] as const;

/** Ten groups cover a window about 2000px tall; a taller one leaves the bottom empty. */
const SKELETON_GROUP_COUNT = 10;

/** Each group starts the width cycle one step later, so the groups do not repeat each other. */
const SKELETON_GROUPS = Array.from({ length: SKELETON_GROUP_COUNT }, (_, id) => {
    const shift = id % SKELETON_WIDTHS.length;
    return { id, widths: [...SKELETON_WIDTHS.slice(shift), ...SKELETON_WIDTHS.slice(0, shift)] };
});
