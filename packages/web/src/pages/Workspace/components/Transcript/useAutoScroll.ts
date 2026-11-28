import { useCallback, useEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "@/lib";

/** Sub-pixel tolerance so DPI scaling does not trigger false overflow fades. */
const EDGE_TOLERANCE_PX = 2;

/**
 * Quiet time that closes the initial phase.
 *
 * A virtualized list measures its rows over several passes, and React can skip frames between
 * them, so the phase waits for a wall-clock gap instead of counting frames.
 */
const SETTLE_QUIET_MS = 100;

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
    /**
     * Places an idle viewport at its bottom edge on attach.
     *
     * While the initial phase runs, the hook follows the layout passes that measure a virtualized
     * list, so the first bottom position becomes the measured one. A reader's scroll up ends the
     * phase, and an idle layout after it holds the offset; only `streaming` follows growth then.
     */
    initialBottom?: boolean | undefined;
    /**
     * Called after each decision that samples geometry: attaching the viewport, streaming starting,
     * and a content or viewport layout change. A scroll event and an explicit `scrollToBottom` do not
     * call it: a rail listens to `scroll` itself, and remeasuring there as well would read the same
     * geometry twice per frame.
     *
     * The hook keeps the latest callback in a ref, so an inline function does not resubscribe the
     * observers.
     */
    onViewportChange?: (() => void) | undefined;
};

