import { parseCatalogSnapshot, type CatalogSnapshot } from "@pivia/protocol";

import { IndexedDbCoordinator, IndexedDbSnapshotCache } from "./idb";
import { IndexedDbSessionCacheSlice } from "./session";
import type { AppCache, AppCacheOptions, SessionCache, WorkspaceCatalogCache } from "./types";

export {
    type AppCache,
    type AppCacheOptions,
    type CachedSessionSnapshot,
    type CacheWriteOutcome,
    type ClearableCache,
    type IndexedDbCoordinatorOptions,
    type SessionCache,
    type SessionCacheBudgetOptions,
    type SessionCacheMeta,
    type SnapshotCache,
    type WorkspaceCatalogCache,
} from "./types";

const DB_NAME = "pivia.cache.v1";
const DB_VERSION = 1;
const STORE_CATALOG = "workspace_catalog";

/**
 * Unified IndexedDB application cache (`pivia.cache.v1`) with graceful in-memory fallback.
 *
 * Composes domain sub-caches (`sessions`, `catalog`) over one shared database coordinator so
 * individual stores depend only on their narrow capability while `clearAll()` atomically wipes
 * every persisted and in-memory slice on sign-out or `401`.
 */
export class IndexedDbAppCache implements AppCache {
    readonly sessions: SessionCache;
    readonly catalog: WorkspaceCatalogCache;

    private readonly coordinator: IndexedDbCoordinator;

    constructor(options: AppCacheOptions = {}) {
        this.coordinator = new IndexedDbCoordinator(DB_NAME, DB_VERSION, options);
        this.sessions = this.coordinator.registerSlice(new IndexedDbSessionCacheSlice(this.coordinator, options));
        this.catalog = this.coordinator.registerSlice(
            new IndexedDbSnapshotCache<CatalogSnapshot>({
                coordinator: this.coordinator,
                storeName: STORE_CATALOG,
                parse: parseCatalogSnapshot,
            }),
        );
    }

    async clearAll(): Promise<void> {
        await this.coordinator.clearAll();
    }
}

/** Shared app-wide client cache backed by IndexedDB with automatic memory fallback. */
export const appCache: AppCache = new IndexedDbAppCache();
