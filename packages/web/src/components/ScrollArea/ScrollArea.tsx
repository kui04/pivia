import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { CSSProperties, ReactNode, Ref } from "react";

import { cn } from "@/lib";

import styles from "./ScrollArea.module.css";

export type ScrollAreaProps = {
    children: ReactNode;
    /** Accessible name; ignored when `labelledBy` names another element. */
    label: string;
    /** ID of the element that names the scroll region. */
    labelledBy?: string | undefined;
    /**
     * Exposes the viewport as a landmark region.
     *
     * Only page-level scrollers a reader navigates by should opt in. An inner scroller stays a
     * named group, because a transcript can hold repeated commands or notes whose region names
     * would collide under the landmark rule.
     */
    landmark?: boolean | undefined;
    /** Class on the root, which the caller sizes. */
    className?: string | undefined;
    viewportClassName?: string | undefined;
    contentClassName?: string | undefined;
    style?: CSSProperties | undefined;
    /** The scrollable element, for reading, changing or observing the scroll position. */
    viewportRef?: Ref<HTMLDivElement> | undefined;
};

/**
 * A scroll container with thin overlay scrollbars. The horizontal bar stays
 * visible while the content overflows sideways; the vertical bar fades in when
 * the pointer enters or the user scrolls, then fades out after the pointer
 * leaves and scrolling stops. Native scrollbars are hidden, so the bars never
 * reserve layout space and the content width does not change when a bar appears.
 *
 * The bars cover the last 6px of the viewport; leave padding at the right and
 * bottom edges when content there is interactive. On devices without hover,
 * the vertical bar stays visible while scrollable and keeps a wider invisible
 * hit area, because there is no hover to reveal it; the visible thickness does
 * not change.
 *
 * The root has no fixed height. The caller must give it a definite height;
 * otherwise it grows with its content and the viewport never scrolls vertically.
 */
export function ScrollArea({
    children,
    label,
    labelledBy,
    landmark = false,
    className,
    viewportClassName,
    contentClassName,
    style,
    viewportRef,
}: ScrollAreaProps) {
    return (
        <BaseScrollArea.Root data-slot="scroll-area" className={cn(styles.root, className)} style={style}>
            <BaseScrollArea.Viewport
                ref={viewportRef}
                data-slot="scroll-area-viewport"
                role={landmark ? "region" : "group"}
                aria-label={labelledBy === undefined ? label : undefined}
                aria-labelledby={labelledBy}
                className={cn(styles.viewport, viewportClassName)}
            >
                <BaseScrollArea.Content data-slot="scroll-area-content" className={contentClassName}>
                    {children}
                </BaseScrollArea.Content>
            </BaseScrollArea.Viewport>
            <BaseScrollArea.Scrollbar
                orientation="vertical"
                data-slot="scroll-area-scrollbar"
                className={styles.scrollbar}
            >
                <BaseScrollArea.Thumb data-slot="scroll-area-thumb" className={styles.thumb} />
            </BaseScrollArea.Scrollbar>
            <BaseScrollArea.Scrollbar
                orientation="horizontal"
                data-slot="scroll-area-scrollbar"
                className={styles.scrollbar}
            >
                <BaseScrollArea.Thumb data-slot="scroll-area-thumb" className={styles.thumb} />
            </BaseScrollArea.Scrollbar>
            <BaseScrollArea.Corner data-slot="scroll-area-corner" className={styles.corner} />
        </BaseScrollArea.Root>
    );
}
