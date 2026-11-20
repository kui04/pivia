import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { HealthResponse } from "@pivia/protocol";

import { registerAuthRoutes } from "./auth/routes.ts";
import { AuthService, type AuthServiceOptions } from "./auth/service.ts";
import { sendApiError } from "./http/errors.ts";
import { createLogger } from "./logger.ts";
import { SessionCatalog } from "./sessions/catalog.ts";
import { registerSessionRoutes } from "./sessions/routes.ts";
import { SessionRegistry } from "./sessions/runtime.ts";
import { MAX_WS_PAYLOAD_BYTES, registerSessionSocketRoute } from "./ws/session-socket.ts";

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

    // Enable compression only on explicitly opted-in session routes (`{ compress: {} }`) so auth
    // endpoints, small error envelopes, and WebSocket upgrades stay untouched.
    app.register(compress, { global: false });

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

    app.get("/api/health", (): HealthResponse => {
        return {
            status: "ok",
            version,
        };
    });

    registerAuthRoutes(app, authService);
    registerSessionRoutes(app, sessionRegistry);
    registerSessionSocketRoute(app, sessionRegistry);

    return app;
}
