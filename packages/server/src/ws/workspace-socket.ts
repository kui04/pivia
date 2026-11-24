import { WS_ENDPOINTS } from "@pivia/protocol";
import type { FastifyInstance } from "fastify";

import type { SessionRegistry } from "../sessions/runtime.ts";
import { createBackpressureSender } from "../sync/index.ts";
import { createHeartbeat } from "./heartbeat.ts";
import { DEFAULT_WS_HEARTBEAT_INTERVAL_MS, type SessionSocketRouteOptions } from "./session-socket.ts";

/**
 * Register the `/ws/workspace` WebSocket route.
 *
 * Streams `SyncFrame<'catalog', CatalogSnapshot, CatalogDelta>` messages through
 * {@link SessionRegistry.attachCatalog}, supporting Tier 1 replay on `?epoch=...&afterSeq=...`
 * reconnects and async snapshot watermark draining on cold connects.
 */
export function registerWorkspaceSocketRoute(
    app: FastifyInstance,
    sessionRegistry: SessionRegistry,
    options: SessionSocketRouteOptions = {},
): void {
    const heartbeat = createHeartbeat({
        intervalMs: options.heartbeatIntervalMs ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
        onStale() {
            app.log.warn("terminating unresponsive workspace websocket");
        },
        onError(error) {
            app.log.warn({ err: error }, "workspace websocket heartbeat failed");
        },
    });

    app.addHook("onClose", () => {
        heartbeat.dispose();
    });

    app.register((instance, _options, done) => {
        instance.get(WS_ENDPOINTS.workspace.pattern, { websocket: true }, (socket, request) => {
            const handshake = WS_ENDPOINTS.workspace.parseQuery(request.query);
            let detach: () => void = () => {};
            const sender = createBackpressureSender(socket, request.log, {
                onClose: () => {
                    detach();
                },
            });

            heartbeat.track(socket);
            socket.on("pong", () => {
                heartbeat.markAlive(socket);
            });
            socket.on("close", () => {
                detach();
                heartbeat.untrack(socket);
            });
            socket.on("error", (error: Error) => {
                request.log.warn({ err: error }, "workspace websocket connection error");
            });

            detach = sessionRegistry.attachCatalog(sender, handshake);
        });

        done();
    });
}
