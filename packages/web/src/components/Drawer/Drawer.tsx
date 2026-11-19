import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../../lib/cn";

import { DrawerContentContext } from "./useInsideDrawer";
import styles from "./Drawer.module.css";

/** The edge a drawer slides from, and the direction a swipe dismisses it towards. */
export type DrawerSide = "left" | "right";

export type DrawerProps = {
    /** Whether the drawer is open. */
    open: boolean;
    /** Called when the user closes it with the backdrop, a swipe, Escape or a close control. */
    onOpenChange: (open: boolean) => void;
    /** The edge it slides from. Defaults to the left edge. */
    side?: DrawerSide;
    /** Accessible name of the panel, which has no visible title of its own. */
    label: string;
    /** The panel content. */
    children: ReactNode;
    /** Styles the panel. */
    className?: string | undefined;
};

/**
 * An edge-anchored panel built on Base UI Drawer.
 *
 * Base UI owns the modal focus trap, the scroll lock, Escape, focus return and the swipe gesture,
 * so a narrow screen gets the behaviour of a dialog without a second implementation. The drawer
 * stays modal: the page behind it is inert until it closes. Base UI focuses the panel on open,
 * which keeps the mobile virtual keyboard closed; a disabled primary action is skipped by the tab order,
 * so the first Tab reaches the first usable control.
 *
 * The portal stays mounted while the drawer is closed, so content such as a list keeps its search
 * text and scroll position across a close and a reopen. Base UI hides the panel and its backdrop
 * from the accessibility tree while it is closed.
 *
 * The panel sits above the software keyboard with the `--kb-inset` the rest of the app reads, and
 * its swipe direction follows `side`, so it always leaves towards the edge it entered from. The
 * portal is outside the safe-area padding of `#root`, so the viewport adds the system insets
 * itself and keeps the larger of the bottom safe area and the keyboard inset.
 */
export function Drawer({ open, onOpenChange, side = "left", label, children, className }: DrawerProps): ReactElement {
    return (
        <BaseDrawer.Root open={open} onOpenChange={onOpenChange} swipeDirection={side}>
            <BaseDrawer.Portal keepMounted>
                <BaseDrawer.Backdrop data-slot="drawer-backdrop" className={styles.backdrop} />
                <BaseDrawer.Viewport data-slot="drawer-viewport" data-side={side} className={styles.viewport}>
                    <BaseDrawer.Popup
                        data-slot="drawer"
                        data-side={side}
                        aria-label={label}
                        className={cn(styles.popup, className)}
                    >
                        <BaseDrawer.Content data-slot="drawer-content" className={styles.content}>
                            <DrawerContentContext.Provider value>{children}</DrawerContentContext.Provider>
                        </BaseDrawer.Content>
                    </BaseDrawer.Popup>
                </BaseDrawer.Viewport>
            </BaseDrawer.Portal>
        </BaseDrawer.Root>
    );
}
