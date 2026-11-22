import {
    commandIdOf,
    parseSessionId,
    parseSessionWsClientCommand,
    parseSessionWsHandshakeQuery,
    SESSION_CLOSE_CODE,
    type ParsedSessionWsHandshakeQuery,
    type SessionId,
    type SessionWsClientCommand,
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
import { createHeartbeat, type HeartbeatSocket } from "./heartbeat.ts";

/** Largest WebSocket frame the server accepts. */
export const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Default interval for the protocol-level ping that detects a dead peer.
 *
 * A client that stops answering is terminated one interval later, so a half-open link is cleaned
 * up within a minute.
 */
export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** Options for {@link registerSessionSocketRoute}. */
export interface SessionSocketRouteOptions {
    /** Ping interval in milliseconds; `0` disables the heartbeat. */
    readonly heartbeatIntervalMs?: number | undefined;
}

/** Close a client whose unsent backlog exceeds this, so a stalled mobile link cannot grow memory. */
export const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

/** `ws` readyState value for an open connection. */
const WS_READY_STATE_OPEN = 1;

interface WsSessionParams {
    readonly id: string;
}

interface WsSessionQuery {
    readonly afterSeq?: string;
    readonly runtimeId?: string;
    readonly entriesVersion?: string;
    readonly afterCount?: string;
    readonly afterEntryId?: string;
}

interface OpenedWsSession {
    readonly handle: ActiveSessionHandle;
    readonly handshake: ParsedSessionWsHandshakeQuery;
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
 * WebSocket handler. The route also runs a protocol-level ping/pong heartbeat so a peer that
 * disappears without closing its socket cannot hold its attachment forever.
 */
export function registerSessionSocketRoute(
    app: FastifyInstance,
    sessionRegistry: SessionRegistry,
    options: SessionSocketRouteOptions = {},
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

        instance.get<{ Params: WsSessionParams; Querystring: WsSessionQuery }>(
            "/ws/sessions/:id",
            {
                websocket: true,
                preValidation: async (request, reply) => {
                    const sessionId = parseSessionId(request.params.id);
                    if (sessionId === null) {
                        return sendWsUpgradeError(reply, 400, "invalid_request", "Invalid session id.");
                    }
                    const parsedQuery = parseSessionWsHandshakeQuery(request.query);
                    if (!parsedQuery.ok) {
                        return sendWsUpgradeError(reply, 400, "invalid_request", parsedQuery.message);
                    }
                    // A plain HTTP request to a WebSocket route falls through to the plugin's 404 handler.
                    if (!request.ws) {
                        return;
                    }
                    try {
                        const handle = await sessionRegistry.open(sessionId);
                        openedWsSessions.set(request, { handle, handshake: parsedQuery.value });
                    } catch (error) {
                        if (error instanceof SessionRegistryError) {
                            reply.header("Connection", "close");
                            return sendRegistryError(reply, error);
                        }
                        request.log.error({ err: error, sessionId }, "failed to open session for websocket");
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
                const sendRawText = (payload: string): void => {
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
                        socket.send(payload);
                    } catch (error) {
                        request.log.warn(
                            { err: error, sessionId: handle.sessionId },
                            "failed to send websocket message",
                        );
                    }
                };
                const client: SessionClient = {
                    send(message) {
                        sendRawText(JSON.stringify(message));
                    },
                    sendRaw(raw) {
                        sendRawText(raw);
                    },
                    close(code, reason) {
                        closeSocket(code, reason);
                    },
                };

                let attachment: SessionAttachment | undefined;
                const bufferedCommands: SessionWsClientCommand[] = [];
                let commandChain: Promise<void> = Promise.resolve();

                const sendProtocolError = (code: string, message: string, id?: string): void => {
                    client.send({ type: "error", code, message, ...(id === undefined ? {} : { id }) });
                };

                const executeCommand = async (command: SessionWsClientCommand): Promise<void> => {
                    const current = attachment;
                    if (current === undefined) {
                        sendProtocolError("internal_error", "Session is not attached.", command.id);
                        return;
                    }
                    await current.handleCommand(command);
                };

                const dispatchCommand = (command: SessionWsClientCommand): void => {
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
                    const command = parseSessionWsClientCommand(parsed);
                    if (command === null) {
                        sendProtocolError("invalid_request", "Invalid command.", commandIdOf(parsed));
                        return;
                    }
                    dispatchCommand(command);
                });
                socket.on("close", () => {
                    socketClosed = true;
                    heartbeat.untrack(socket);
                    sessionIds.delete(socket);
                    attachment?.detach();
                    attachment = undefined;
                    bufferedCommands.length = 0;
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

                for (const command of bufferedCommands.splice(0)) {
                    dispatchCommand(command);
                }
            },
        );
        done();
    });
}
