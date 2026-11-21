import {
    PUBLIC_API_PATHS,
    assertNever,
    type ApiErrorCode,
    type AuthLoginRequest,
    type AuthLoginResponse,
    type AuthLogoutResponse,
    type AuthStatusResponse,
} from "@pivia/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendApiError, sendWsUpgradeError } from "../http/errors.ts";
import { type AuthService, SESSION_COOKIE_NAME } from "./service.ts";

const PUBLIC_PATHS: ReadonlySet<string> = new Set(PUBLIC_API_PATHS);

const LOGIN_BODY_SCHEMA = {
    type: "object",
    required: ["password"],
    additionalProperties: false,
    properties: {
        password: { type: "string", minLength: 1 },
    },
} as const;

function stripQuery(url: string): string {
    const qIndex = url.indexOf("?");
    return qIndex === -1 ? url : url.slice(0, qIndex);
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
        return sendWsUpgradeError(reply, statusCode, error, message);
    }
    return sendApiError(reply, statusCode, error, message);
}

/** Register authentication request guards and `/api/auth*` endpoints. */
export function registerAuthRoutes(app: FastifyInstance, authService: AuthService): void {
    app.addHook("onRequest", async (request, reply) => {
        const pathname = stripQuery(request.url);
        if (!pathname.startsWith("/api/") && !pathname.startsWith("/ws/")) {
            return;
        }
        if (PUBLIC_PATHS.has(pathname)) {
            return;
        }

        const result = authService.authenticateRequest(request, request.ip);
        if (result.authenticated) {
            return;
        }

        switch (result.reason) {
            case "rate_limited":
                request.log.warn({ clientIp: request.ip, pathname }, "authentication rate-limited");
                reply.header("Retry-After", String(result.retryAfterSeconds));
                return sendAuthError(
                    pathname,
                    reply,
                    429,
                    "rate_limited",
                    "Too many failed authentication attempts. Try again later.",
                );
            case "invalid_bearer":
                request.log.warn({ clientIp: request.ip, pathname }, "invalid bearer credential");
                return sendAuthError(pathname, reply, 401, "unauthorized", "Authentication required.");
            case "unauthenticated":
                return sendAuthError(pathname, reply, 401, "unauthorized", "Authentication required.");
            default:
                return assertNever(result);
        }
    });

    app.get("/api/auth/status", (request, reply): AuthStatusResponse | FastifyReply => {
        if (!authService.authRequired) {
            return { authRequired: false, authenticated: true };
        }
        const result = authService.authenticateRequest(request, request.ip);
        if (result.authenticated) {
            return { authRequired: true, authenticated: true };
        }
        switch (result.reason) {
            case "rate_limited":
                request.log.warn({ clientIp: request.ip, pathname: "/api/auth/status" }, "authentication rate-limited");
                reply.header("Retry-After", String(result.retryAfterSeconds));
                return sendApiError(
                    reply,
                    429,
                    "rate_limited",
                    "Too many failed authentication attempts. Try again later.",
                );
            case "invalid_bearer":
                request.log.warn({ clientIp: request.ip, pathname: "/api/auth/status" }, "invalid bearer credential");
                return { authRequired: true, authenticated: false };
            case "unauthenticated":
                return { authRequired: true, authenticated: false };
            default:
                return assertNever(result);
        }
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

            authService.setSessionCookie(reply, attempt.token);
            return { authenticated: true };
        },
    );

    app.post("/api/auth/logout", (request, reply): AuthLogoutResponse => {
        authService.logout(request.cookies[SESSION_COOKIE_NAME]);
        authService.clearSessionCookie(reply);
        return { authenticated: false };
    });
}
