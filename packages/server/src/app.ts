import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { HealthResponse } from "@pivia/protocol";

import { createLogger } from "./logger.ts";

/** Options for {@link buildApp}. */
export interface BuildAppOptions {
    /** Application version reported by `/api/health`; defaults to `"0.0.0"`. */
    version?: string | undefined;
    /** Pre-configured logger; defaults to a `stderr` Pino logger. */
    logger?: FastifyBaseLogger | undefined;
}

/**
 * Build and configure the Fastify application without binding a network port.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
    const version = options.version ?? "0.0.0";
    const logger: FastifyBaseLogger = options.logger ?? createLogger();

    const app = Fastify({
        loggerInstance: logger,
    });

    app.get("/api/health", (): HealthResponse => {
        return {
            status: "ok",
            version,
        };
    });

    return app;
}
