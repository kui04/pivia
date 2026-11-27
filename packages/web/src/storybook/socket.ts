import type { WebSocketConstructor, WebSocketLike } from "@/lib/transport";

/** In-memory socket a story harness opens and drives from its play function. */
export class StorySocket implements WebSocketLike {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {}

    send(): void {}

    close(): void {
        this.readyState = 3;
    }

    /** Moves the socket to OPEN and fires `onopen`. */
    open(): void {
        this.readyState = 1;
        this.onopen?.();
    }

    /** Delivers a JSON server frame. */
    receive(message: unknown): void {
        this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    }

    /** Delivers a server close; the default 1006 marks an abnormal closure. */
    serverClose(code = 1006, reason = "", wasClean = code === 1000): void {
        this.readyState = 3;
        this.onclose?.({ code, reason, wasClean } as CloseEvent);
    }
}

export interface StorySocketHandle {
    readonly WebSocket: WebSocketConstructor;
    /** The socket the store created last, or null before the first connect. */
    latest: () => StorySocket | null;
}

/**
 * Returns a WebSocket constructor a store can accept, plus access to the latest socket.
 *
 * `onConnect` runs in a microtask after construction, so a harness can open the socket and push an
 * initial frame before the play function runs. A silent socket is the default.
 */
export function createStorySocket(onConnect?: (socket: StorySocket) => void): StorySocketHandle {
    const instances: StorySocket[] = [];

    class Socket extends StorySocket {
        constructor(url: string) {
            super(url);
            instances.push(this);
            if (onConnect !== undefined) {
                queueMicrotask(() => {
                    onConnect(this);
                });
            }
        }
    }

    return {
        WebSocket: Socket,
        latest: () => instances.at(-1) ?? null,
    };
}
