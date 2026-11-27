import { useCallback, useState } from "react";

export interface ImageViewerState<Selection> {
    /** True while the viewer dialog is open. */
    readonly open: boolean;
    /** The thumbnail the viewer shows, or undefined before the first open. */
    readonly selection: Selection | undefined;
    /** Opens the viewer on `selection`. */
    readonly show: (selection: Selection) => void;
    /** Pass to `ImageViewer`; a close keeps the selection for the exit transition. */
    readonly onOpenChange: (open: boolean) => void;
}

/**
 * Tracks which thumbnail the shared `ImageViewer` shows.
 *
 * The selection survives the closing transition, so the image does not vanish before the dialog
 * animates out. A caller that removes the selected item hides the viewer by its own lookup.
 */
export function useImageViewer<Selection>(): ImageViewerState<Selection> {
    const [viewer, setViewer] = useState<{ readonly open: boolean; readonly selection: Selection } | null>(null);

    const show = useCallback((selection: Selection) => {
        setViewer({ open: true, selection });
    }, []);

    const onOpenChange = useCallback((open: boolean) => {
        setViewer((previous) =>
            previous === null || open ? previous : { open: false, selection: previous.selection },
        );
    }, []);

    return {
        open: viewer?.open ?? false,
        selection: viewer?.selection,
        show,
        onOpenChange,
    };
}
