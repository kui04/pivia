import type { ReactElement, ReactNode } from "react";

import { ScrollArea } from "@components";
import { useFontRole } from "@/hooks";
import { cn } from "@/lib";

import styles from "./OutputScroller.module.css";

/** Props of {@link OutputScroller}. */
export type OutputScrollerProps = {
    /** Accessible name of the scroll region. */
    label: string;
    /** Monospace output text; an empty string renders `placeholder` instead. */
    text: string;
    /** Muted text shown when the card has no output, such as "No output". */
    placeholder?: string | undefined;
    /** Content rendered before the output, such as an argument parse error. */
    before?: ReactNode | undefined;
    /** Content rendered after the output, such as image attachments. */
    children?: ReactNode | undefined;
    /** Wraps long lines instead of scrolling sideways. */
    wrapped: boolean;
    /** Reserves inline-end space for a toolbar overlaid on the output. */
    overlayToolbar?: boolean | undefined;
    /** Ref callback from the caller's `useAutoScroll`. */
    viewportRef: (node: HTMLDivElement | null) => void;
    /** True when content extends above the visible top edge. */
    fadeTop: boolean;
    /** True when content extends below the visible bottom edge. */
    fadeBottom: boolean;
};

/**
 * Bounded output surface shared by tool calls and command records.
 *
 * It owns the edge fades, the content padding and the monospace output row; the caller keeps its
 * card chrome, header and notices. A toolbar overlaid on the card needs extra inline space, which
 * `overlayToolbar` reserves.
 */
export function OutputScroller({
    label,
    text,
    placeholder,
    before,
    children,
    wrapped,
    overlayToolbar = false,
    viewportRef,
    fadeTop,
    fadeBottom,
}: OutputScrollerProps): ReactElement {
    useFontRole("mono");
    return (
        <ScrollArea
            label={label}
            viewportRef={viewportRef}
            className={styles.scroll}
            viewportClassName={cn(styles.viewport, fadeTop && styles.fadeTop, fadeBottom && styles.fadeBottom)}
            contentClassName={cn(
                styles.content,
                overlayToolbar && styles.contentOverlayToolbar,
                wrapped && styles.contentWrapped,
            )}
        >
            {before}
            {text !== "" ? (
                <pre className={styles.output} data-wrapped={wrapped ? "true" : undefined}>
                    {text}
                </pre>
            ) : placeholder !== undefined ? (
                <p className={styles.empty}>{placeholder}</p>
            ) : null}
            {children}
        </ScrollArea>
    );
}