/** State and controls returned by {@link useAutoScroll}. */
export type UseAutoScrollResult = {
    /**
     * Ref callback passed to the scrollable viewport element.
     *
     * The viewport must keep every element that can change the scroll height inside its first
     * element child. The hook observes that child for growth and the viewport for its own resize;
     * content that grows outside it, or that changes `scrollHeight` without changing the child's
     * box, does not update the fades or the pin.
     */
    viewportRef: (node: HTMLDivElement | null) => void;
    /** True when scrollable content extends above the visible top edge. */
    fadeTop: boolean;
    /** True when scrollable content extends below the visible bottom edge. */
    fadeBottom: boolean;
    /** True when the viewport is at the bottom edge or does not overflow. */
    atBottom: boolean;
    /**
     * True once the initial bottom position is settled or the viewport never had to settle.
     *
     * The phase ends when the viewport reaches the measured bottom, when its quiet window closes,
     * or when the reader scrolls up. A virtualized list reports the rows it mounted only after a
     * layout pass, so revealing the viewport before this flips would show the top of the
     * transcript and jump to the bottom a few frames later. A view can keep its content hidden.
     */
    settled: boolean;
    /** Scrolls to the bottom and re-arms automatic streaming follow. */
    scrollToBottom: (behavior?: ScrollBehavior) => void;
    /**
     * Reports that the mounted child measured its content after this viewport attached.
     *
     * A virtualized list mounts its rows only after the first layout pass, so the quiet window that
     * closes the initial phase must not start before the child reports a measurement.
     */
    reportMeasured: () => void;
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

/**
 * Why the viewport needs a new decision.
 *
 * `attach` is the first geometry sample of a viewport, `layout` reports a content or viewport box
 * that already changed, `settled` closes the settling phase once the extent stopped growing for
 * {@link SETTLE_QUIET_MS}, `stream-started` is the rising edge of `streaming`, and `scroll` carries
 * the position recorded before the event so a jump can be told apart from a reader scrolling up.
 */
export type ScrollSignal =
    | { readonly kind: "attach" }
    | { readonly kind: "layout" }
    | { readonly kind: "settled" }
    | { readonly kind: "stream-started" }
    | { readonly kind: "scroll"; readonly previousScrollTop: number };

/**
 * Auto-follow state of the viewport.
 *
 * `pinned` follows arriving content, `released` keeps the offset the reader chose, and `settling`
 * follows the layout passes that measure a freshly attached viewport until `settled` confirms the
 * scroll extent stopped growing.
 */
export type BottomPin = "settling" | "pinned" | "released";

/** Offset change the imperative shell must carry out after a decision. */
export type ScrollAction = { readonly kind: "hold" } | { readonly kind: "follow"; readonly top: number };

/** Next pin state, offset change and visible edges produced by one {@link ScrollSignal}. */
export type ScrollResolution = {
    readonly pin: BottomPin;
    readonly action: ScrollAction;
    readonly edges: ScrollEdges;
};

/** Inputs of {@link resolveScroll}: one signal, the current pin and one geometry sample. */
export type ScrollResolutionInput = {
    readonly signal: ScrollSignal;
    readonly pin: BottomPin;
    readonly metrics: ScrollMetrics;
    readonly streaming: boolean;
    readonly initialBottom: boolean;
    /**
     * Whether the initial phase still waits for the content to report a measurement.
     *
     * Only the first attach of a viewport can enter the phase; a later attach after a node swap
     * must not re-enter it, because nothing would end it again.
     */
    readonly settling: boolean;
};

/**
 * Decide how one signal changes the pin, the offset and the edge fades.
 *
 * A `follow` action names the offset it will write, and the returned edges describe the viewport at
 * that offset. A browser that clamps the write to a smaller offset lands below it, so the shell
 * replaces the edges with the ones measured at the achieved offset.
 */
export function resolveScroll({
    signal,
    pin,
    metrics,
    streaming,
    initialBottom,
    settling,
}: ScrollResolutionInput): ScrollResolution {
    switch (signal.kind) {
        case "attach": {
            if (streaming) {
                return decideScroll("pinned", true, metrics);
            }
            if (initialBottom) {
                // A viewport that still waits for measurements keeps following them; one that
                // already settled only jumps to the extent it can see now.
                return decideScroll(settling ? "settling" : "pinned", true, metrics);
            }
            return decideScroll(measureScrollEdges(metrics).atBottom ? "pinned" : "released", false, metrics);
        }
        case "stream-started": {
            const follow = pin === "pinned" || pin === "settling" || measureScrollEdges(metrics).atBottom;
            return decideScroll(follow ? "pinned" : "released", follow, metrics);
        }
        case "layout":
            return decideScroll(pin, pin === "settling" || (streaming && pin === "pinned"), metrics);
        case "settled":
            return decideScroll(pin === "settling" ? "pinned" : pin, false, metrics);
        case "scroll": {
            const movedUp = metrics.scrollTop < signal.previousScrollTop - EDGE_TOLERANCE_PX;
            if (measureScrollEdges(metrics).atBottom) {
                // A settling viewport reaches the bottom with its own jump, which reports a scroll
                // event; only the reader can end that phase from here.
                return decideScroll(pin === "settling" ? "settling" : "pinned", false, metrics);
            }
            if (movedUp) {
                return decideScroll("released", false, metrics);
            }
            return decideScroll(pin, false, metrics);
        }
    }
}

/**
 * Samples the viewport size and scroll extent.
 *
 * This is the only place that samples those three values. The hook calls it when the effect attaches
 * the viewport or sees streaming start, from a `ResizeObserver` callback, from a scroll event, and
 * from `scrollToBottom`. The one other element read is the scroll offset it has just written, to
 * learn the offset the browser applied. Call this after layout or from a scroll event; a call right
 * after a DOM mutation forces a synchronous layout.
 */
export function readScrollMetrics(node: HTMLElement): ScrollMetrics {
    return {
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
    };
}

/** Offset of the bottom edge for the given viewport geometry. */
export function bottomOffset({
    clientHeight,
    scrollHeight,
}: Pick<ScrollMetrics, "clientHeight" | "scrollHeight">): number {
    return Math.max(0, scrollHeight - clientHeight);
}

/**
 * Builds the decision for an already chosen pin and follow flag.
 *
 * A `follow` decision substitutes the offset it will write, so its edges describe the viewport at
 * that offset; {@link edgesAfterWrite} corrects them when the browser clamps the write.
 */
function decideScroll(pin: BottomPin, follow: boolean, metrics: ScrollMetrics): ScrollResolution {
    if (!follow) {
        return { pin, action: { kind: "hold" }, edges: measureScrollEdges(metrics) };
    }

    const top = bottomOffset(metrics);
    return {
        pin,
        action: { kind: "follow", top },
        edges: measureScrollEdges({ ...metrics, scrollTop: top }),
    };
}

/**
 * Edges the viewport shows once the shell applied a decision.
 *
 * A `follow` write the browser clamps to a smaller offset lands below the requested position, so the
 * edges are measured at the achieved offset instead of the planned one.
 */
export function edgesAfterWrite(metrics: ScrollMetrics, resolution: ScrollResolution, achieved: number): ScrollEdges {
    if (resolution.action.kind !== "follow" || achieved === resolution.action.top) {
        return resolution.edges;
    }

    return measureScrollEdges({ ...metrics, scrollTop: achieved });
}

/**
 * Pin a jump to the bottom leaves behind.
 *
 * A viewport that is still settling keeps following the layout passes that measure the content; any
 * other jump pins it. Callers write the returned pin and, while settling, re-arm the quiet window.
 */
export function pinAfterJump(settling: boolean): BottomPin {
    return settling ? "settling" : "pinned";
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
    onViewportChange,
}: UseAutoScrollOptions = {}): UseAutoScrollResult {
    const viewportNodeRef = useRef<HTMLDivElement | null>(null);
    const [mountKey, setMountKey] = useState(0);
    const [edges, setEdges] = useState<ScrollEdges>(HIDDEN_EDGES);
    const [settled, setSettled] = useState(!initialBottom);
    // The veil tracks the first measured bottom position, not the pin: a cached transcript can
    // still be marked streaming and pin the viewport before any row is measured.
    const pendingInitialBottomRef = useRef(initialBottom);
    const measuredRef = useRef(false);
    const scheduleSettleRef = useRef<() => void>(() => {});

    const pinRef = useRef<BottomPin>(streaming || initialBottom ? "settling" : "released");
    const lastScrollTopRef = useRef(0);
    const wasEnabledRef = useRef(false);
    const wasStreamingRef = useRef(streaming);
    const lastNodeRef = useRef<HTMLDivElement | null>(null);
    const onViewportChangeRef = useRef(onViewportChange);

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
        onViewportChangeRef.current = onViewportChange;
    }, [onViewportChange]);

    useEffect(() => {
        const node = viewportNodeRef.current;
        if (!enabled || node === null) {
            wasEnabledRef.current = false;
            wasStreamingRef.current = streaming;
            return;
        }

        // A ref callback can swap the viewport while the hook stays enabled, and a `streaming` or
        // `initialBottom` change re-runs this effect: only a fresh viewport re-runs the attach
        // decision, so those changes never replay the one-time jump.
        const isNewNode = lastNodeRef.current !== node;
        lastNodeRef.current = node;
        const justEnabled = !wasEnabledRef.current || isNewNode;
        const justStartedStreaming = streaming && !wasStreamingRef.current;
        wasEnabledRef.current = true;
        wasStreamingRef.current = streaming;

        // A virtualized list measures its rows across several layout passes after the first
        // commit. Close the initial phase after a quiet gap that starts only once the child
        // reported a measurement; a reader's scroll up ends it first.
        let settleTimer = 0;
        const finishSettling = (): void => {
            if (pendingInitialBottomRef.current) {
                pendingInitialBottomRef.current = false;
                setSettled(true);
            }
        };

        const apply = (signal: ScrollSignal): ScrollEdges => {
            const metrics = readScrollMetrics(node);
            const resolution = resolveScroll({
                signal,
                pin: pinRef.current,
                metrics,
                streaming,
                initialBottom,
                settling: pendingInitialBottomRef.current,
            });

            pinRef.current = resolution.pin;
            if (resolution.action.kind === "follow") {
                node.scrollTop = resolution.action.top;
            }
            // The sizes were sampled above and the write changes only the scroll offset, so this read
            // flushes no new layout. Recording the achieved offset keeps a clamped write from looking
            // like the reader scrolling up on the next event.
            const achieved = resolution.action.kind === "follow" ? node.scrollTop : metrics.scrollTop;
            lastScrollTopRef.current = achieved;
            const edges = edgesAfterWrite(metrics, resolution, achieved);
            // Reveal on the first measured bottom position: the write above already happened, so
            // the commit that lifts the veil cannot paint a stale offset. The quiet window below
            // stays the fallback for content that settles without a layout pass.
            const reachedBottom = signal.kind === "layout" && resolution.action.kind === "follow" && edges.atBottom;
            if (reachedBottom || (signal.kind === "scroll" && resolution.pin === "released")) {
                finishSettling();
            }
            scheduleSettleRef.current();
            return edges;
        };

        const publish = (next: ScrollEdges): void => {
            commitEdges(next);
            onViewportChangeRef.current?.();
        };

        const scheduleSettle = (): void => {
            if (settleTimer !== 0) {
                window.clearTimeout(settleTimer);
                settleTimer = 0;
            }
            if (!pendingInitialBottomRef.current || !measuredRef.current) {
                return;
            }
            settleTimer = window.setTimeout(() => {
                settleTimer = 0;
                finishSettling();
                if (pinRef.current === "settling") {
                    publish(apply({ kind: "settled" }));
                }
            }, SETTLE_QUIET_MS);
        };
        scheduleSettleRef.current = scheduleSettle;

        // The attach decision samples geometry as soon as the effect runs; its edges publish on the
        // next frame because an effect must not update state synchronously.
        let frame = 0;
        const publishLater = (next: ScrollEdges): void => {
            frame = window.requestAnimationFrame(() => {
                frame = 0;
                publish(next);
            });
        };

        if (justEnabled) {
            publishLater(apply({ kind: "attach" }));
        } else if (justStartedStreaming) {
            publishLater(apply({ kind: "stream-started" }));
        }

        const handleScroll = (): void => {
            // The rail listens to `scroll` itself, so this path updates the fades and the pin only.
            commitEdges(apply({ kind: "scroll", previousScrollTop: lastScrollTopRef.current }));
        };

        node.addEventListener("scroll", handleScroll, { passive: true });

        // ResizeObserver callbacks run after layout, so sampling geometry there costs nothing. A
        // MutationObserver would run before layout and force one synchronous layout for every
        // arriving token, even when the content box did not change.
        const resizeObserver = new ResizeObserver(() => {
            publish(apply({ kind: "layout" }));
        });
        resizeObserver.observe(node);

        // The content element carries the height that grows with arriving tokens; the viewport size
        // alone stays fixed, so it cannot report that growth.
        let content: Element | null = null;
        const observeContent = (): void => {
            const next = node.firstElementChild;
            if (next === content) {
                return;
            }
            if (content !== null) {
                resizeObserver.unobserve(content);
            }
            content = next;
            if (content !== null) {
                resizeObserver.observe(content);
            }
        };
        observeContent();

        // A replaced content element only re-targets the observer; this path reads no geometry.
        const structureObserver = new MutationObserver(() => {
            observeContent();
        });
        structureObserver.observe(node, { childList: true });

        return () => {
            if (frame !== 0) {
                window.cancelAnimationFrame(frame);
            }
            if (settleTimer !== 0) {
                window.clearTimeout(settleTimer);
            }
            scheduleSettleRef.current = () => {};
            node.removeEventListener("scroll", handleScroll);
            resizeObserver.disconnect();
            structureObserver.disconnect();
        };
    }, [enabled, streaming, initialBottom, mountKey, commitEdges]);

    const reportMeasured = useCallback(() => {
        measuredRef.current = true;
        scheduleSettleRef.current();
    }, []);

    const scrollToBottom = useCallback(
        (behavior: ScrollBehavior = "smooth") => {
            const node = viewportNodeRef.current;
            if (node === null) {
                return;
            }

            pinRef.current = pinAfterJump(pendingInitialBottomRef.current);
            // A jump during the initial phase must not stop the following of the measuring passes.
            if (pinRef.current === "settling") {
                scheduleSettleRef.current();
            }
            const metrics = readScrollMetrics(node);
            const top = bottomOffset(metrics);
            const resolvedBehavior: ScrollBehavior = prefersReducedMotion() ? "auto" : behavior;

            if (resolvedBehavior === "auto" || typeof node.scrollTo !== "function") {
                node.scrollTop = top;
                // Record what the browser applied, so the next scroll event is not read as scrolling up.
                const achieved = node.scrollTop;
                lastScrollTopRef.current = achieved;
                commitEdges(measureScrollEdges({ ...metrics, scrollTop: achieved }));
                return;
            }

            lastScrollTopRef.current = metrics.scrollTop;
            node.scrollTo({ top, behavior: resolvedBehavior });
        },
        [commitEdges],
    );

    return {
        viewportRef,
        fadeTop: enabled ? edges.fadeTop : false,
        fadeBottom: enabled ? edges.fadeBottom : false,
        atBottom: enabled ? edges.atBottom : true,
        settled,
        scrollToBottom,
        reportMeasured,
    };
}
