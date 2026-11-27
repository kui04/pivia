import { useId, useRef, type ReactElement } from "react";

import { PopoverContent, ScrollArea, type PopoverContentProps } from "@components";
import { cn } from "@/lib";

import type { SlashCommandRow } from "../../types";
import styles from "./CommandList.module.css";

export interface CommandListProps {
    /** Positioning anchor element (the composer card) so the popup aligns to it without wrapping it in a trigger. */
    readonly anchor?: PopoverContentProps["anchor"] | undefined;
    /** Filtered command rows shown above the composer card. */
    readonly rows: readonly SlashCommandRow[];
    /** Command id currently focused by keyboard navigation (`ArrowUp`/`ArrowDown`). */
    readonly highlightedId: string;
    /** Command id currently lit by pointer hover or keyboard focus. */
    readonly litId: string;
    /** Called when the pointer enters a row or leaves the list (`null`). */
    readonly onPoint: (id: string | null) => void;
    /** Called when the user selects a command row. */
    readonly onChoose: (row: SlashCommandRow) => void;
    /** Optional class name merged onto the popup surface. */
    readonly className?: string | undefined;
}

/**
 * Floating slash command autocomplete list anchored above the composer card.
 */
export function CommandList({
    anchor,
    rows,
    highlightedId,
    litId,
    onPoint,
    onChoose,
    className,
}: CommandListProps): ReactElement {
    const listId = useId();
    const scrolledIdRef = useRef<string | null>(null);

    const scrollHighlightedIntoView = (row: SlashCommandRow, element: HTMLDivElement | null): void => {
        if (element === null) {
            return;
        }
        if (row.id === highlightedId && scrolledIdRef.current !== highlightedId) {
            scrolledIdRef.current = highlightedId;
            element.scrollIntoView({ block: "nearest" });
        }
    };

    return (
        <PopoverContent
            side="top"
            align="center"
            sideOffset={8}
            collisionAvoidance={{ side: "none", align: "shift" }}
            anchor={anchor}
            initialFocus={false}
            finalFocus={false}
            className={cn(styles.popup, className)}
        >
            <ScrollArea
                label="Commands"
                className={styles.scroll}
                viewportClassName={styles.viewport}
                contentClassName={styles.content}
                viewportTabIndex={-1}
            >
                <div
                    id={listId}
                    role="listbox"
                    aria-label="Commands"
                    tabIndex={-1}
                    className={styles.listbox}
                    onMouseLeave={() => {
                        onPoint(null);
                    }}
                >
                    {rows.map((row) => {
                        const lit = row.id === litId;
                        return (
                            // Focus stays on the composer textarea, which drives this list with the arrow keys.
                            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                            <div
                                key={row.id}
                                id={`${listId}-${row.id}`}
                                role="option"
                                aria-selected={lit}
                                tabIndex={-1}
                                data-lit={lit}
                                ref={(element) => {
                                    scrollHighlightedIntoView(row, element);
                                }}
                                className={styles.option}
                                onClick={() => {
                                    onChoose(row);
                                }}
                                onMouseMove={() => {
                                    onPoint(row.id);
                                }}
                            >
                                <span className={styles.command}>/{row.name}</span>
                                {row.argHint === undefined ? null : (
                                    <span className={styles.argHint}>{row.argHint}</span>
                                )}
                                {row.description === null ? null : (
                                    <span className={styles.description} title={row.description}>
                                        {row.description}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            </ScrollArea>
        </PopoverContent>
    );
}
