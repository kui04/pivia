import type { ApiErrorCode, ApiErrorResponse } from "@pivia/protocol";
import type { FastifyReply } from "fastify";

import type { SessionRegistryError } from "../sessions/runtime.ts";

/** Send the standard JSON error envelope returned by HTTP endpoints. */
export function sendApiError(
    reply: FastifyReply,
    statusCode: number,
    error: ApiErrorCode,
    message: string,
): FastifyReply {
    const payload: ApiErrorResponse = { error, message };
    return reply.code(statusCode).send(payload);
}

/**
 * Answer a rejected WebSocket upgrade before the handshake completes.
 *
 * `@fastify/websocket` destroys the raw socket after the HTTP response, so `Connection: close`
 * tells HTTP clients and proxies not to return that socket to a keep-alive pool.
 */
export function sendWsUpgradeError(
    reply: FastifyReply,
    statusCode: number,
    error: ApiErrorCode,
    message: string,
): FastifyReply {
    reply.header("Connection", "close");
    return sendApiError(reply, statusCode, error, message);
}

/** Translate a registry failure into the standard API error envelope. */
export function sendRegistryError(reply: FastifyReply, error: SessionRegistryError): FastifyReply {
    if (error.code === "not_found") {
        return sendApiError(reply, 404, "not_found", error.message);
    }
    if (error.code === "directory_not_found") {
        return sendApiError(reply, 400, "directory_not_found", error.message);
    }
    return sendApiError(reply, 400, "invalid_request", error.message);
}
