import { useCallback, useEffect, useRef, useState } from "react";

/** Sub-pixel tolerance so DPI scaling does not trigger false overflow fades. */
const EDGE_TOLERANCE_PX = 2;

/** Geometry of a scroll viewport, taken from the element for {@link measureScrollEdges}. */
export type ScrollMetrics = {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
};

/** Which edges of a viewport hide content, and whether the bottom edge is reached. */
export type ScrollEdges = {
    fadeTop: boolean;
    fadeBottom: boolean;
    atBottom: boolean;
};

/** Options of {@link useAutoScroll}. */
export type UseAutoScrollOptions = {
    /** Enables scroll listeners and observers. Set to false while collapsed. */
    enabled?: boolean | undefined;
    /** Keeps the viewport pinned to its bottom while content grows. */
    streaming?: boolean | undefined;
    /** Jumps to the bottom once when enabled becomes true while not streaming. */
    initialBottom?: boolean | undefined;
};

/** State and controls returned by {@link useAutoScroll}. */
export type UseAutoScrollResult = {
    /** Ref callback passed to the scrollable viewport element. */
    viewportRef: (node: HTMLDivElement | null) => void;
    /** True when scrollable content extends above the visible top edge. */
    fadeTop: boolean;
    /** True when scrollable content extends below the visible bottom edge. */
    fadeBottom: boolean;
    /** True when the viewport is at the bottom edge or does not overflow. */
    atBottom: boolean;
    /** Scrolls to the bottom and re-arms automatic streaming follow. */
    scrollToBottom: (behavior?: ScrollBehavior) => void;
};

const HIDDEN_EDGES: ScrollEdges = {
    fadeTop: false,
    fadeBottom: false,
    atBottom: true,
};

/**
 * Derive top and bottom edge fades and the bottom-pin state from viewport geometry.
 *
 * A collapsed or unmeasured viewport reports no fades, so a hidden container never flashes edges
 * when it opens.
 */
export function measureScrollEdges({ scrollTop, clientHeight, scrollHeight }: ScrollMetrics): ScrollEdges {
    if (clientHeight <= 0) {
        return HIDDEN_EDGES;
    }

    const fadeTop = scrollTop > EDGE_TOLERANCE_PX;
    const remaining = scrollHeight - (scrollTop + clientHeight);
    const fadeBottom = remaining > EDGE_TOLERANCE_PX;

    return {
        fadeTop,
        fadeBottom,
        atBottom: !fadeBottom,
    };
}

function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
    return a.fadeTop === b.fadeTop && a.fadeBottom === b.fadeBottom && a.atBottom === b.atBottom;
}

function prefersReducedMotion(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
}

/**
 * Track top and bottom scroll overflow and keep a streaming viewport pinned to the bottom.
 *
 * The user keeps control: scrolling upward unpins the viewport, so arriving tokens never move the
 * text being read.
 */
