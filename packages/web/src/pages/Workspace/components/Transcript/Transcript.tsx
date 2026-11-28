import { assertNever } from "@pivia/protocol";
import { ArrowDown } from "lucide-react";
import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FocusEvent,
    type ReactElement,
    type RefObject,
} from "react";
import { Virtualizer } from "virtua";

import { Button, Icon, ScrollArea } from "@components";
import { cn } from "@/lib";
import type { SessionActivityNotice, SessionLiveActivity, TranscriptItem, TranscriptTurnItem } from "@/stores/session";

import {
    BashExecutionBlock,
    CustomMessageBlock,
    SkillInvocationBlock,
    SystemNote,
    TranscriptQueue,
    TurnGroup,
    UserMessage,
    WorkingIndicator,
    type QueuedEntry,
} from "./components";
import { Notice } from "./components/Notice";
import styles from "./Transcript.module.css";
import { useActivityLabel } from "./useActivityLabel";
import { useAutoScroll } from "./useAutoScroll";

/** Props of {@link Transcript}. */
export type TranscriptProps = {
    /** Chronological prompts, system notes and grouped agent turns for the active branch. */
    items: readonly TranscriptItem[];
    /**
     * The rows dropped a leading segment since the previous render (a moved compaction boundary).
     *
     * A pinned viewport needs no compensation, but a released reader would lose their place, so the
     * list holds the offset from the end for that render.
     */
    droppedLeadingEntries?: boolean | undefined;
    /** Forwarded to Markdown links inside intermediate and final replies. */
    onOpenLink?: ((href: string) => void) | undefined;
    /** Active runtime state (`compacting`, `retrying`, etc.) displayed inline with the transcript. */
    liveActivity?: SessionLiveActivity | undefined;
    /** Terminal compaction cancellation or retry failure notice shown below the transcript items. */
    activityNotice?: SessionActivityNotice | null | undefined;
    /** Queued steering and follow-up entries rendered at the bottom of the transcript. */
    queuedEntries?: readonly QueuedEntry[] | undefined;
    /** Clears all queued steering and follow-up entries. */
    onClearQueue?: (() => void) | undefined;
    /** Disables queue clearing while a `clear_queue` command is in flight. */
    clearingQueue?: boolean | undefined;
    /** Applies top and bottom CSS mask fades directly on the viewport. Disable when surrounding chrome owns the fades. */
    edgeFade?: boolean | undefined;
    /** Accessible name for the scroll region. Defaults to "Transcript". */
    label?: string | undefined;
    /** ID of an external heading element that names the transcript region. */
    labelledBy?: string | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/** Turn rows the reader expanded, keyed by row id. */
type ExpandedRows = ReadonlySet<string>;

const NO_EXPANDED_ROWS: ExpandedRows = new Set();

/**
 * Props of the transcript row list.
 *
 * The list owns row mounting only. It never samples or writes scroll geometry, so
 * {@link useAutoScroll} stays the single owner of the pin, the offset writes and the edge fades.
 */
type TranscriptListProps = {
    /** Transcript rows in reading order; settled rows keep their object identity between tokens. */
    readonly rows: readonly TranscriptItem[];
    /** Scroll viewport the row list mounts into and the virtualizer measures. */
    readonly scrollRef: RefObject<HTMLDivElement | null>;
    /** Trailing turn that is still arriving, or null when no turn streams. */
    readonly streamingTurnId: string | null;
    /** Activity label the streaming turn shows, or null while the runtime reports nothing. */
    readonly activityLabel: string | null;
    /** Forwarded to Markdown links inside every row. */
    readonly onOpenLink?: ((href: string) => void) | undefined;
    /** Rows the reader expanded; they keep their state when they scroll out of view. */
    readonly expandedRowIds: ExpandedRows;
    /** Records a reader toggle so the row keeps its state when it scrolls out of view. */
    readonly onRowOpenChange: (rowId: string, open: boolean) => void;
    /** Reports that the virtualizer measured the viewport or a row. */
    readonly onMeasured: () => void;
    /**
     * True while the viewport sits at its bottom edge.
     *
     * A pinned list lets the browser clamp the offset when leading rows disappear, which is exact;
     * a released list needs the virtualizer to hold the reader's content instead.
     */
    readonly atBottom: boolean;
    /** The rows dropped a leading segment since the previous render. */
    readonly droppedLeadingEntries: boolean;
};

/** Per-row inputs shared by every row of one list render. */
type TranscriptRowContext = {
    readonly streamingTurnId: string | null;
    readonly activityLabel: string | null;
    readonly onOpenLink: ((href: string) => void) | undefined;
    readonly expandedRowIds: ExpandedRows;
    readonly onRowOpenChange: (rowId: string, open: boolean) => void;
};

type TurnRowProps = {
    readonly turn: TranscriptTurnItem;
    readonly open: boolean;
    readonly activityLabel: string | undefined;
    readonly onOpenLink: ((href: string) => void) | undefined;
    readonly onRowOpenChange: (rowId: string, open: boolean) => void;
};

function TurnRowInner({ turn, open, activityLabel, onOpenLink, onRowOpenChange }: TurnRowProps): ReactElement {
    // A row-wide callback would be re-created for every token and would defeat the `memo` on
    // `TurnGroup`; bind the row id once per turn instead.
    const handleOpenChange = useCallback(
        (nextOpen: boolean) => onRowOpenChange(turn.id, nextOpen),
        [onRowOpenChange, turn.id],
    );

    return (
        <TurnGroup
            turn={turn}
            open={open}
            onOpenChange={handleOpenChange}
            activityLabel={activityLabel}
            onOpenLink={onOpenLink}
        />
    );
}

const TurnRow = memo(TurnRowInner);

function renderTranscriptRow(item: TranscriptItem, context: TranscriptRowContext): ReactElement {
    switch (item.kind) {
        case "user":
            return <UserMessage item={item} />;
        case "skill":
            return <SkillInvocationBlock item={item} onOpenLink={context.onOpenLink} />;
        case "bash":
            return <BashExecutionBlock item={item} />;
        case "custom":
            return <CustomMessageBlock item={item} onOpenLink={context.onOpenLink} />;
        case "note":
            return <SystemNote item={item} onOpenLink={context.onOpenLink} />;
        case "notice":
            return <Notice className={styles.inlineNotice}>{item.text}</Notice>;
        case "turn": {
            // An idle runtime has no label; the turn falls back to WORKING_LABEL while it still streams.
            const turnActivityLabel =
                item.id === context.streamingTurnId ? (context.activityLabel ?? undefined) : undefined;
            return (
                <TurnRow
                    turn={item}
                    open={context.expandedRowIds.has(item.id)}
                    activityLabel={turnActivityLabel}
                    onOpenLink={context.onOpenLink}
                    onRowOpenChange={context.onRowOpenChange}
                />
            );
        }
        default:
            return assertNever(item);
    }
}

/**
 * Indexes the virtualizer keeps mounted outside its window.
 *
 * A collapsed row rebuilds itself from its item, so only expanded rows pay for staying mounted.
 * The indexes are a hint: an entry list that removes rows may leave a stale index mounted, and the
 * virtualizer ignores indexes past the end.
 */
function pinnedRowIndexes(rows: readonly TranscriptItem[], expanded: ExpandedRows): readonly number[] {
    const indexes: number[] = [];
    for (const [index, row] of rows.entries()) {
        if (expanded.has(row.id)) {
            indexes.push(index);
        }
    }
    return indexes;
}

/**
 * Rows of the transcript column, virtualized so only the rows near the viewport stay mounted.
 *
 * Every row mounts inside its own wrapper, and the wrapper carries the inter-row gap and the first
 * row's top inset. The virtualizer measures the content box of its item element, so spacing on the
 * item itself would not reach the measured height.
 *
 * @param props - Rows, expansion state and the scroll viewport they mount into.
 */
function TranscriptList({
    rows,
    scrollRef,
    streamingTurnId,
    activityLabel,
    onOpenLink,
    expandedRowIds,
    onRowOpenChange,
    onMeasured,
    atBottom,
    droppedLeadingEntries,
}: TranscriptListProps): ReactElement {
    const context: TranscriptRowContext = {
        streamingTurnId,
        activityLabel,
        onOpenLink,
        expandedRowIds,
        onRowOpenChange,
    };
    const keepMounted = useMemo(() => pinnedRowIndexes(rows, expandedRowIds), [rows, expandedRowIds]);
    // A projection that drops a prefix (a moved compaction boundary or another branch) hands the
    // list a shorter array that no longer starts at the old first row. virtua maintains the scroll
    // position from the end for that render, which keeps the reader on the content they see; the
    // ref lags one render, so the flag is computed for exactly the shrinking render.
    // A pinned viewport needs no compensation: the browser clamps its offset to the shorter extent,
    // which lands exactly on the bottom. A released reader would lose their place, so the virtualizer
    // maintains the offset from the end for that render; the removed heights are exact for rows the
    // reader had mounted and estimates otherwise.
    const holdReleasedPosition = droppedLeadingEntries && !atBottom;

    return (
        <Virtualizer
            data={rows}
            scrollRef={scrollRef}
            keepMounted={keepMounted}
            shift={holdReleasedPosition}
            onResize={onMeasured}
        >
            {(row, index) => (
                <div
                    key={row.id}
                    data-slot="transcript-row"
                    className={styles.row}
                    data-first={index === 0 ? "true" : undefined}
                    data-last={index === rows.length - 1 ? "true" : undefined}
                >
                    {renderTranscriptRow(row, context)}
                </div>
            )}
        </Virtualizer>
    );
}

/**
 * Scrollable conversation view composing user prompts, system notes and collapsible agent turns.
 *
 * It starts pinned to the bottom edge, follows streaming output while the reader stays there, keeps
 * bottom breathing room, and floats a centered `To bottom` button whenever the reader scrolls up.
 * Only the rows near the viewport stay mounted, and the column stays hidden until the first bottom
 * position is measured, so a cold open never shows the top of the transcript.
 *
 * @param props - Transcript items and scroll-region naming.
 */
function TranscriptInner({
    items,
    droppedLeadingEntries = false,
    onOpenLink,
    liveActivity,
    activityNotice = null,
    queuedEntries,
    onClearQueue,
    clearingQueue = false,
    edgeFade = true,
    label = "Transcript",
    labelledBy,
    className,
}: TranscriptProps): ReactElement {
    const viewportNodeRef = useRef<HTMLDivElement | null>(null);
    const [expandedRowIds, setExpandedRowIds] = useState<ExpandedRows>(NO_EXPANDED_ROWS);
    const activityLabel = useActivityLabel(liveActivity ?? { kind: "idle" });
    // Only a list that loses rows or starts at another row can orphan an expanded id. Tracking the
    // mark keeps the check O(1) on the per-token renders that keep the same shape.
    const rowShapeRef = useRef<{ readonly count: number; readonly firstId: string | undefined }>({
        count: items.length,
        firstId: items[0]?.id,
    });
    useEffect(() => {
        const mark = rowShapeRef.current;
        if (items.length >= mark.count && items[0]?.id === mark.firstId) {
            return;
        }
        rowShapeRef.current = { count: items.length, firstId: items[0]?.id };
        setExpandedRowIds((current) => {
            if (current.size === 0) {
                return current;
            }
            const present = new Set(items.map((item) => item.id));
            let next: Set<string> | null = null;
            for (const rowId of current) {
                if (!present.has(rowId)) {
                    next ??= new Set(current);
                    next.delete(rowId);
                }
            }
            return next ?? current;
        });
    }, [items]);
    let lastStreamingTurnId: string | null = null;
    for (const item of items) {
        if (item.kind === "turn" && item.streaming) {
            lastStreamingTurnId = item.id;
        }
    }
    const streaming = lastStreamingTurnId !== null || activityLabel !== null;

    const { viewportRef, atBottom, settled, scrollToBottom, reportMeasured } = useAutoScroll({
        enabled: true,
        streaming,
        initialBottom: true,
    });

    const queuedCount = queuedEntries?.length ?? 0;
    const prevTrailingRef = useRef<{
        readonly notice: SessionActivityNotice | null;
        readonly queuedCount: number;
    }>({
        notice: activityNotice,
        queuedCount,
    });
    useEffect(() => {
        const prev = prevTrailingRef.current;
        const noticeChanged = activityNotice !== null && activityNotice !== prev.notice;
        const queueAdded = queuedCount > prev.queuedCount;
        if ((noticeChanged || queueAdded) && atBottom) {
            scrollToBottom("auto");
        }
        prevTrailingRef.current = {
            notice: activityNotice,
            queuedCount,
        };
    }, [activityNotice, atBottom, queuedCount, scrollToBottom]);

    const handleViewportRef = useCallback(
        (node: HTMLDivElement | null) => {
            viewportNodeRef.current = node;
            viewportRef(node);
        },
        [viewportRef],
    );

    const handleRowOpenChange = useCallback((rowId: string, open: boolean) => {
        setExpandedRowIds((current) => {
            if (current.has(rowId) === open) {
                return current;
            }
            const next = new Set(current);
            if (open) {
                next.add(rowId);
            } else {
                next.delete(rowId);
            }
            return next;
        });
    }, []);

    const handleJumpToBottom = () => {
        scrollToBottom("smooth");
        viewportNodeRef.current?.focus({ preventScroll: true });
    };

    // Return focus to the scrollable region if the floating button hides while still focused.
    const handleJumpBlur = (event: FocusEvent<HTMLButtonElement>) => {
        if (atBottom && event.relatedTarget === null) {
            viewportNodeRef.current?.focus({ preventScroll: true });
        }
    };

    const showJumpButton = !atBottom;

    return (
        <div className={cn(styles.root, className)}>
            <ScrollArea
                label={label}
                labelledBy={labelledBy}
                landmark
                viewportRef={handleViewportRef}
                className={styles.scroll}
                viewportClassName={cn(styles.viewport, edgeFade && styles.viewportFade)}
                contentClassName={styles.content}
            >
                <div
                    className={styles.column}
                    data-pending={settled ? undefined : "true"}
                    data-empty={items.length === 0 ? "true" : undefined}
                >
                    {items.length > 0 ? (
                        <TranscriptList
                            rows={items}
                            scrollRef={viewportNodeRef}
                            streamingTurnId={lastStreamingTurnId}
                            activityLabel={activityLabel}
                            onOpenLink={onOpenLink}
                            expandedRowIds={expandedRowIds}
                            onRowOpenChange={handleRowOpenChange}
                            onMeasured={reportMeasured}
                            atBottom={atBottom}
                            droppedLeadingEntries={droppedLeadingEntries}
                        />
                    ) : null}
                    {lastStreamingTurnId === null && activityLabel !== null ? (
                        <WorkingIndicator label={activityLabel} />
                    ) : null}
                    {activityNotice !== null ? (
                        <Notice
                            tone={activityNotice.tone}
                            live={activityNotice.tone === "error" ? "alert" : "status"}
                            className={styles.activityNotice}
                        >
                            {activityNotice.message}
                        </Notice>
                    ) : null}
                    {queuedEntries !== undefined ? (
                        <TranscriptQueue entries={queuedEntries} onClearQueue={onClearQueue} clearing={clearingQueue} />
                    ) : null}
                </div>
            </ScrollArea>

            <div
                className={styles.jumpOverlay}
                data-visible={showJumpButton ? "true" : undefined}
                aria-hidden={!showJumpButton}
                inert={!showJumpButton}
            >
                <Button
                    type="button"
                    variant="secondary"
                    radius="medium"
                    data-visible={showJumpButton ? "true" : undefined}
                    className={styles.jumpButton}
                    onClick={handleJumpToBottom}
                    onBlur={handleJumpBlur}
                >
                    <Icon size="no-container" className={styles.jumpIcon}>
                        <ArrowDown strokeWidth={1.75} />
                    </Icon>
                    To bottom
                </Button>
            </div>
        </div>
    );
}

/** Memoized conversation view to avoid re-rendering unchanged transcripts across pane splits and resizes. */
export const Transcript = memo(TranscriptInner);
