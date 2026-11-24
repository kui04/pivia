/** Largest WebSocket frame the server accepts. */
export const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Default interval for the protocol-level ping that detects a dead peer.
 *
 * A client that stops answering is terminated one interval later, so a half-open link is cleaned
 * up within a minute.
 */
export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** Shared options for WebSocket route registration. */
export interface WsRouteOptions {
    /** Ping interval in milliseconds; `0` disables the heartbeat. */
    readonly heartbeatIntervalMs?: number | undefined;
}
