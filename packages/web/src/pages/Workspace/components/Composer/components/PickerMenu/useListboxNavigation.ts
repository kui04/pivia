import { useLayoutEffect, useState } from "react";

export interface ListboxNavigation {
    /** Index the arrow keys highlight, or -1 while the list is empty. */
    readonly litIndex: number;
    /** Points the highlight at a row the pointer entered. */
    readonly setHovered: (index: number | null) => void;
    /** Moves the highlight by `step`, wrapping at both ends; a null cursor starts at the end the step points to. */
    readonly move: (step: number) => void;
    /** Puts the cursor back on the first row, for a filtered list. */
    readonly resetCursor: () => void;
}

/**
 * Keyboard cursor for a single-select listbox.
 *
 * The listbox owns ARIA focus while `litIndex` says which option is highlighted; the hook also
 * reveals the highlighted option after a movement or a filter change.
 *
 * @param options.listId Id prefix of the option elements
 * @param options.scrollKey Value that changes when the list is filtered, so a still cursor scrolls
 * the new highlight into view
 */
export function useListboxNavigation({
    itemCount,
    listId,
    scrollKey,
}: {
    readonly itemCount: number;
    readonly listId: string;
    readonly scrollKey?: string | undefined;
}): ListboxNavigation {
    const [cursor, setCursor] = useState<number | null>(null);
    const [hovered, setHovered] = useState<number | null>(null);

    const cursorIndex = cursor ?? -1;
    const litIndex = itemCount === 0 ? -1 : Math.min(hovered ?? cursorIndex, itemCount - 1);

    useLayoutEffect(() => {
        if (litIndex < 0) {
            return;
        }
        document.getElementById(`${listId}-${litIndex}`)?.scrollIntoView({ block: "nearest" });
    }, [itemCount, listId, litIndex, scrollKey]);

    const move = (step: number): void => {
        if (itemCount === 0) {
            return;
        }
        setHovered(null);
        setCursor((previous) => {
            if (previous === null) {
                return step > 0 ? 0 : itemCount - 1;
            }
            return (previous + step + itemCount) % itemCount;
        });
    };

    return {
        litIndex,
        setHovered,
        move,
        resetCursor: () => {
            setCursor(0);
        },
    };
}
