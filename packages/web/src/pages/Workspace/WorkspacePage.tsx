import { useMemo, type ReactElement } from "react";

import type { SessionStoreInstance } from "@/stores/session";

import { SessionPane } from "./components";
import type { PaneTarget } from "./splitLayout";
import { useWorkspaceSession } from "./useWorkspaceSession";

/** Optional dependency injection used by isolated page stories and tests. */
export interface WorkspacePageProps {
    /** Single session store to bind to the current route. */
    readonly sessionStore: SessionStoreInstance;
    /** Forwarded to Markdown links rendered inside the transcript. */
    readonly onOpenLink?: ((href: string) => void) | undefined;
}

/** Open a followed link in a new tab so the session view never navigates away in place. */
function openExternalLink(href: string): void {
    window.open(href, "_blank", "noopener,noreferrer");
}

/**
 * Standalone routed session view for isolated stories and tests.
 *
 * Inside the live app shell, multi-pane workspaces render {@link SessionPane} via
 * `SplitWorkspace`.
 */
export function WorkspacePage({ sessionStore, onOpenLink = openExternalLink }: WorkspacePageProps): ReactElement {
    const binding = useMemo(() => sessionStore.getState(), [sessionStore]);
    const route = useWorkspaceSession({ sessionStore: binding });
    const target: PaneTarget =
        route.kind === "session"
            ? { kind: "session", sessionId: route.sessionId }
            : route.kind === "invalid"
              ? { kind: "invalid", raw: route.raw }
              : { kind: "empty" };

    return <SessionPane target={target} sessionStore={sessionStore} onOpenLink={onOpenLink} />;
}
