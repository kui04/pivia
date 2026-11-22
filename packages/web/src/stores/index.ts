import { sessionCache, type SessionCacheStore } from "@/lib/cache/session-cache";
import { apiClient as defaultApiClient, type ApiClient } from "@/lib/transport/http";
import type { SessionSocketConstructor } from "@/lib/transport/session-socket";

import { createAuthStore } from "./auth/store";
import { createSessionStore } from "./session/store";
import { createWorkspaceStore } from "./workspace/store";

/** Dependencies required to compose and wire the application stores. */
export interface AppStoresOptions {
    readonly apiClient?: ApiClient | undefined;
    readonly cache?: SessionCacheStore | undefined;
    readonly WebSocket?: SessionSocketConstructor | undefined;
}

/**
 * Create and wire the workspace, session, and auth stores as one isolated graph.
 *
 * Cross-store reactions (clearing session memory on logout or 401, removing missing sessions from
 * the workspace catalog, and dropping auth state on 401 HTTP responses) are bound here rather than
 * at module import time inside individual store modules. Replaces the injected `apiClient`'s
 * unauthorized handler and returns `dispose()` to detach that handler when it is still active.
 */
export function createAppStores(options: AppStoresOptions = {}) {
    const client = options.apiClient ?? defaultApiClient;
    const cache = options.cache ?? sessionCache;

    const useWorkspaceStore = createWorkspaceStore({ cache });

    const useSessionStore = createSessionStore({
        cache,
        apiClient: client,
        ...(options.WebSocket === undefined ? {} : { WebSocket: options.WebSocket }),
        onSessionMissing: (sessionId) => {
            useWorkspaceStore.getState().applyCatalogDelta({ op: "remove", id: sessionId });
        },
    });

    const useAuthStore = createAuthStore(client, {
        cache,
        onClearSessionMemory: () => {
            useSessionStore.getState().clearCache();
        },
    });

    const detachUnauthorized = client.setUnauthorizedHandler(() => {
        useAuthStore.getState().markUnauthorized();
    });

    return {
        useWorkspaceStore,
        useSessionStore,
        useAuthStore,
        dispose: detachUnauthorized,
    };
}

export const { useWorkspaceStore, useSessionStore, useAuthStore } = createAppStores();
