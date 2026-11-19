import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import type {
    ApiErrorCode,
    ApiErrorResponse,
    AuthLoginRequest,
    AuthLoginResponse,
    AuthLogoutResponse,
    AuthStatusResponse,
    CloseSessionResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    HealthResponse,
    SessionDetailResponse,
    SessionListResponse,
    WsClientCommand,
} from "@pivia/protocol";

import { AuthService, SESSION_COOKIE_NAME, type AuthServiceOptions } from "./auth.ts";
import { createLogger } from "./logger.ts";
import {
    type ActiveSessionHandle,
    SessionRegistry,
    SessionRegistryError,
    type SessionAttachment,
    type SessionClient,
} from "./runtime.ts";
import { isValidSessionId, SessionCatalog } from "./sessions.ts";
import { commandIdOf, parseAfterSeq, parseWsClientCommand } from "./ws-protocol.ts";

/** Options for {@link buildApp}. */
export interface BuildAppOptions {
    /** Application version reported by `/api/health`; defaults to `"0.0.0"`. */
    version?: string | undefined;
    /** Pre-configured logger; defaults to a `stderr` Pino logger. */
    logger?: FastifyBaseLogger | undefined;
    /** Explicit authentication configuration (`{ disabled: true }` to opt out). */
    auth: AuthServiceOptions | AuthService;
    /** Session catalog for `/api/sessions`; defaults to one rooted at the pi session directory. */
    sessions?: SessionCatalog | undefined;
    /** Session runtime registry; defaults to one using the production pi runtime factory. */
    registry?: SessionRegistry | undefined;
}

const PUBLIC_API_PATHS = new Set(["/api/health", "/api/auth", "/api/auth/status", "/api/auth/logout"]);

/** Largest WebSocket frame the server accepts. */
const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Close a client whose unsent backlog exceeds this, so a stalled mobile link cannot grow memory. */
const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

/** `ws` readyState value for an open connection. */
const WS_READY_STATE_OPEN = 1;

/** Close codes used by the session WebSocket route. */
const WS_CLOSE_SLOW_CONSUMER = 1013;
const WS_CLOSE_SESSION_NOT_FOUND = 4404;
const WS_CLOSE_INTERNAL_ERROR = 1011;

const LOGIN_BODY_SCHEMA = {
    type: "object",
    required: ["password"],
    additionalProperties: false,
    properties: {
        password: { type: "string", minLength: 1 },
    },
} as const;

const CREATE_SESSION_BODY_SCHEMA = {
    type: "object",
    required: ["cwd"],
    additionalProperties: false,
    properties: {
        cwd: { type: "string", minLength: 1 },
    },
} as const;

function sendApiError(reply: FastifyReply, statusCode: number, error: ApiErrorCode, message: string): FastifyReply {
    const payload: ApiErrorResponse = { error, message };
    return reply.code(statusCode).send(payload);
}

/**
 * Answer a rejected WebSocket upgrade before the handshake completes.
 *
 * `@fastify/websocket` destroys the raw socket after the HTTP response, so `Connection: close`
 * tells HTTP clients and proxies not to return that socket to a keep-alive pool.
 */
function sendWsUpgradeError(
    reply: FastifyReply,
    statusCode: number,
    error: ApiErrorCode,
    message: string,
): FastifyReply {
    reply.header("Connection", "close");
    return sendApiError(reply, statusCode, error, message);
}

/** Auth failures on WebSocket paths must not leave the rejected socket in a keep-alive pool. */
function sendAuthError(
    pathname: string,
    reply: FastifyReply,
    statusCode: number,
    error: ApiErrorCode,
    message: string,
): FastifyReply {
    if (pathname.startsWith("/ws/")) {
        reply.header("Connection", "close");
    }
    return sendApiError(reply, statusCode, error, message);
}

