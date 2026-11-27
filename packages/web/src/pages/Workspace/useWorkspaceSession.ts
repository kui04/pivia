import { parseSessionId, type SessionId } from "@pivia/protocol";
import { useEffect, useMemo } from "react";
import { useParams } from "react-router";

/** Dependencies of {@link useWorkspaceSession}. */
export interface UseWorkspaceSessionOptions {
    /** Single-session store binding to drive. */
    readonly sessionStore: WorkspaceSessionBinding;
}

/** The route segment `:sessionId` resolved into a store request. */
export type WorkspaceSessionRoute =
    | { readonly kind: "none" }
    | { readonly kind: "invalid"; readonly raw: string }
    | { readonly kind: "session"; readonly sessionId: SessionId };

/** The session store actions the route binding drives. */
export interface WorkspaceSessionBinding {
    connect: (sessionId: SessionId) => void;
    disconnect: () => void;
}

/**
 * Resolve the raw `:sessionId` route segment.
 *
 * The segment comes from the URL, so it is parsed here instead of being handed to the store: an
 * invalid id must never reach a request path.
 */
export function parseWorkspaceSessionRoute(raw: string | undefined): WorkspaceSessionRoute {
    if (raw === undefined) {
        return { kind: "none" };
    }
    const sessionId = parseSessionId(raw);
    return sessionId === null ? { kind: "invalid", raw } : { kind: "session", sessionId };
}

/**
 * Bind the session store to one route session and return the detach callback.
 *
 * The caller runs the callback on route change and on unmount. Anything other than a parsed
 * session disconnects, so a closed, removed or hand-edited URL cannot keep streaming the previous
 * session behind an error message.
 *
 * @param store - Store to bind; it must expose `connect` and `disconnect`.
 * @param route - Resolved route segment.
 * @returns Cleanup that disconnects the session the binding connected.
 */
export function attachWorkspaceSession(store: WorkspaceSessionBinding, route: WorkspaceSessionRoute): () => void {
    if (route.kind !== "session") {
        store.disconnect();
        return () => undefined;
    }
    store.connect(route.sessionId);
    return () => {
        store.disconnect();
    };
}

/**
 * Keep a single-session store attached to the routed `:sessionId`.
 *
 * Used by standalone single-session views; multi-pane workspaces coordinate connections through
 * {@link SessionPool} in `WorkspaceLayout`.
 *
 * @returns The resolved route segment, so the page can tell a missing session from an invalid one.
 */
export function useWorkspaceSession(options: UseWorkspaceSessionOptions): WorkspaceSessionRoute {
    const { sessionStore } = options;
    const { sessionId: rawSessionId } = useParams<{ sessionId?: string }>();
    const route = useMemo(() => parseWorkspaceSessionRoute(rawSessionId), [rawSessionId]);

    useEffect(() => attachWorkspaceSession(sessionStore, route), [route, sessionStore]);

    return route;
}
