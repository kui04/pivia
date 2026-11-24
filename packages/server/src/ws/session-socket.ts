import {
    commandIdOf,
    parseSessionWsClientMessage,
    SESSION_CLOSE_CODE,
    WS_ENDPOINTS,
    type SessionHandshake,
    type SessionId,
    type SessionWsClientMessage,
} from "@pivia/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { sendRegistryError, sendWsUpgradeError } from "../http/errors.ts";
import {
    type ActiveSessionHandle,
    type SessionAttachment,
    type SessionClient,
    type SessionRegistry,
    SessionRegistryError,
} from "../sessions/runtime.ts";
import { createBackpressureSender } from "../sync/index.ts";
import { createHeartbeat, type HeartbeatSocket } from "./heartbeat.ts";
import { DEFAULT_WS_HEARTBEAT_INTERVAL_MS, type WsRouteOptions } from "./options.ts";

interface OpenedWsSession {
    readonly handle: ActiveSessionHandle;
    readonly handshake: SessionHandshake;
}

/** Decode one text frame from the `ws` raw data union without `[object Object]` fallbacks. */
function websocketDataToText(data: unknown): string {
    if (typeof data === "string") {
        return data;
    }
    if (Buffer.isBuffer(data)) {
        return data.toString("utf8");
    }
    if (Array.isArray(data) && data.every((chunk): chunk is Buffer => Buffer.isBuffer(chunk))) {
        return Buffer.concat(data).toString("utf8");
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("utf8");
    }
    return "";
}

/**
 * Register the `/ws/sessions/:id` WebSocket route.
 *
 * Must be registered after `@fastify/websocket` so its `onRoute` hook converts the route into a
 * WebSocket handler. Multiplexes the `sync:*` Sync lane and orthogonal `rpc:*` command lane over
 * one connection with ping/pong heartbeat and backpressure eviction.
 */
