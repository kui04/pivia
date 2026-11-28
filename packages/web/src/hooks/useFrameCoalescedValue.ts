import { useEffect, useRef, useState } from "react";

/**
 * Controls when a rapid sequence of updates to a frame-coalesced value must commit synchronously.
 */
export interface FrameCoalesceOptions<T> {
    /** Return true when `prev -> next` should bypass animation-frame batching and commit immediately. */
    readonly flushImmediately?: ((prev: T, next: T) => boolean) | undefined;
}

/** Frame scheduler abstraction used by {@link createFrameCoalescer} so burst batching can be unit tested. */
export interface FrameScheduler {
    readonly request: (callback: () => void) => number;
    readonly cancel: (handle: number) => void;
}

/** Headless frame coalescer used by {@link useFrameCoalescedValue} to limit burst commits to once per frame. */
export interface FrameCoalescer<T> {
    push(next: T, flushImmediately?: (prev: T, next: T) => boolean): void;
    dispose(): void;
}

const DEFAULT_FRAME_SCHEDULER: FrameScheduler | undefined =
    typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function"
        ? {
              request: (callback) => requestAnimationFrame(callback),
              cancel: (handle) => cancelAnimationFrame(handle),
          }
        : undefined;

/**
 * Creates a cancellable per-frame value coalescer that commits structural transitions at once
 * and collapses bursts between animation frames to the latest pushed value.
 */
export function createFrameCoalescer<T>(
    initial: T,
    commit: (next: T) => void,
    scheduler: FrameScheduler | undefined = DEFAULT_FRAME_SCHEDULER,
): FrameCoalescer<T> {
    let committed = initial;
    let latest = initial;
    let frameHandle: number | null = null;

    const cancelScheduled = (): void => {
        if (frameHandle !== null && scheduler !== undefined) {
            scheduler.cancel(frameHandle);
            frameHandle = null;
        }
    };

    return {
        push(next, flushImmediately) {
            latest = next;
            if (Object.is(next, committed)) {
                cancelScheduled();
                return;
            }
            if (scheduler === undefined || flushImmediately?.(committed, next) === true) {
                cancelScheduled();
                committed = next;
                commit(next);
                return;
            }
            if (frameHandle !== null) {
                return;
            }
            frameHandle = scheduler.request(() => {
                frameHandle = null;
                if (!Object.is(latest, committed)) {
                    committed = latest;
                    commit(latest);
                }
            });
        },
        dispose() {
            cancelScheduled();
        },
    };
}

/**
 * Coalesces rapid value updates (such as streamed tokens) to at most one React commit per animation
 * frame, while flushing structural transitions immediately.
 */
export function useFrameCoalescedValue<T>(value: T, options?: FrameCoalesceOptions<T>): T {
    const [committed, setCommitted] = useState(value);
    const flushImmediately = options?.flushImmediately;
    const coalescerRef = useRef<FrameCoalescer<T> | null>(null);

    useEffect(() => {
        coalescerRef.current ??= createFrameCoalescer(value, (next) => {
            setCommitted(() => next);
        });
        coalescerRef.current.push(value, flushImmediately);
    }, [value, flushImmediately]);

    useEffect(
        () => () => {
            coalescerRef.current?.dispose();
            coalescerRef.current = null;
        },
        [],
    );

    return committed;
}
