import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactElement,
    type ReactNode,
} from "react";

import { cn, normalizeWheelDelta } from "@/lib";

import { useAutoScroll } from "../../useAutoScroll";
import styles from "./RailScrollArea.module.css";

const OVERFLOW_TOLERANCE_PX = 2;
const LINE_DELTA_PX = 20;

const HORIZONTAL_SCROLLBAR_STYLE: CSSProperties = {
    insetInlineStart: "var(--rail-content-indent)",
};

/** Props of {@link RailScrollArea}. */
export type RailScrollAreaProps = {
    /** Accessible name of the scroll viewport (`role="group"`). */
    label: string;
    /** Enables scroll listeners, auto-scroll, and rail thumb measurement. Set to false while collapsed. */
    enabled: boolean;
    /** Keeps the viewport pinned to the bottom edge while content streams. */
    streaming?: boolean | undefined;
    /** Bounded height preset: `"md"` (224px) for single blocks, `"lg"` (320px) for multi-step timelines. */
    maxHeight?: "md" | "lg" | undefined;
    /**
     * Start-side content indent under the header:
     * `"body"` (28px) aligns plain Markdown with the header label;
     * `"trigger"` (24px) aligns nested 4px-padded disclosure rows with the header label.
     */
    indent?: "body" | "trigger" | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
    /** Optional class name on the scroll content wrapper. */
    contentClassName?: string | undefined;
    children: ReactNode;
};

type DragSession = {
    readonly pointerId: number;
    readonly startY: number;
    readonly startScrollTop: number;
};

type DragState = { readonly kind: "idle" } | { readonly kind: "dragging"; readonly session: DragSession };

const IDLE_DRAG: DragState = { kind: "idle" };

/**
 * Bounded scroll panel that pairs a continuous 1px left guide rail with a fixed-length vertical
 * scroll thumb riding directly on that rail.
 *
 * Shared by borderless collapsible transcript sections (`TurnGroup`, `ThinkingBlock`, `SystemNote`,
 * `SkillInvocationBlock`, `CustomMessageBlock`) so none of them collide with right-edge chevrons.
 */
