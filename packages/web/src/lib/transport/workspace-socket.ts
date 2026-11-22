import { parseWorkspaceWsServerMessage, type WorkspaceWsServerMessage } from "@pivia/protocol";

import { Log } from "@/lib/log";

import type { SessionSocketConstructor, SessionSocketLike } from "./session-socket";

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
    readonly WebSocket?: SessionSocketConstructor | undefined;
    readonly handlers: WorkspaceSocketHandlers;
}

/** Active `/ws/workspace` subscription handle. */
export interface WorkspaceSocket {
    close(code?: number, reason?: string): void;
}

/** Build the default `/ws/workspace` WebSocket endpoint from the current page origin. */
export function buildWorkspaceSocketUrl(pageUrl?: string): string {
    const source = pageUrl ?? globalThis.location?.href;
    if (source === undefined) {
        throw new Error("A WebSocket URL is required outside the browser.");
    }
    const url = new URL(source);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/workspace";
    url.search = "";
    url.hash = "";
    return url.toString();
}

function defaultSocketConstructor(): SessionSocketConstructor {
    const constructor = globalThis.WebSocket;
    if (constructor === undefined) {
        throw new Error("WebSocket is not available in this environment.");
    }
    // Browser WebSocket shares the same surface; the cast narrows DOM event handlers to our interface.
    return constructor as unknown as SessionSocketConstructor;
}

function detachHandlers(socket: SessionSocketLike): void {
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
    const SocketImpl = options.WebSocket ?? defaultSocketConstructor();
    const url = options.url ?? buildWorkspaceSocketUrl();
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
