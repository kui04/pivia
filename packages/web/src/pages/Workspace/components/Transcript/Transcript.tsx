import { assertNever } from "@pivia/protocol";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, type FocusEvent, type ReactElement } from "react";

import { Button, Icon, ScrollArea } from "@components";
import { cn } from "@/lib";
import type { SessionActivityNotice, SessionLiveActivity } from "@/stores/session/store";
import type { TranscriptItem } from "@/stores/session/transcript";

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
import styles from "./Transcript.module.css";
import { useActivityLabel } from "./useActivityLabel";
import { useAutoScroll } from "./useAutoScroll";

/** Props of {@link Transcript}. */
export type TranscriptProps = {
    /** Chronological prompts, system notes and grouped agent turns for the active branch. */
    items: readonly TranscriptItem[];
    /** Forwarded to Markdown links inside intermediate and final replies. */
    onOpenLink?: ((href: string) => void) | undefined;
    /** Active runtime state (`compacting`, `retrying`, etc.) displayed inline with the transcript. */
    liveActivity?: SessionLiveActivity | undefined;
    /** Terminal compaction cancellation or retry failure notice shown below the transcript items. */
    activityNotice?: SessionActivityNotice | null | undefined;
    /** Queued steering and follow-up entries rendered at the bottom of the transcript. */
    queuedEntries?: readonly QueuedEntry[] | undefined;
    /** Applies top and bottom CSS mask fades directly on the viewport. Disable when surrounding chrome owns the fades. */
    edgeFade?: boolean | undefined;
    /** Accessible name for the scroll region. Defaults to "Transcript". */
    label?: string | undefined;
    /** ID of an external heading element that names the transcript region. */
    labelledBy?: string | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * Scrollable conversation view composing user prompts, system notes and collapsible agent turns.
 *
 * It starts pinned to the bottom edge, follows streaming output while the reader stays there, keeps
 * bottom breathing room, and floats a centered `To bottom` button whenever the reader scrolls up.
 *
 * @param props - Transcript items and scroll-region naming.
 */
export function Transcript({
    items,
    onOpenLink,
    liveActivity,
    activityNotice = null,
    queuedEntries,
    edgeFade = true,
    label = "Transcript",
    labelledBy,
    className,
}: TranscriptProps): ReactElement {
    const viewportNodeRef = useRef<HTMLDivElement | null>(null);
    const activityLabel = useActivityLabel(liveActivity ?? { kind: "idle" });
    let lastStreamingTurnId: string | null = null;
    for (const item of items) {
        if (item.kind === "turn" && item.streaming) {
            lastStreamingTurnId = item.id;
        }
    }
    const streaming = lastStreamingTurnId !== null || activityLabel !== null;

    const { viewportRef, atBottom, scrollToBottom } = useAutoScroll({
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
                <div className={styles.column}>
                    {items.map((item) => {
                        switch (item.kind) {
                            case "user":
                                return <UserMessage key={item.id} item={item} />;
                            case "skill":
                                return <SkillInvocationBlock key={item.id} item={item} onOpenLink={onOpenLink} />;
                            case "bash":
                                return <BashExecutionBlock key={item.id} item={item} />;
                            case "custom":
                                return <CustomMessageBlock key={item.id} item={item} onOpenLink={onOpenLink} />;
                            case "note":
                                return <SystemNote key={item.id} item={item} onOpenLink={onOpenLink} />;
                            case "notice":
                                return (
                                    <p key={item.id} className={styles.inlineNotice}>
                                        {item.text}
                                    </p>
                                );
                            case "turn": {
                                // An idle runtime has no label; the turn falls back to WORKING_LABEL
                                // while it still streams.
                                const turnActivityLabel =
                                    item.id === lastStreamingTurnId ? (activityLabel ?? undefined) : undefined;
                                return (
                                    <TurnGroup
                                        key={item.id}
                                        turn={item}
                                        activityLabel={turnActivityLabel}
                                        onOpenLink={onOpenLink}
                                    />
                                );
                            }
                            default:
                                return assertNever(item);
                        }
                    })}
                    {lastStreamingTurnId === null && activityLabel !== null ? (
                        <WorkingIndicator label={activityLabel} />
                    ) : null}
                    {activityNotice !== null ? (
                        <div
                            className={styles.activityNotice}
                            data-tone={activityNotice.tone}
                            role={activityNotice.tone === "error" ? "alert" : "status"}
                        >
                            {activityNotice.message}
                        </div>
                    ) : null}
                    {queuedEntries !== undefined ? <TranscriptQueue entries={queuedEntries} /> : null}
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