export function useAutoScroll({
    enabled = true,
    streaming = false,
    initialBottom = false,
}: UseAutoScrollOptions = {}): UseAutoScrollResult {
    const viewportNodeRef = useRef<HTMLDivElement | null>(null);
    const [mountKey, setMountKey] = useState(0);
    const [edges, setEdges] = useState<ScrollEdges>(HIDDEN_EDGES);

    const pinnedRef = useRef(streaming || initialBottom);
    const lastScrollTopRef = useRef(0);
    const wasEnabledRef = useRef(false);
    const wasStreamingRef = useRef(streaming);
    const lastNodeRef = useRef<HTMLDivElement | null>(null);

    const viewportRef = useCallback((node: HTMLDivElement | null) => {
        if (viewportNodeRef.current === node) {
            return;
        }
        viewportNodeRef.current = node;
        setMountKey((prev) => prev + 1);
    }, []);

    const commitEdges = useCallback((next: ScrollEdges) => {
        setEdges((prev) => (sameEdges(prev, next) ? prev : next));
    }, []);

    useEffect(() => {
        const node = viewportNodeRef.current;
        if (!enabled || node === null) {
            wasEnabledRef.current = false;
            wasStreamingRef.current = streaming;
            pinnedRef.current = streaming || initialBottom;
            return;
        }

        // A ref callback can swap the viewport while the hook stays enabled. Treat that as a fresh
        // start, otherwise the new element keeps its own scroll position at the top.
        const isNewNode = lastNodeRef.current !== node;
        lastNodeRef.current = node;
        const justEnabled = !wasEnabledRef.current || isNewNode;
        const justStartedStreaming = streaming && !wasStreamingRef.current;
        wasEnabledRef.current = true;
        wasStreamingRef.current = streaming;

        const jumpToBottom = () => {
            node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
            // Sync the last observed position before async scroll events arrive, so a bottom jump
            // does not look like an upward scroll.
            lastScrollTopRef.current = node.scrollTop;
        };

        if (justEnabled) {
            if (streaming || initialBottom) {
                pinnedRef.current = true;
                jumpToBottom();
            } else {
                lastScrollTopRef.current = node.scrollTop;
                pinnedRef.current = measureScrollEdges(node).atBottom;
            }
        } else if (justStartedStreaming && (pinnedRef.current || measureScrollEdges(node).atBottom)) {
            pinnedRef.current = true;
            jumpToBottom();
        }

        const sync = () => {
            if (streaming && pinnedRef.current) {
                jumpToBottom();
            }
            commitEdges(measureScrollEdges(node));
        };

        let rafId = 0;
        const scheduleSync = () => {
            if (rafId !== 0) {
                return;
            }
            rafId = window.requestAnimationFrame(() => {
                rafId = 0;
                sync();
            });
        };

        // Measure on the first animation frame so setEdges never runs synchronously in the effect.
        scheduleSync();

        const handleScroll = () => {
            const currentTop = node.scrollTop;
            const movedUp = currentTop < lastScrollTopRef.current - EDGE_TOLERANCE_PX;
            lastScrollTopRef.current = currentTop;

            const next = measureScrollEdges(node);
            if (next.atBottom) {
                pinnedRef.current = true;
            } else if (movedUp) {
                pinnedRef.current = false;
            }
            commitEdges(next);
        };

        node.addEventListener("scroll", handleScroll, { passive: true });

        const observedChildren = new Set<Element>();
        const resizeObserver = new ResizeObserver(() => {
            sync();
        });
        resizeObserver.observe(node);

        const observeDirectChildren = () => {
            for (const child of node.children) {
                if (!observedChildren.has(child)) {
                    observedChildren.add(child);
                    resizeObserver.observe(child);
                }
            }
        };
        observeDirectChildren();

        const mutationObserver = new MutationObserver(() => {
            observeDirectChildren();
            scheduleSync();
        });
        mutationObserver.observe(node, {
            childList: true,
            subtree: true,
            characterData: true,
        });

        return () => {
            if (rafId !== 0) {
                window.cancelAnimationFrame(rafId);
            }
            node.removeEventListener("scroll", handleScroll);
            resizeObserver.disconnect();
            mutationObserver.disconnect();
        };
    }, [enabled, streaming, initialBottom, mountKey, commitEdges]);

    const scrollToBottom = useCallback(
        (behavior: ScrollBehavior = "smooth") => {
            const node = viewportNodeRef.current;
            if (node === null) {
                return;
            }

            pinnedRef.current = true;
            const targetTop = Math.max(0, node.scrollHeight - node.clientHeight);
            const resolvedBehavior: ScrollBehavior = prefersReducedMotion() ? "auto" : behavior;

            if (resolvedBehavior === "auto" || typeof node.scrollTo !== "function") {
                node.scrollTop = targetTop;
                lastScrollTopRef.current = node.scrollTop;
                commitEdges(measureScrollEdges(node));
                return;
            }

            lastScrollTopRef.current = node.scrollTop;
            node.scrollTo({ top: targetTop, behavior: resolvedBehavior });
        },
        [commitEdges],
    );

    return {
        viewportRef,
        fadeTop: enabled ? edges.fadeTop : false,
        fadeBottom: enabled ? edges.fadeBottom : false,
        atBottom: enabled ? edges.atBottom : true,
        scrollToBottom,
    };
}