export function RailScrollArea({
    label,
    enabled,
    streaming = false,
    maxHeight = "md",
    indent = "body",
    className,
    contentClassName,
    children,
}: RailScrollAreaProps): ReactElement {
    const viewportNodeRef = useRef<HTMLDivElement | null>(null);
    const railRef = useRef<HTMLDivElement | null>(null);
    const thumbRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<DragState>(IDLE_DRAG);
    const thumbFrameRef = useRef(0);

    const [mountKey, setMountKey] = useState(0);
    const [overflowing, setOverflowing] = useState(false);
    const [dragging, setDragging] = useState(false);

    const syncThumb = useCallback(() => {
        const viewport = viewportNodeRef.current;
        const rail = railRef.current;
        const thumb = thumbRef.current;
        if (!enabled || viewport === null) {
            return;
        }

        const maxScroll = viewport.scrollHeight - viewport.clientHeight;
        const isOverflowing = viewport.clientHeight > 0 && maxScroll > OVERFLOW_TOLERANCE_PX;
        setOverflowing((prev) => (prev === isOverflowing ? prev : isOverflowing));

        if (!isOverflowing || rail === null || thumb === null) {
            return;
        }

        const maxOffset = Math.max(0, rail.clientHeight - thumb.offsetHeight);
        const ratio = Math.min(1, Math.max(0, viewport.scrollTop / maxScroll));
        thumb.style.transform = `translate3d(0, ${ratio * maxOffset}px, 0)`;
    }, [enabled]);

    // Content and viewport resizes arrive in bursts; one thumb update per frame is enough.
    const scheduleThumbSync = useCallback(() => {
        if (thumbFrameRef.current !== 0) {
            return;
        }
        thumbFrameRef.current = window.requestAnimationFrame(() => {
            thumbFrameRef.current = 0;
            syncThumb();
        });
    }, [syncThumb]);

    const {
        viewportRef: autoScrollViewportRef,
        fadeTop,
        fadeBottom,
    } = useAutoScroll({
        enabled,
        streaming,
        onViewportChange: scheduleThumbSync,
    });

    const handleViewportRef = useCallback(
        (node: HTMLDivElement | null) => {
            if (viewportNodeRef.current === node) {
                return;
            }
            viewportNodeRef.current = node;
            autoScrollViewportRef(node);
            setMountKey((prev) => prev + 1);
        },
        [autoScrollViewportRef],
    );

    useEffect(() => {
        const viewport = viewportNodeRef.current;
        const rail = railRef.current;
        if (!enabled || viewport === null) {
            return;
        }

        scheduleThumbSync();
        viewport.addEventListener("scroll", syncThumb, { passive: true });

        // useAutoScroll already watches the viewport content and size; this observer only covers
        // the rail, whose height the thumb offset depends on.
        const railResizeObserver = new ResizeObserver(() => {
            syncThumb();
        });
        if (rail !== null) {
            railResizeObserver.observe(rail);
        }

        const handleRailWheel = (event: WheelEvent) => {
            if (event.ctrlKey || event.deltaY === 0) {
                return;
            }
            const maxScroll = viewport.scrollHeight - viewport.clientHeight;
            if (maxScroll <= OVERFLOW_TOLERANCE_PX) {
                return;
            }
            const deltaPx = normalizeWheelDelta(event.deltaY, event.deltaMode, viewport.clientHeight, LINE_DELTA_PX);
            if (deltaPx === 0) {
                return;
            }
            const prevTop = viewport.scrollTop;
            if (
                (deltaPx < 0 && prevTop <= OVERFLOW_TOLERANCE_PX) ||
                (deltaPx > 0 && maxScroll - prevTop <= OVERFLOW_TOLERANCE_PX)
            ) {
                return;
            }
            const nextTop = Math.min(maxScroll, Math.max(0, prevTop + deltaPx));
            if (Math.abs(nextTop - prevTop) < 0.5) {
                return;
            }
            event.preventDefault();
            viewport.scrollTop = nextTop;
        };
        rail?.addEventListener("wheel", handleRailWheel, { passive: false });

        return () => {
            if (thumbFrameRef.current !== 0) {
                window.cancelAnimationFrame(thumbFrameRef.current);
                thumbFrameRef.current = 0;
            }
            if (dragRef.current.kind === "dragging") {
                const { pointerId } = dragRef.current.session;
                dragRef.current = IDLE_DRAG;
                if (rail !== null && rail.hasPointerCapture(pointerId)) {
                    rail.releasePointerCapture(pointerId);
                }
            }
            viewport.removeEventListener("scroll", syncThumb);
            rail?.removeEventListener("wheel", handleRailWheel);
            railResizeObserver.disconnect();
        };
    }, [enabled, mountKey, scheduleThumbSync, syncThumb]);

    const releaseDrag = useCallback((pointerId: number) => {
        if (dragRef.current.kind !== "dragging" || dragRef.current.session.pointerId !== pointerId) {
            return;
        }
        dragRef.current = IDLE_DRAG;
        setDragging(false);
        const rail = railRef.current;
        if (rail !== null && rail.hasPointerCapture(pointerId)) {
            rail.releasePointerCapture(pointerId);
        }
    }, []);

    const activeOverflow = enabled && overflowing;
    const activeDragging = enabled && dragging;

    const handleRailPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !activeOverflow) {
            return;
        }
        const viewport = viewportNodeRef.current;
        const rail = railRef.current;
        const thumb = thumbRef.current;
        if (viewport === null || rail === null || thumb === null) {
            return;
        }
        if (dragRef.current.kind === "dragging" && rail.hasPointerCapture(dragRef.current.session.pointerId)) {
            return;
        }

        const maxScroll = viewport.scrollHeight - viewport.clientHeight;
        const maxOffset = rail.clientHeight - thumb.offsetHeight;
        if (maxScroll <= 0 || maxOffset <= 0) {
            return;
        }

        const target = event.target;
        const hitThumb = target instanceof Node && thumb.contains(target);
        if (!hitThumb) {
            const railRect = rail.getBoundingClientRect();
            const clickOffset = event.clientY - railRect.top - thumb.offsetHeight / 2;
            const ratio = Math.min(1, Math.max(0, clickOffset / maxOffset));
            viewport.scrollTop = ratio * maxScroll;
        }

        dragRef.current = {
            kind: "dragging",
            session: {
                pointerId: event.pointerId,
                startY: event.clientY,
                startScrollTop: viewport.scrollTop,
            },
        };
        setDragging(true);
        try {
            rail.setPointerCapture(event.pointerId);
        } catch {
            // Synthetic PointerEvents in automated tests have no active browser pointer id to capture.
        }
    };

    const handleRailPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag.kind !== "dragging" || drag.session.pointerId !== event.pointerId) {
            return;
        }
        // Release cleanly if the browser dropped pointer capture while the button was already released.
        if ((event.buttons & 1) === 0) {
            releaseDrag(event.pointerId);
            return;
        }

        const viewport = viewportNodeRef.current;
        const rail = railRef.current;
        const thumb = thumbRef.current;
        if (viewport === null || rail === null || thumb === null) {
            return;
        }

        const maxScroll = viewport.scrollHeight - viewport.clientHeight;
        const maxOffset = rail.clientHeight - thumb.offsetHeight;
        if (maxScroll <= 0 || maxOffset <= 0) {
            return;
        }

        const deltaY = event.clientY - drag.session.startY;
        const nextScrollTop = drag.session.startScrollTop + (deltaY / maxOffset) * maxScroll;
        viewport.scrollTop = Math.min(maxScroll, Math.max(0, nextScrollTop));
        event.preventDefault();
    };

    const handleRailPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        releaseDrag(event.pointerId);
    };

    const handleRailMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
        // Native scrollbars keep focus on the active control when dragged or clicked.
        event.preventDefault();
    };

    return (
        <div
            className={cn(styles.root, className)}
            data-max-height={maxHeight}
            data-indent={indent}
            data-fade-top={fadeTop ? "true" : undefined}
            data-fade-bottom={fadeBottom ? "true" : undefined}
        >
            <div
                ref={railRef}
                aria-hidden="true"
                data-slot="rail-scrollbar"
                data-overflowing={activeOverflow ? "true" : undefined}
                data-dragging={activeDragging ? "true" : undefined}
                className={styles.rail}
                onMouseDown={handleRailMouseDown}
                onPointerDown={handleRailPointerDown}
                onPointerMove={handleRailPointerMove}
                onPointerUp={handleRailPointerUp}
                onPointerCancel={handleRailPointerUp}
                onLostPointerCapture={handleRailPointerUp}
            >
                <div className={styles.railLine} />
                <div ref={thumbRef} data-slot="rail-thumb" className={styles.thumb} />
            </div>

            <BaseScrollArea.Root data-slot="scroll-area" className={styles.scroll}>
                <BaseScrollArea.Viewport
                    ref={handleViewportRef}
                    data-slot="scroll-area-viewport"
                    role="group"
                    aria-label={label}
                    className={cn(styles.viewport, fadeTop && styles.fadeTop, fadeBottom && styles.fadeBottom)}
                >
                    <BaseScrollArea.Content
                        data-slot="scroll-area-content"
                        className={cn(styles.content, contentClassName)}
                    >
                        {children}
                    </BaseScrollArea.Content>
                </BaseScrollArea.Viewport>
                <BaseScrollArea.Scrollbar
                    orientation="horizontal"
                    data-slot="scroll-area-scrollbar"
                    className={styles.hScrollbar}
                    style={HORIZONTAL_SCROLLBAR_STYLE}
                >
                    <BaseScrollArea.Thumb data-slot="scroll-area-thumb" className={styles.hThumb} />
                </BaseScrollArea.Scrollbar>
            </BaseScrollArea.Root>
        </div>
    );
}
