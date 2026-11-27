import type { WebSocketLike } from "@/lib/transport";

/**
 * In-memory `WebSocketLike` for transport, store, and controller tests.
 *
 * Call `FakeWebSocket.reset()` from `beforeEach` so a test only sees its own sockets.
 */
export class FakeWebSocket implements WebSocketLike {
    static instances: FakeWebSocket[] = [];

    static reset(): void {
        FakeWebSocket.instances = [];
    }

    readonly url: string;
    readonly sent: string[] = [];
    readonly closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(code?: number, reason?: string): void {
        this.closeCalls.push({
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
        });
        this.readyState = 3;
    }

    /** Moves the socket to OPEN and fires `onopen`. */
    open(): void {
        this.readyState = 1;
        this.onopen?.();
    }

    /** Serializes the message as JSON, as a real socket delivers server frames. */
    receive(message: unknown): void {
        this.receiveRaw(JSON.stringify(message));
    }

    /** Fires `onmessage` with raw event data, for non-JSON, non-string, and malformed frames. */
    receiveRaw(data: unknown): void {
        this.onmessage?.({ data } as MessageEvent);
    }

    /** Fires a server-side close; the default 1006 marks an abnormal closure. */
    serverClose(code = 1006, reason = "", wasClean = code === 1000): void {
        this.readyState = 3;
        this.onclose?.({ code, reason, wasClean } as CloseEvent);
    }
}
