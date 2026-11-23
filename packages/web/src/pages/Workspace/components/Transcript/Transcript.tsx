import { assertNever } from "@pivia/protocol";
import { ArrowDown } from "lucide-react";
import { useCallback, useRef, type FocusEvent, type ReactElement } from "react";

import { Button, Icon, ScrollArea } from "@components";
import { cn } from "@/lib/cn";
import type { TranscriptItem } from "@/stores/session/transcript";

import {
    BashExecutionBlock,
    CustomMessageBlock,
    SkillInvocationBlock,
    SystemNote,
    TurnGroup,
    UserMessage,
} from "./components";
import styles from "./Transcript.module.css";
import { useAutoScroll } from "./useAutoScroll";

/** Props of {@link Transcript}. */
export type TranscriptProps = {
    /** Chronological prompts, system notes and grouped agent turns for the active branch. */
    items: readonly TranscriptItem[];
    /** Forwarded to Markdown links inside intermediate and final replies. */
    onOpenLink?: ((href: string) => void) | undefined;
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
    edgeFade = true,
    label = "Transcript",
    labelledBy,
    className,
}: TranscriptProps): ReactElement {
    const viewportNodeRef = useRef<HTMLDivElement | null>(null);
    const streaming = items.some((item) => item.kind === "turn" && item.streaming);

    const { viewportRef, atBottom, scrollToBottom } = useAutoScroll({
        enabled: true,
        streaming,
        initialBottom: true,
    });

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
                                return (
                                    <SkillInvocationBlock
                                        key={item.id}
                                        item={item}
                                        {...(onOpenLink !== undefined ? { onOpenLink } : {})}
                                    />
                                );
                            case "bash":
                                return <BashExecutionBlock key={item.id} item={item} />;
                            case "custom":
                                return (
                                    <CustomMessageBlock
                                        key={item.id}
                                        item={item}
                                        {...(onOpenLink !== undefined ? { onOpenLink } : {})}
                                    />
                                );
                            case "note":
                                return (
                                    <SystemNote
                                        key={item.id}
                                        item={item}
                                        {...(onOpenLink !== undefined ? { onOpenLink } : {})}
                                    />
                                );
                            case "turn":
                                return (
                                    <TurnGroup
                                        key={item.id}
                                        turn={item}
                                        {...(onOpenLink !== undefined ? { onOpenLink } : {})}
                                    />
                                );
                            default:
                                return assertNever(item);
                        }
                    })}
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