function stripQuery(url: string): string {
    const qIndex = url.indexOf("?");
    return qIndex === -1 ? url : url.slice(0, qIndex);
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

/** Translate a registry failure into the standard API error envelope. */
function sendRegistryError(reply: FastifyReply, error: SessionRegistryError): FastifyReply {
    if (error.code === "not_found") {
        return sendApiError(reply, 404, "not_found", error.message);
    }
    return sendApiError(reply, 400, "invalid_request", error.message);
}

interface WsSessionParams {
    readonly id: string;
}

interface WsSessionQuery {
    readonly afterSeq?: string;
}

/**
 * Build and configure the Fastify application without binding a network port.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
    const version = options.version ?? "0.0.0";
    const logger: FastifyBaseLogger = options.logger ?? createLogger();
    const authService = options.auth instanceof AuthService ? options.auth : new AuthService(options.auth);
    const sessionCatalog = options.sessions ?? new SessionCatalog({ logger });
    const sessionRegistry =
        options.registry ??
        new SessionRegistry({
            catalog: sessionCatalog,
            logger,
        });

    const app = Fastify({
        loggerInstance: logger,
        // Trust loopback reverse proxies (e.g. tailscale serve, Caddy) so `request.protocol`
        // reflects HTTPS for `secure: "auto"` and `request.ip` resolves per remote client behind
        // the proxy instead of collapsing all proxied clients into `127.0.0.1`.
        trustProxy: "loopback",
        ajv: {
            customOptions: {
                // Reject unknown JSON properties instead of stripping them silently.
                removeAdditional: false,
            },
        },
    });

    app.setNotFoundHandler((_request, reply) => {
        return sendApiError(reply, 404, "not_found", "Not found.");
    });

    app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
        if (err.validation) {
            return sendApiError(reply, 400, "invalid_request", err.message);
        }
        const statusCode =
            typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
        if (statusCode >= 500) {
            logger.error({ err }, "unhandled request error");
            return sendApiError(reply, statusCode, "internal_error", "Internal server error.");
        }
        const message = statusCode === 415 ? "Unsupported media type." : "Invalid request.";
        return sendApiError(reply, statusCode, "invalid_request", message);
    });

    // Must be registered before the auth `onRequest` hook so `request.cookies` is populated first.
    app.register(cookie);

    // `perMessageDeflate` stays off: streaming deltas are many small messages, and per-message
    // zlib state fragments the heap under sustained use. `maxPayload` bounds one client's frame.
    app.register(websocket, {
        options: {
            maxPayload: MAX_WS_PAYLOAD_BYTES,
            perMessageDeflate: false,
        },
    });

    app.addHook("onClose", async () => {
        await sessionRegistry.disposeAll();
    });

    app.addHook("onRequest", async (request, reply) => {
        const pathname = stripQuery(request.url);
        if (!pathname.startsWith("/api/") && !pathname.startsWith("/ws/")) {
            return;
        }
        if (PUBLIC_API_PATHS.has(pathname)) {
            return;
        }

        const result = authService.authenticateRequest(request, request.ip);
        if (result.authenticated) {
            return;
        }

        if (result.rateLimited) {
            request.log.warn({ clientIp: request.ip, pathname }, "authentication rate-limited");
            reply.header("Retry-After", String(result.retryAfterSeconds));
            return sendAuthError(
                pathname,
                reply,
                429,
                "rate_limited",
                "Too many failed authentication attempts. Try again later.",
            );
        }

        if (result.badBearer) {
            request.log.warn({ clientIp: request.ip, pathname }, "invalid bearer credential");
        }
        return sendAuthError(pathname, reply, 401, "unauthorized", "Authentication required.");
    });

    app.get("/api/health", (): HealthResponse => {
        return {
            status: "ok",
            version,
        };
    });

    app.get("/api/auth/status", (request, reply): AuthStatusResponse | FastifyReply => {
        if (!authService.authRequired) {
            return { authRequired: false, authenticated: true };
        }
        const result = authService.authenticateRequest(request, request.ip);
        if (!result.authenticated && result.rateLimited) {
            request.log.warn({ clientIp: request.ip, pathname: "/api/auth/status" }, "authentication rate-limited");
            reply.header("Retry-After", String(result.retryAfterSeconds));
            return sendApiError(
                reply,
                429,
                "rate_limited",
                "Too many failed authentication attempts. Try again later.",
            );
        }
        if (!result.authenticated && result.badBearer) {
            request.log.warn({ clientIp: request.ip, pathname: "/api/auth/status" }, "invalid bearer credential");
        }
        return {
            authRequired: true,
            authenticated: result.authenticated,
        };
    });

    app.post<{ Body: AuthLoginRequest }>(
        "/api/auth",
        {
            schema: {
                body: LOGIN_BODY_SCHEMA,
            },
        },
        (request, reply): AuthLoginResponse | void => {
            if (!authService.authRequired) {
                return { authenticated: true };
            }

            const attempt = authService.login(request.body.password, request.ip);
            if (!attempt.ok) {
                if (attempt.reason === "rate_limited") {
                    request.log.warn({ clientIp: request.ip }, "login rate-limited");
                    reply.header("Retry-After", String(attempt.retryAfterSeconds));
                    sendApiError(reply, 429, "rate_limited", "Too many failed login attempts. Try again later.");
                    return;
                }
                request.log.warn({ clientIp: request.ip }, "login failed with invalid password");
                sendApiError(reply, 401, "invalid_credentials", "Invalid password.");
                return;
            }

            authService.setSessionCookie(reply, attempt.sessionId);
            return { authenticated: true };
        },
    );

    app.post("/api/auth/logout", (request, reply): AuthLogoutResponse => {
        authService.logout(request.cookies[SESSION_COOKIE_NAME]);
        authService.clearSessionCookie(reply);
        return { authenticated: false };
    });

    app.get("/api/sessions", async (): Promise<SessionListResponse> => {
        return sessionRegistry.list();
    });

    app.post<{ Body: CreateSessionRequest }>(
        "/api/sessions",
        {
            schema: {
                body: CREATE_SESSION_BODY_SCHEMA,
            },
        },
        async (request, reply): Promise<CreateSessionResponse | FastifyReply> => {
            try {
                const handle = await sessionRegistry.createSession(request.body.cwd);
                return reply.code(201).send({ session: handle.summarize() });
            } catch (error) {
                if (error instanceof SessionRegistryError) {
                    return sendRegistryError(reply, error);
                }
                request.log.error({ err: error }, "failed to create session");
                return sendApiError(reply, 500, "internal_error", "Internal server error.");
            }
        },
    );

    app.get<{ Params: { id: string } }>(
        "/api/sessions/:id",
        async (request, reply): Promise<SessionDetailResponse | FastifyReply> => {
            const { id } = request.params;
            if (!isValidSessionId(id)) {
                return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
            }
            const detail = await sessionRegistry.getById(id);
            if (detail === null) {
                return sendApiError(reply, 404, "not_found", "Session not found.");
            }
            return detail;
        },
    );

    app.post<{ Params: { id: string } }>(
        "/api/sessions/:id/close",
        async (request, reply): Promise<CloseSessionResponse | FastifyReply> => {
            const { id } = request.params;
            if (!isValidSessionId(id)) {
                return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
            }
            const closed = await sessionRegistry.closeSession(id);
            return { closed };
        },
    );

    // The WebSocket routes must live in a plugin that boots after `@fastify/websocket`: that
    // plugin installs its `onRoute` hook during boot, and only routes registered afterwards are
    // turned into WebSocket handlers.
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
                    socket.close(WS_CLOSE_INTERNAL_ERROR, "Session unavailable");
                    return;
                }

                const afterSeq = parseAfterSeq(request.query.afterSeq);
                if (afterSeq === null) {
                    socket.close(WS_CLOSE_INTERNAL_ERROR, "Invalid afterSeq");
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
                            closeSocket(WS_CLOSE_SLOW_CONSUMER, "Slow consumer");
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
                        client.close?.(WS_CLOSE_SESSION_NOT_FOUND, "Session not found");
                        return;
                    }
                    request.log.warn({ err: error, sessionId: handle.sessionId }, "failed to attach websocket client");
                    sendProtocolError("internal_error", "Failed to attach session.");
                    client.close?.(WS_CLOSE_INTERNAL_ERROR, "Session unavailable");
                    return;
                }

                for (const command of bufferedCommands.splice(0)) {
                    dispatchCommand(command);
                }
            },
        );
        done();
    });

    return app;
}
