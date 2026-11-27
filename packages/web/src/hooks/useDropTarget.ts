import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

/** Bounding rectangle passed into `resolveZone` by {@link useDropTarget}. */
export interface DropTargetRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/** Sum type representing whether a drop target currently has an accepted drag hovering over it. */
export type DropZoneState<TZone extends string> =
    { readonly active: false } | { readonly active: true; readonly zone: TZone };

/** Configuration for {@link useDropTarget}. */
export interface UseDropTargetOptions<TZone extends string> {
    /** Disables drop handling and clears any active hover state when `true`. */
    readonly disabled?: boolean | undefined;
    /** Return `true` when the dragged payload (inspectable via `dataTransfer.types`) can drop here. */
    readonly canDrop?: ((dataTransfer: DataTransfer) => boolean) | undefined;
    /** Resolve the target zone from element bounds and pointer coordinates (return `null` to reject). */
    readonly resolveZone: (
        rect: DropTargetRect,
        clientX: number,
        clientY: number,
        dataTransfer: DataTransfer,
    ) => TZone | null;
    /** Browser `dataTransfer.dropEffect` applied during `dragover`; defaults to `"move"`. */
    readonly dropEffect?: DataTransfer["dropEffect"] | undefined;
    /** Optional notification whenever active state or hovered zone changes (e.g. for sibling coordination). */
    readonly onStateChange?: ((state: DropZoneState<TZone>) => void) | undefined;
    /** Called when an accepted drag drops onto `zone`. */
    readonly onDrop: (dataTransfer: DataTransfer, zone: TZone) => void;
}

/** Event props and current hover state returned by {@link useDropTarget}. */
export interface UseDropTargetResult<TZone extends string> {
    readonly state: DropZoneState<TZone>;
    readonly dropProps: {
        readonly onDragEnter: (event: DragEvent<HTMLElement>) => void;
        readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
        readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
        readonly onDrop: (event: DragEvent<HTMLElement>) => void;
    };
    readonly reset: () => void;
}

const INACTIVE_DROP_STATE: DropZoneState<never> = { active: false };

/**
 * Reusable HTML5 drag-and-drop target hook with flicker-free nested child enter/leave tracking
 * and typed zone resolution.
 */
export function useDropTarget<TZone extends string>(options: UseDropTargetOptions<TZone>): UseDropTargetResult<TZone> {
    const { disabled = false, canDrop, resolveZone, dropEffect = "move", onStateChange, onDrop } = options;
    const [rawState, setRawState] = useState<DropZoneState<TZone>>(INACTIVE_DROP_STATE);
    const depthRef = useRef(0);
    const state = disabled ? INACTIVE_DROP_STATE : rawState;

    const commitState = useCallback(
        (next: DropZoneState<TZone>) => {
            setRawState((prev) => {
                if (prev.active === next.active && (!prev.active || !next.active || prev.zone === next.zone)) {
                    return prev;
                }
                return next;
            });
            onStateChange?.(next);
        },
        [onStateChange],
    );

    const reset = useCallback(() => {
        depthRef.current = 0;
        commitState(INACTIVE_DROP_STATE);
    }, [commitState]);

    useEffect(() => {
        if (!disabled) {
            return undefined;
        }
        depthRef.current = 0;
        onStateChange?.(INACTIVE_DROP_STATE);
        let cancelled = false;
        queueMicrotask(() => {
            if (!cancelled) {
                setRawState(INACTIVE_DROP_STATE);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [disabled, onStateChange]);

    useEffect(() => {
        if (disabled || !state.active) {
            return undefined;
        }
        const clear = (): void => {
            reset();
        };
        window.addEventListener("dragend", clear);
        window.addEventListener("drop", clear);
        return () => {
            window.removeEventListener("dragend", clear);
            window.removeEventListener("drop", clear);
        };
    }, [disabled, reset, state.active]);

    const resolveFromEvent = useCallback(
        (event: DragEvent<HTMLElement>): TZone | null => {
            if (disabled) {
                return null;
            }
            if (canDrop !== undefined && !canDrop(event.dataTransfer)) {
                return null;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            return resolveZone(
                { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                event.clientX,
                event.clientY,
                event.dataTransfer,
            );
        },
        [canDrop, disabled, resolveZone],
    );

    const onDragEnter = useCallback(
        (event: DragEvent<HTMLElement>) => {
            if (disabled || (canDrop !== undefined && !canDrop(event.dataTransfer))) {
                return;
            }
            // Only count an entry when crossing from outside this drop target; moving between
            // descendant children fires dragenter/dragleave inside the same container and would
            // otherwise drift depthRef upward without matching leaves.
            const enteredFromChild =
                event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);
            if (!enteredFromChild) {
                depthRef.current += 1;
            }
            const zone = resolveFromEvent(event);
            if (zone !== null) {
                event.preventDefault();
                commitState({ active: true, zone });
            } else if (state.active) {
                commitState(INACTIVE_DROP_STATE);
            }
        },
        [canDrop, commitState, disabled, resolveFromEvent, state.active],
    );

    const onDragOver = useCallback(
        (event: DragEvent<HTMLElement>) => {
            const zone = resolveFromEvent(event);
            if (zone === null) {
                if (state.active) {
                    commitState(INACTIVE_DROP_STATE);
                }
                return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = dropEffect;
            commitState({ active: true, zone });
        },
        [commitState, dropEffect, resolveFromEvent, state.active],
    );

    const onDragLeave = useCallback(
        (event: DragEvent<HTMLElement>) => {
            if (disabled) {
                return;
            }
            const related = event.relatedTarget;
            if (related instanceof Node) {
                if (event.currentTarget.contains(related)) {
                    return;
                }
                // Crossing into a sibling outside this target always leaves immediately.
                reset();
                return;
            }
            depthRef.current = Math.max(0, depthRef.current - 1);
            if (depthRef.current === 0) {
                reset();
            }
        },
        [disabled, reset],
    );

    const handleDrop = useCallback(
        (event: DragEvent<HTMLElement>) => {
            const zone = resolveFromEvent(event);
            reset();
            if (zone === null) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            onDrop(event.dataTransfer, zone);
        },
        [onDrop, reset, resolveFromEvent],
    );

    return {
        state,
        dropProps: {
            onDragEnter,
            onDragOver,
            onDragLeave,
            onDrop: handleDrop,
        },
        reset,
    };
}
