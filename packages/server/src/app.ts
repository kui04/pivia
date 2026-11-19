import cookie from "@fastify/cookie";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from "fastify";

import type {
    ApiErrorCode,
    ApiErrorResponse,
    AuthLoginRequest,
    AuthLoginResponse,
    AuthLogoutResponse,
    AuthStatusResponse,
    HealthResponse,
    SessionDetailResponse,
    SessionListResponse,
} from "@pivia/protocol";

import { AuthService, SESSION_COOKIE_NAME, type AuthServiceOptions } from "./auth.ts";
import { createLogger } from "./logger.ts";
import { isValidSessionId, SessionCatalog } from "./sessions.ts";

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
}

const PUBLIC_API_PATHS = new Set(["/api/health", "/api/auth", "/api/auth/status", "/api/auth/logout"]);

const LOGIN_BODY_SCHEMA = {
    type: "object",
    required: ["password"],
    additionalProperties: false,
    properties: {
        password: { type: "string", minLength: 1 },
    },
} as const;

function sendApiError(reply: FastifyReply, statusCode: number, error: ApiErrorCode, message: string): FastifyReply {
    const payload: ApiErrorResponse = { error, message };
    return reply.code(statusCode).send(payload);
}

function stripQuery(url: string): string {
    const qIndex = url.indexOf("?");
    return qIndex === -1 ? url : url.slice(0, qIndex);
}

/**
 * Build and configure the Fastify application without binding a network port.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
    const version = options.version ?? "0.0.0";
    const logger: FastifyBaseLogger = options.logger ?? createLogger();
    const authService = options.auth instanceof AuthService ? options.auth : new AuthService(options.auth);
    const sessionCatalog = options.sessions ?? new SessionCatalog({ logger });

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
            return sendApiError(
                reply,
                429,
                "rate_limited",
                "Too many failed authentication attempts. Try again later.",
            );
        }

        if (result.badBearer) {
            request.log.warn({ clientIp: request.ip, pathname }, "invalid bearer credential");
        }
        return sendApiError(reply, 401, "unauthorized", "Authentication required.");
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
        return sessionCatalog.list();
    });

    app.get<{ Params: { id: string } }>(
        "/api/sessions/:id",
        async (request, reply): Promise<SessionDetailResponse | FastifyReply> => {
            const { id } = request.params;
            if (!isValidSessionId(id)) {
                return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
            }
            const detail = await sessionCatalog.getById(id);
            if (detail === null) {
                return sendApiError(reply, 404, "not_found", "Session not found.");
            }
            return detail;
        },
    );

    return app;
}