export function registerSessionSocketRoute(
    app: FastifyInstance,
    sessionRegistry: SessionRegistry,
    options: WsRouteOptions = {},
): void {
    const sessionIds = new WeakMap<HeartbeatSocket, SessionId>();
    const heartbeat = createHeartbeat({
        intervalMs: options.heartbeatIntervalMs ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
        onStale(socket) {
            app.log.warn({ sessionId: sessionIds.get(socket) }, "terminating unresponsive websocket");
        },
        onError(error, socket) {
            app.log.warn({ err: error, sessionId: sessionIds.get(socket) }, "websocket heartbeat failed");
        },
    });
    app.addHook("onClose", () => {
        heartbeat.dispose();
    });

    app.register((instance, _options, done) => {
        // Handles and validated handshake anchors from `preValidation` for this upgrade. A WeakMap
        // avoids decorating every request for values only WebSocket routes read.
        const openedWsSessions = new WeakMap<FastifyRequest, OpenedWsSession>();

        instance.get(
            WS_ENDPOINTS.session.pattern,
            {
                websocket: true,
                preValidation: async (request, reply) => {
                    const params = WS_ENDPOINTS.session.parseParams(request.params);
                    if (params === null) {
                        return sendWsUpgradeError(reply, 400, "invalid_request", "Invalid session id.");
                    }
                    const handshake = WS_ENDPOINTS.session.parseQuery(request.query);
                    // A plain HTTP request to a WebSocket route falls through to the plugin's 404 handler.
                    if (!request.ws) {
                        return;
                    }
                    try {
                        const handle = await sessionRegistry.open(params.id);
                        openedWsSessions.set(request, { handle, handshake });
                    } catch (error) {
                        if (error instanceof SessionRegistryError) {
                            reply.header("Connection", "close");
                            return sendRegistryError(reply, error);
                        }
                        request.log.error({ err: error, sessionId: params.id }, "failed to open session for websocket");
                        return sendWsUpgradeError(reply, 500, "internal_error", "Internal server error.");
                    }
                },
            },
            (socket, request) => {
                const opened = openedWsSessions.get(request);
                openedWsSessions.delete(request);
                if (opened === undefined) {
                    socket.close(SESSION_CLOSE_CODE.internalError, "Session unavailable");
                    return;
                }
                const { handle, handshake } = opened;

                let socketClosed = false;
                let attachment: SessionAttachment | undefined;
                const bufferedMessages: SessionWsClientMessage[] = [];
                let commandChain: Promise<void> = Promise.resolve();

                const sender = createBackpressureSender(socket, request.log, {
                    logContext: { sessionId: handle.sessionId },
                    onClose: () => {
                        socketClosed = true;
                        attachment?.detach();
                        attachment = undefined;
                    },
                });
                const client: SessionClient = {
                    send(message) {
                        sender.sendRaw(JSON.stringify(message));
                    },
                    sendRaw(raw) {
                        sender.sendRaw(raw);
                    },
                    close(code, reason) {
                        sender.close(code, reason);
                    },
                };

                const sendProtocolError = (code: string, message: string, id?: string): void => {
                    client.send({ type: "rpc:error", code, message, ...(id === undefined ? {} : { id }) });
                };

                const executeMessage = async (message: SessionWsClientMessage): Promise<void> => {
                    const current = attachment;
                    if (current === undefined) {
                        const id = message.type === "rpc:command" ? message.command.id : message.response.id;
                        sendProtocolError("internal_error", "Session is not attached.", id);
                        return;
                    }
                    await current.handleMessage(message);
                };

                const dispatchMessage = (message: SessionWsClientMessage): void => {
                    if (message.type === "rpc:ui_response") {
                        // UI answers bypass the command chain. A long prompt/compact on the same
                        // socket must not delay the dialog response that unblocks it.
                        if (attachment === undefined) {
                            bufferedMessages.push(message);
                            return;
                        }
                        void executeMessage(message).catch((error: unknown) => {
                            request.log.warn(
                                { err: error, sessionId: handle.sessionId },
                                "failed to process extension UI response",
                            );
                            sendProtocolError(
                                "internal_error",
                                "Failed to process extension UI response.",
                                message.response.id,
                            );
                        });
                        return;
                    }

                    if (attachment === undefined) {
                        bufferedMessages.push(message);
                        return;
                    }
                    commandChain = commandChain
                        .then(() => executeMessage(message))
                        .catch((error: unknown) => {
                            request.log.warn(
                                { err: error, sessionId: handle.sessionId },
                                "failed to process websocket command",
                            );
                            sendProtocolError("internal_error", "Failed to process command.", message.command.id);
                        });
                };

                // Attach listeners synchronously before attaching to the registry so messages sent
                // during the attach window are buffered instead of dropped.
                socket.on("message", (data: unknown, isBinary: boolean) => {
                    if (socketClosed) {
                        return;
                    }
                    if (isBinary) {
                        sendProtocolError("invalid_request", "Binary messages are not supported.");
                        return;
                    }
                    const text = websocketDataToText(data);
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(text);
                    } catch {
                        sendProtocolError("invalid_json", "Failed to parse command JSON.");
                        return;
                    }
                    const message = parseSessionWsClientMessage(parsed);
                    if (message === null) {
                        sendProtocolError("invalid_request", "Invalid command.", commandIdOf(parsed));
                        return;
                    }
                    dispatchMessage(message);
                });
                socket.on("close", () => {
                    socketClosed = true;
                    heartbeat.untrack(socket);
                    sessionIds.delete(socket);
                    attachment?.detach();
                    attachment = undefined;
                    bufferedMessages.length = 0;
                });
                socket.on("error", (error: Error) => {
                    request.log.warn({ err: error, sessionId: handle.sessionId }, "websocket connection error");
                });
                socket.on("pong", () => {
                    heartbeat.markAlive(socket);
                });
                sessionIds.set(socket, handle.sessionId);
                heartbeat.track(socket);

                try {
                    attachment = sessionRegistry.attach(handle.sessionId, client, handshake);
                } catch (error) {
                    if (error instanceof SessionRegistryError && error.code === "not_found") {
                        sendProtocolError("not_found", "Session is not open.");
                        client.close?.(SESSION_CLOSE_CODE.sessionNotFound, "Session not found");
                        return;
                    }
                    request.log.warn({ err: error, sessionId: handle.sessionId }, "failed to attach websocket client");
                    sendProtocolError("internal_error", "Failed to attach session.");
                    client.close?.(SESSION_CLOSE_CODE.internalError, "Session unavailable");
                    return;
                }

                for (const message of bufferedMessages.splice(0)) {
                    dispatchMessage(message);
                }
            },
        );
        done();
    });
}
