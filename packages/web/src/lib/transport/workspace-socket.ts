import {
    parseWorkspaceWsServerMessage,
    WS_ENDPOINTS,
    type CatalogCursor,
    type WorkspaceWsServerMessage,
} from "@pivia/protocol";

import { Log } from "../log";

import {
    buildWebSocketUrl,
    defaultWebSocketConstructor,
    type WebSocketConstructor,
    type WebSocketLike,
} from "./websocket";

/** Lifecycle callbacks for {@link connectWorkspaceSocket}. */
export interface WorkspaceSocketHandlers {
    readonly onOpen?: (() => void) | undefined;
    readonly onMessage: (message: WorkspaceWsServerMessage) => void;
    readonly onClose: (event: { readonly code: number; readonly reason: string; readonly wasClean: boolean }) => void;
    readonly onProtocolError?: ((reason: string) => void) | undefined;
}

/** Options for {@link connectWorkspaceSocket}. */
export interface WorkspaceSocketOptions {
    readonly url?: string | undefined;
    readonly cursor?: CatalogCursor | undefined;
    readonly WebSocket?: WebSocketConstructor | undefined;
    readonly handlers: WorkspaceSocketHandlers;
}

/** Active `/ws/workspace` subscription handle. */
export interface WorkspaceSocket {
    close(code?: number, reason?: string): void;
}

/** Build the default `/ws/workspace` WebSocket endpoint from the current page origin. */
export function buildWorkspaceSocketUrl(pageUrl?: string, cursor?: CatalogCursor): string {
    return buildWebSocketUrl(WS_ENDPOINTS.workspace.buildPath(cursor === undefined ? undefined : { cursor }), pageUrl);
}

function detachHandlers(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
}

/**
 * Connect to `/ws/workspace` and decode every inbound server frame through
 * {@link parseWorkspaceWsServerMessage}.
 */
export function connectWorkspaceSocket(options: WorkspaceSocketOptions): WorkspaceSocket {
    const SocketImpl = options.WebSocket ?? defaultWebSocketConstructor();
    const url = options.url ?? buildWorkspaceSocketUrl(undefined, options.cursor);
    const socket = new SocketImpl(url);
    const { handlers } = options;

    let closed = false;

    socket.onopen = () => {
        if (closed) {
            return;
        }
        handlers.onOpen?.();
    };

    socket.onmessage = (event) => {
        if (closed) {
            return;
        }
        if (typeof event.data !== "string") {
            const reason = "Ignored a non-text workspace WebSocket frame.";
            Log.warn(reason);
            handlers.onProtocolError?.(reason);
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(event.data) as unknown;
        } catch {
            const reason = "Ignored a malformed workspace WebSocket JSON frame.";
            Log.warn(reason);
            handlers.onProtocolError?.(reason);
            return;
        }
        const message = parseWorkspaceWsServerMessage(parsed);
        if (message === null) {
            const reason = "Ignored an invalid workspace WebSocket message.";
            Log.warn(reason);
            handlers.onProtocolError?.(reason);
            return;
        }
        handlers.onMessage(message);
    };

    socket.onclose = (event) => {
        if (closed) {
            return;
        }
        closed = true;
        detachHandlers(socket);
        handlers.onClose({
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
        });
    };

    socket.onerror = () => {
        if (closed) {
            return;
        }
        Log.warn("Workspace WebSocket transport error");
    };

    return {
        close(code, reason) {
            if (closed) {
                return;
            }
            closed = true;
            detachHandlers(socket);
            try {
                socket.close(code, reason);
            } catch (error) {
                Log.warn("Failed to close the workspace socket", error);
            }
        },
    };
}
