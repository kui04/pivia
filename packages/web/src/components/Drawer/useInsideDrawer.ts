import { createContext, useContext } from "react";

/** True inside a drawer panel; the default suits every other place a descendant can render. */
export const DrawerContentContext = createContext(false);

/**
 * Whether the caller renders inside a drawer panel.
 *
 * The panel portals to `document.body`, so a component cannot tell from the DOM or from its props
 * whether it is the wide column or the drawer. Content that owns page-level gestures, such as a drag
 * region, must not claim them inside a modal panel, where a drag would swallow the swipe.
 */
export function useInsideDrawer(): boolean {
    return useContext(DrawerContentContext);
}
