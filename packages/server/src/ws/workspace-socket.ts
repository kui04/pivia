import { SESSION_CLOSE_CODE, type CatalogSeq, type WorkspaceWsServerMessage } from "@pivia/protocol";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";

import type { SessionRegistry } from "../sessions/runtime.ts";
import { createHeartbeat } from "./heartbeat.ts";
import {
    DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
    MAX_WS_BUFFERED_BYTES,
    type SessionSocketRouteOptions,
} from "./session-socket.ts";

/** `ws` readyState value for an open connection. */
const WS_READY_STATE_OPEN = 1;

interface BufferedCatalogEvent {
    readonly seq: CatalogSeq;
    readonly raw: string;
}

interface WorkspaceSocketClient {
    closed: boolean;
    snapshotSent: boolean;
    readonly pendingEvents: BufferedCatalogEvent[];
    readonly sendRaw: (raw: string) => void;
    readonly closeSocket: (code: number, reason: string) => void;
}

/**
 * Register the `/ws/workspace` WebSocket route.
 *
 * Streams an initial `catalog_snapshot` followed by live `session_upserted`, `session_updated`, and
 * `session_removed` events from a single route-level {@link SessionRegistry.subscribeCatalog}
 * subscription. Each incremental event is serialized once per broadcast and buffered per client
 * until its initial snapshot is sent so no transition between snapshot start and completion is
 * lost.
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

    const clients = new Set<WorkspaceSocketClient>();
    let unsubscribeCatalog: (() => void) | null = null;

    const releaseSubscriptionIfUnused = (): void => {
        if (clients.size === 0 && unsubscribeCatalog !== null) {
            unsubscribeCatalog();
            unsubscribeCatalog = null;
        }
    };

    const ensureCatalogSubscription = (): void => {
        if (unsubscribeCatalog !== null) {
            return;
        }
        unsubscribeCatalog = sessionRegistry.subscribeCatalog((event) => {
            if (clients.size === 0) {
                return;
            }
            const raw = JSON.stringify(event);
            for (const client of [...clients]) {
                if (client.closed) {
                    continue;
                }
                if (!client.snapshotSent) {
                    client.pendingEvents.push({ seq: event.seq, raw });
                    continue;
                }
                client.sendRaw(raw);
            }
        });
    };

    app.addHook("onClose", () => {
        heartbeat.dispose();
        if (unsubscribeCatalog !== null) {
            unsubscribeCatalog();
            unsubscribeCatalog = null;
        }
        clients.clear();
    });

    app.register((instance, _options, done) => {
        instance.get("/ws/workspace", { websocket: true }, (socket, request) => {
            const log: FastifyBaseLogger = request.log;

            const cleanupClient = (): void => {
                if (client.closed) {
                    return;
                }
                client.closed = true;
                client.pendingEvents.length = 0;
                clients.delete(client);
                releaseSubscriptionIfUnused();
            };

            const closeSocket = (code: number, reason: string): void => {
                if (client.closed) {
                    return;
                }
                cleanupClient();
                try {
                    socket.close(code, reason);
                } catch (error) {
                    log.warn({ err: error }, "failed to close workspace websocket");
                }
            };

            const sendRaw = (raw: string): void => {
                if (client.closed || socket.readyState !== WS_READY_STATE_OPEN) {
                    return;
                }
                if (socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
                    log.warn({ bufferedAmount: socket.bufferedAmount }, "closing slow workspace websocket consumer");
                    closeSocket(SESSION_CLOSE_CODE.slowConsumer, "Slow consumer");
                    return;
                }
                try {
                    socket.send(raw);
                } catch (error) {
                    log.warn({ err: error }, "failed to send workspace websocket message");
                }
            };

            const client: WorkspaceSocketClient = {
                closed: false,
                snapshotSent: false,
                pendingEvents: [],
                sendRaw,
                closeSocket,
            };

            // Subscribe before reading the snapshot so transitions during list() are buffered.
            clients.add(client);
            ensureCatalogSubscription();

            heartbeat.track(socket);
            socket.on("pong", () => {
                heartbeat.markAlive(socket);
            });
            socket.on("close", () => {
                cleanupClient();
                heartbeat.untrack(socket);
            });
            socket.on("error", (error: Error) => {
                log.warn({ err: error }, "workspace websocket connection error");
            });

            void sessionRegistry
                .list()
                .then((list) => {
                    if (client.closed) {
                        return;
                    }
                    const snapshot: WorkspaceWsServerMessage = {
                        type: "catalog_snapshot",
                        sessions: list.sessions,
                        updatedAtMs: list.scannedAtMs,
                        catalogEpoch: list.catalogEpoch,
                        catalogSeq: list.catalogSeq,
                    };
                    sendRaw(JSON.stringify(snapshot));
                    client.snapshotSent = true;
                    for (const item of client.pendingEvents) {
                        if (client.closed) {
                            break;
                        }
                        if (item.seq <= list.catalogSeq) {
                            continue;
                        }
                        sendRaw(item.raw);
                    }
                    client.pendingEvents.length = 0;
                })
                .catch((error: unknown) => {
                    log.error({ err: error }, "failed to load workspace catalog snapshot");
                    closeSocket(SESSION_CLOSE_CODE.internalError, "Catalog unavailable");
                });
        });

        done();
    });
}
