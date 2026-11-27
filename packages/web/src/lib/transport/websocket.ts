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
 * Resolves a relative WebSocket endpoint path to an absolute `ws://` or `wss://` URL.
 *
 * Throws an Error when `pageUrl` is omitted outside a browser environment.
 */
export function buildWebSocketUrl(path: string, pageUrl?: string): string {
    // `location` is absent in Node, but the DOM types declare it always present.
    const pageLocation = globalThis.location as Location | undefined;
    const source = pageUrl ?? pageLocation?.href;
    if (source === undefined) {
        throw new Error("A WebSocket URL is required outside the browser.");
    }
    const url = new URL(path, source);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.hash = "";
    return url.toString();
}

/**
 * Returns the global WebSocket constructor.
 *
 * Throws an Error when `globalThis.WebSocket` is unavailable in the current environment.
 */
export function defaultWebSocketConstructor(): WebSocketConstructor {
    const constructor = globalThis.WebSocket as typeof globalThis.WebSocket | undefined;
    if (constructor === undefined) {
        throw new Error("WebSocket is not available in this environment.");
    }
    // Browser WebSocket shares the same surface; the cast narrows DOM event handlers to our interface.
    return constructor as unknown as WebSocketConstructor;
}
