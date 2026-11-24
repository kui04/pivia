import { parseSessionPathParams, type SessionPathParams } from "../sessions/ids.ts";
import { encodeSessionWsHandshakeQuery, parseSessionWsHandshakeQuery, type SessionHandshake } from "../sessions/ws.ts";
import { appendQuery, type WsParamsQueryEndpoint, type WsQueryEndpoint } from "../shared/endpoint.ts";
import { encodeSyncHandshakeQuery, parseSyncHandshakeQuery } from "../sync/index.ts";
import type { WorkspaceWsHandshake } from "../workspace/ws.ts";

/** Single source of truth for every WebSocket endpoint path and param/query codec. */
export const WS_ENDPOINTS = {
    workspace: {
        pattern: "/ws/workspace",
        buildPath: (query?: WorkspaceWsHandshake) => appendQuery("/ws/workspace", encodeSyncHandshakeQuery(query)),
        encodeQuery: (query?: WorkspaceWsHandshake) => encodeSyncHandshakeQuery(query),
        parseQuery: (raw: unknown): WorkspaceWsHandshake => parseSyncHandshakeQuery<"catalog">(raw),
    } satisfies WsQueryEndpoint<"/ws/workspace", WorkspaceWsHandshake>,

    session: {
        pattern: "/ws/sessions/:id",
        buildPath: (params: SessionPathParams, query?: SessionHandshake) =>
            appendQuery(`/ws/sessions/${encodeURIComponent(params.id)}`, encodeSessionWsHandshakeQuery(query)),
        parseParams: parseSessionPathParams,
        encodeQuery: encodeSessionWsHandshakeQuery,
        parseQuery: parseSessionWsHandshakeQuery,
    } satisfies WsParamsQueryEndpoint<"/ws/sessions/:id", SessionPathParams, SessionHandshake>,
} as const;

/** Key union of all registered WebSocket endpoints. */
export type WsEndpointKey = keyof typeof WS_ENDPOINTS;

/** Union of all registered WebSocket endpoint descriptors. */
export type WsEndpoint = (typeof WS_ENDPOINTS)[WsEndpointKey];
