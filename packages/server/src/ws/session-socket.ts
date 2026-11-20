import { SESSION_CLOSE_CODE, type WsClientCommand } from "@pivia/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { sendRegistryError, sendWsUpgradeError } from "../http/errors.ts";
import { isValidSessionId } from "../sessions/catalog.ts";
import {
    type ActiveSessionHandle,
    type SessionAttachment,
    type SessionClient,
    type SessionRegistry,
    SessionRegistryError,
} from "../sessions/runtime.ts";
import { commandIdOf, parseAfterSeq, parseWsClientCommand } from "./protocol.ts";

/** Largest WebSocket frame the server accepts. */
export const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Close a client whose unsent backlog exceeds this, so a stalled mobile link cannot grow memory. */
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

/** `ws` readyState value for an open connection. */
const WS_READY_STATE_OPEN = 1;

interface WsSessionParams {
    readonly id: string;
}

interface WsSessionQuery {
    readonly afterSeq?: string;
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
 * WebSocket handler.
 */
export function registerSessionSocketRoute(app: FastifyInstance, sessionRegistry: SessionRegistry): void {
    app.register((instance, _options, done) => {
        // Handles of sessions opened during `preValidation` for this upgrade. A WeakMap avoids
        // decorating every request for a value only WebSocket routes read.
        const openedWsSessions = new WeakMap<FastifyRequest, ActiveSessionHandle>();

        instance.get<{ Params: WsSessionParams; Querystring: WsSessionQuery }>(
            "/ws/sessions/:id",
            {
                websocket: true,
                preValidation: async (request, reply) => {
                    const { id } = request.params;
                    if (!isValidSessionId(id)) {
                        return sendWsUpgradeError(reply, 400, "invalid_request", "Invalid session id.");
                    }
                    if (parseAfterSeq(request.query.afterSeq) === null) {
                        return sendWsUpgradeError(reply, 400, "invalid_request", "Invalid afterSeq parameter.");
                    }
                    // A plain HTTP request to a WebSocket route falls through to the plugin's 404 handler.
                    if (!request.ws) {
                        return;
                    }
                    try {
                        openedWsSessions.set(request, await sessionRegistry.open(id));
                    } catch (error) {
                        if (error instanceof SessionRegistryError) {
                            reply.header("Connection", "close");
                            return sendRegistryError(reply, error);
                        }
                        request.log.error({ err: error, sessionId: id }, "failed to open session for websocket");
                        return sendWsUpgradeError(reply, 500, "internal_error", "Internal server error.");
                    }
                },
            },
            (socket, request) => {
                const handle = openedWsSessions.get(request);
                openedWsSessions.delete(request);
                if (handle === undefined) {
                    socket.close(SESSION_CLOSE_CODE.internalError, "Session unavailable");
                    return;
                }

                const afterSeq = parseAfterSeq(request.query.afterSeq);
                if (afterSeq === null) {
                    socket.close(SESSION_CLOSE_CODE.internalError, "Invalid afterSeq");
                    return;
                }

                let socketClosed = false;
                const closeSocket = (code: number, reason: string): void => {
                    if (socketClosed) {
                        return;
                    }
                    // Stop further sends before the close handshake finishes.
                    socketClosed = true;
                    try {
                        socket.close(code, reason);
                    } catch (error) {
                        request.log.warn({ err: error, sessionId: handle.sessionId }, "failed to close websocket");
                    }
                };
                const client: SessionClient = {
                    send(message) {
                        if (socketClosed || socket.readyState !== WS_READY_STATE_OPEN) {
                            return;
                        }
                        if (socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
                            request.log.warn(
                                { sessionId: handle.sessionId, bufferedAmount: socket.bufferedAmount },
                                "closing slow websocket consumer",
                            );
                            closeSocket(SESSION_CLOSE_CODE.slowConsumer, "Slow consumer");
                            return;
                        }
                        try {
                            socket.send(JSON.stringify(message));
                        } catch (error) {
                            request.log.warn(
                                { err: error, sessionId: handle.sessionId },
                                "failed to send websocket message",
                            );
                        }
                    },
                    close(code, reason) {
                        closeSocket(code, reason);
                    },
                };

                let attachment: SessionAttachment | undefined;
                const bufferedCommands: WsClientCommand[] = [];
                let commandChain: Promise<void> = Promise.resolve();

                const sendProtocolError = (code: string, message: string, id?: string): void => {
                    client.send({ type: "error", code, message, ...(id === undefined ? {} : { id }) });
                };

                const executeCommand = async (command: WsClientCommand): Promise<void> => {
                    const current = attachment;
                    if (current === undefined) {
                        sendProtocolError("internal_error", "Session is not attached.", command.id);
                        return;
                    }
                    await current.handleCommand(command);
                };

                const dispatchCommand = (command: WsClientCommand): void => {
                    if (command.type === "extension_ui_response") {
                        // UI answers bypass the command chain. A long prompt/compact on the same
                        // socket must not delay the dialog response that unblocks it.
                        if (attachment === undefined) {
                            bufferedCommands.push(command);
                            return;
                        }
                        void executeCommand(command).catch((error: unknown) => {
                            request.log.warn(
                                { err: error, sessionId: handle.sessionId },
                                "failed to process extension UI response",
                            );
                            sendProtocolError("internal_error", "Failed to process extension UI response.", command.id);
                        });
                        return;
                    }

                    if (attachment === undefined) {
                        bufferedCommands.push(command);
                        return;
                    }
                    commandChain = commandChain
                        .then(() => executeCommand(command))
                        .catch((error: unknown) => {
                            request.log.warn(
                                { err: error, sessionId: handle.sessionId },
                                "failed to process websocket command",
                            );
                            sendProtocolError("internal_error", "Failed to process command.", command.id);
                        });
                };

                // Attach the listeners synchronously before any asynchronous work so a client that
                // sends a command during the attach window is buffered instead of dropped.
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
                    const command = parseWsClientCommand(parsed);
                    if (command === null) {
                        sendProtocolError("invalid_request", "Invalid command.", commandIdOf(parsed));
                        return;
                    }
                    dispatchCommand(command);
                });
                socket.on("close", () => {
                    socketClosed = true;
                    attachment?.detach();
                    attachment = undefined;
                    bufferedCommands.length = 0;
                });
                socket.on("error", (error: Error) => {
                    request.log.warn({ err: error, sessionId: handle.sessionId }, "websocket connection error");
                });

                try {
                    attachment = sessionRegistry.attach(handle.sessionId, client, { afterSeq });
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

                for (const command of bufferedCommands.splice(0)) {
                    dispatchCommand(command);
                }
            },
        );
        done();
    });
}
