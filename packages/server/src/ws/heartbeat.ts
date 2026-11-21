/** The part of a `ws` socket the heartbeat uses; test doubles satisfy the same shape. */
export interface HeartbeatSocket {
    readonly readyState: number;
    ping(): void;
    terminate(): void;
}

/** `ws` readyState value for an open connection. */
const WS_READY_STATE_OPEN = 1;

/** Options for {@link createHeartbeat}. */
export interface HeartbeatOptions {
    /** Ping interval in milliseconds; `0` disables the heartbeat entirely. */
    readonly intervalMs: number;
    /** Receives each socket that missed a pong, before it is terminated. */
    readonly onStale?: ((socket: HeartbeatSocket) => void) | undefined;
    /** Receives an error thrown by `ping` or `terminate`; the socket is dropped either way. */
    readonly onError?: ((error: unknown, socket: HeartbeatSocket) => void) | undefined;
}

/** Liveness tracking over a set of sockets. */
export interface Heartbeat {
    /** Starts tracking one socket; it receives its first ping on the next tick. */
    track(socket: HeartbeatSocket): void;
    /** Records a pong from one tracked socket. */
    markAlive(socket: HeartbeatSocket): void;
    /** Stops tracking one socket, for example after it closed. */
    untrack(socket: HeartbeatSocket): void;
    /** Stops the timer and forgets every socket. */
    dispose(): void;
    /** Number of sockets currently tracked. */
    readonly size: number;
}

/**
 * Start a WebSocket protocol-level ping/pong heartbeat.
 *
 * Browsers answer a ping in their network stack, so this needs no client code and no extra
 * application message. One unanswered ping terminates the socket: a peer that stopped answering
 * cannot finish a close handshake either, and a half-open socket keeps its session attachment
 * alive, which blocks idle reclamation of the runtime.
 */
export function createHeartbeat(options: HeartbeatOptions): Heartbeat {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
        throw new Error("intervalMs must be a non-negative finite number.");
    }
    const sockets = new Map<HeartbeatSocket, boolean>();
    let timer: NodeJS.Timeout | undefined;

    const tick = (): void => {
        for (const [socket, alive] of sockets) {
            if (socket.readyState !== WS_READY_STATE_OPEN) {
                sockets.delete(socket);
                continue;
            }
            if (!alive) {
                sockets.delete(socket);
                options.onStale?.(socket);
                try {
                    socket.terminate();
                } catch (error) {
                    options.onError?.(error, socket);
                }
                continue;
            }
            sockets.set(socket, false);
            try {
                socket.ping();
            } catch (error) {
                sockets.delete(socket);
                options.onError?.(error, socket);
            }
        }
    };

    if (options.intervalMs > 0) {
        timer = setInterval(tick, options.intervalMs);
        // A heartbeat must never keep the process or a test run alive on its own.
        timer.unref();
    }

    return {
        track(socket) {
            if (timer !== undefined) {
                sockets.set(socket, true);
            }
        },
        markAlive(socket) {
            if (sockets.has(socket)) {
                sockets.set(socket, true);
            }
        },
        untrack(socket) {
            sockets.delete(socket);
        },
        dispose() {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
            sockets.clear();
        },
        get size() {
            return sockets.size;
        },
    };
}
