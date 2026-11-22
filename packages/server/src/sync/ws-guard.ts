import { SESSION_CLOSE_CODE, type SessionCloseCode } from "@pivia/protocol";

/** Close a client whose unsent backlog exceeds this, so a stalled link cannot grow memory. */
export const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Maximum inline WebSocket payload size before offloading entries to compressed HTTP. */
export const MAX_WS_INLINE_ENTRIES_BYTES = 512 * 1024;

/** Short-circuit threshold on entry count to avoid serializing huge slices over WS. */
export const MAX_WS_INLINE_ENTRY_COUNT = 1000;

const WS_READY_STATE_OPEN = 1;

/** Minimal WebSocket surface required by {@link createBackpressureSender}. */
export interface BackpressureSocket {
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

/** Structured logger subset accepted by sync transport guards. */
export interface SyncGuardLogger {
    warn(record: Record<string, unknown>, message: string): void;
}

/** Pre-serialized transport adapter passed into `SyncStreamHost.attach`. */
export interface SyncTransportClient {
    sendRaw(raw: string): void;
    close(code: SessionCloseCode, reason: string): void;
}

/** Options for {@link createBackpressureSender}. */
export interface BackpressureSenderOptions {
    /** Backlog byte limit before closing the socket as a slow consumer. Defaults to 4 MiB. */
    readonly maxBufferedBytes?: number | undefined;
    /** Optional log context fields included in slow-consumer and send-failure warnings. */
    readonly logContext?: Record<string, unknown> | undefined;
    /** Optional hook invoked immediately when the sender initiates a close. */
    readonly onClose?: (() => void) | undefined;
}

/**
 * Wrap a raw WebSocket so sends check `bufferedAmount` before writing and close stalled links
 * with `1013` (`slowConsumer`) instead of buffering unbounded deltas in memory.
 */
export function createBackpressureSender(
    socket: BackpressureSocket,
    logger: SyncGuardLogger,
    options: BackpressureSenderOptions = {},
): SyncTransportClient {
    const maxBufferedBytes = options.maxBufferedBytes ?? MAX_WS_BUFFERED_BYTES;
    const logContext = options.logContext ?? {};
    let closed = false;

    const close = (code: SessionCloseCode, reason: string): void => {
        if (closed) {
            return;
        }
        // Stop further sends before the close handshake finishes.
        closed = true;
        options.onClose?.();
        try {
            socket.close(code, reason);
        } catch (error) {
            logger.warn({ ...logContext, err: error }, "failed to close websocket");
        }
    };

    return {
        sendRaw(raw: string): void {
            if (closed || socket.readyState !== WS_READY_STATE_OPEN) {
                return;
            }
            if (socket.bufferedAmount > maxBufferedBytes) {
                logger.warn(
                    { ...logContext, bufferedAmount: socket.bufferedAmount },
                    "closing slow websocket consumer",
                );
                close(SESSION_CLOSE_CODE.slowConsumer, "Slow consumer");
                return;
            }
            try {
                socket.send(raw);
            } catch (error) {
                logger.warn({ ...logContext, err: error }, "failed to send websocket message");
            }
        },
        close,
    };
}

/** Parameters evaluated by {@link shouldOffloadPayload}. */
export interface OffloadCheckInput {
    readonly itemCount?: number | undefined;
    readonly maxItemCount?: number | undefined;
    readonly serializedBytes?: number | undefined;
    readonly maxBytes?: number | undefined;
}

/** Return true when a payload exceeds either the inline item count or UTF-8 byte budget. */
export function shouldOffloadPayload(input: OffloadCheckInput): boolean {
    const maxItemCount = input.maxItemCount ?? MAX_WS_INLINE_ENTRY_COUNT;
    const maxBytes = input.maxBytes ?? MAX_WS_INLINE_ENTRIES_BYTES;
    if (input.itemCount !== undefined && input.itemCount > maxItemCount) {
        return true;
    }
    if (input.serializedBytes !== undefined && input.serializedBytes > maxBytes) {
        return true;
    }
    return false;
}
