import type { SessionId } from "@pivia/protocol";
import { Copy, X } from "lucide-react";
import type { ReactElement } from "react";

import { MenuItem } from "@components";

export interface SessionCommonMenuItemsProps {
    readonly sessionId: SessionId;
    /** True while the session is closing or cannot receive the close command. */
    readonly closeDisabled: boolean;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onCloseSession: (id: SessionId) => void;
}

/**
 * Copy and close actions shared by the session row and the topbar menus.
 *
 * A fragment keeps both items direct children of the caller's Menu, so the menu keeps its ARIA
 * structure and spacing.
 */
export function SessionCommonMenuItems({
    sessionId,
    closeDisabled,
    onCopySessionId,
    onCloseSession,
}: SessionCommonMenuItemsProps): ReactElement {
    return (
        <>
            <MenuItem
                icon={<Copy />}
                onClick={() => {
                    onCopySessionId(sessionId);
                }}
            >
                Copy session ID
            </MenuItem>
            <MenuItem
                icon={<X />}
                disabled={closeDisabled}
                onClick={() => {
                    onCloseSession(sessionId);
                }}
            >
                Close session
            </MenuItem>
        </>
    );
}
