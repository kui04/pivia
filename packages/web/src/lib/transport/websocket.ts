/** Minimal subset of the browser WebSocket interface used by transport clients. */
export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: (() => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
    onerror: (() => void) | null;
}

/** Constructor for an injectable WebSocket implementation. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * Returns the global WebSocket constructor.
 *
 * Throws an Error when `globalThis.WebSocket` is unavailable in the current environment.
 */
export function defaultWebSocketConstructor(): WebSocketConstructor {
    const constructor = globalThis.WebSocket;
    if (constructor === undefined) {
        throw new Error("WebSocket is not available in this environment.");
    }
    // Browser WebSocket shares the same surface; the cast narrows DOM event handlers to our interface.
    return constructor as unknown as WebSocketConstructor;
}
