import { appCache, type AppCache } from "@/lib/cache";
import { apiClient as defaultApiClient, type ApiClient, type WebSocketConstructor } from "@/lib/transport";

import { createAuthStore } from "./auth";
import { createSessionPool, type SessionPool } from "./session";
import { createWorkspaceStore } from "./workspace";

/** Dependencies required to compose and wire the application stores. */
export interface AppStoresOptions {
    readonly apiClient?: ApiClient | undefined;
    readonly cache?: AppCache | undefined;
    readonly WebSocket?: WebSocketConstructor | undefined;
    readonly maxBackgroundSessions?: number | undefined;
}

/**
 * Create and wire the workspace, session pool, and auth stores as one isolated graph.
 *
 * Cross-store reactions (clearing session memory on logout or 401, removing missing sessions from
 * the workspace catalog, and dropping auth state on 401 HTTP responses) are bound here rather than
 * at module import time inside individual store modules. Replaces the injected `apiClient`'s
 * unauthorized handler and returns `dispose()` to detach that handler and close pooled sockets.
 */
export function createAppStores(options: AppStoresOptions = {}) {
    const client = options.apiClient ?? defaultApiClient;
    const cache = options.cache ?? appCache;

    const useWorkspaceStore = createWorkspaceStore({ cache: cache.catalog });

    const sessionPool: SessionPool = createSessionPool({
        cache: cache.sessions,
        apiClient: client,
        ...(options.WebSocket === undefined ? {} : { WebSocket: options.WebSocket }),
        ...(options.maxBackgroundSessions === undefined
            ? {}
            : { maxBackgroundSessions: options.maxBackgroundSessions }),
        onSessionMissing: (sessionId) => {
            useWorkspaceStore.getState().applyCatalogDelta({ op: "remove", id: sessionId });
        },
    });

    const useAuthStore = createAuthStore(client, {
        cache,
        onClearSessionMemory: () => {
            sessionPool.clearAll();
        },
    });

    const detachUnauthorized = client.setUnauthorizedHandler(() => {
        useAuthStore.getState().markUnauthorized();
    });

    return {
        useWorkspaceStore,
        sessionPool,
        useAuthStore,
        dispose: () => {
            detachUnauthorized();
            sessionPool.dispose();
        },
    };
}

export const { useWorkspaceStore, sessionPool, useAuthStore } = createAppStores();
