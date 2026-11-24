import { isRecord, parseSessionId, type CatalogDelta, type SessionId, type SessionSummary } from "@pivia/protocol";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import type { WorkspaceCatalogCache } from "@/lib/cache";
import { Log } from "@/lib/log";

import { createCatalogSyncReducer, type CatalogSyncPhase } from "./model";

export type { WorkspaceCatalogCache } from "@/lib/cache";

/** One in-memory storage so a browser context that denies localStorage still runs. */
const FALLBACK_STORAGE = new Map<string, string>();

type SyncStateStorage = {
    getItem: (name: string) => string | null;
    setItem: (name: string, value: string) => void;
    removeItem: (name: string) => void;
};

const fallbackStateStorage: SyncStateStorage = {
    getItem: (name) => FALLBACK_STORAGE.get(name) ?? null,
    setItem: (name, value) => {
        FALLBACK_STORAGE.set(name, value);
    },
    removeItem: (name) => {
        FALLBACK_STORAGE.delete(name);
    },
};

/**
 * Zustand persist writes after every state update, even when `partialize` selected the same pins.
 * Keep the last serialized value so search, selection and folder changes do not touch storage.
 */
function skipUnchangedWrites(storage: SyncStateStorage): StateStorage {
    let lastValue: string | null | undefined;

    return {
        getItem: (name) => {
            const value = storage.getItem(name);
            lastValue = value;
            return value;
        },
        setItem: (name, value) => {
            if (lastValue === undefined) {
                lastValue = storage.getItem(name);
            }
            if (lastValue === value) {
                return;
            }
            lastValue = value;
            storage.setItem(name, value);
        },
        removeItem: (name) => {
            lastValue = null;
            storage.removeItem(name);
        },
    };
}

function persistedStorage(): StateStorage {
    try {
        if (typeof localStorage !== "undefined") {
            return skipUnchangedWrites(localStorage);
        }
    } catch {
        // Access to localStorage can throw when storage is blocked; the fallback keeps the store working.
    }
    return skipUnchangedWrites(fallbackStateStorage);
}

/** What the workspace remembers about the single host. */
export interface WorkspaceState {
    /** Sessions from the last complete catalog snapshot or HTTP refresh, in server order. */
    readonly sessions: readonly SessionSummary[];
    /** Time the server produced the last catalog snapshot, in Unix epoch milliseconds. */
    readonly updatedAtMs: number | null;
    readonly sync: CatalogSyncPhase;
    readonly query: string;
    readonly selectedId: SessionId | null;
    /** Pinned session ids; only this field persists across reloads. */
    readonly pins: readonly SessionId[];
    /** Working directories whose rows are hidden. */
    readonly collapsed: readonly string[];
}

/** Dependencies injected when creating a workspace store instance. */
export interface WorkspaceStoreOptions {
    readonly cache?: WorkspaceCatalogCache | undefined;
}

/** Synced catalog snapshot/delta projection committed into {@link WorkspaceStore}. */
export interface CommitSyncedCatalogInput {
    readonly sessions: readonly SessionSummary[];
    readonly updatedAtMs: number | null;
    readonly sync?: CatalogSyncPhase | undefined;
    readonly persistCache?: boolean | undefined;
}

/** What a caller may change in the workspace store. */
export interface WorkspaceActions {
    /** Hydrate stale-while-revalidate catalog rows from IndexedDB before the first sync finishes. */
    hydrateCatalog: () => Promise<void>;
    /** Commit catalog rows and cursor produced by `SyncStreamClient` (pruning pins/selection and optionally caching). */
    commitSyncedCatalog: (input: CommitSyncedCatalogInput) => void;
    setSync: (sync: CatalogSyncPhase) => void;
    /** Apply one local optimistic/eviction {@link CatalogDelta} using {@link createCatalogSyncReducer}. */
    applyCatalogDelta: (delta: CatalogDelta) => void;
    setQuery: (query: string) => void;
    select: (id: SessionId | null) => void;
    togglePinned: (id: SessionId) => void;
    toggleFolder: (cwd: string) => void;
    /** Drops connection-scoped state but keeps the pins the user set. */
    reset: () => void;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

export const initialWorkspaceState: WorkspaceState = {
    sessions: [],
    updatedAtMs: null,
    sync: { kind: "idle" },
    query: "",
    selectedId: null,
    pins: [],
    collapsed: [],
};

/**
 * Reads the persisted pins and drops every value a previous version could not have written.
 *
 * localStorage is outside the type system, so a hand edit or an interrupted write can leave
 * anything there. A malformed entry reads as no pins instead of throwing while the list hydrates.
 */
function persistedPins(persisted: unknown): readonly SessionId[] {
    if (!isRecord(persisted)) {
        return [];
    }
    const stored = persisted["pins"];
    if (!Array.isArray(stored)) {
        return [];
    }
    const pins: SessionId[] = [];
    for (const entry of stored) {
        const parsed = parseSessionId(entry);
        if (parsed !== null && !pins.includes(parsed)) {
            pins.push(parsed);
        }
    }
    return pins;
}

/**
 * Creates the session catalog store of the single host.
 *
 * Pins persist in localStorage. When `options.cache` is provided, `commitSyncedCatalog` writes
 * snapshots to IndexedDB and `hydrateCatalog` loads stale rows before the first live sync
 * completes. Without `cache`, catalog persistence is disabled and a warning is logged once.
 */
export function createWorkspaceStore(options: WorkspaceStoreOptions = {}) {
    let warnedMissingCache = false;
    const catalogReducer = createCatalogSyncReducer();
    const resolveCache = (): WorkspaceCatalogCache | undefined => {
        if (options.cache === undefined && !warnedMissingCache) {
            warnedMissingCache = true;
            Log.warn("Workspace store has no catalog cache configured; IndexedDB catalog persistence is disabled");
        }
        return options.cache;
    };

    return create<WorkspaceStore>()(
        persist(
            (set, get) => ({
                ...initialWorkspaceState,
                hydrateCatalog: async () => {
                    const cache = resolveCache();
                    if (cache === undefined) {
                        return;
                    }
                    let cached;
                    try {
                        cached = await cache.get();
                    } catch (error) {
                        Log.warn("Failed to hydrate workspace catalog cache", error);
                        return;
                    }
                    if (cached === null) {
                        return;
                    }
                    const current = get();
                    if (current.sync.kind !== "idle" || current.updatedAtMs !== null) {
                        return;
                    }
                    set({
                        sessions: cached.sessions,
                        updatedAtMs: cached.updatedAtMs,
                    });
                },
                commitSyncedCatalog: ({ sessions, updatedAtMs, sync, persistCache }) => {
                    const cache = persistCache ? resolveCache() : undefined;
                    set((state) => {
                        const ids = new Set(sessions.map((session) => session.id));
                        return {
                            sessions,
                            updatedAtMs,
                            ...(sync === undefined ? {} : { sync }),
                            // A pin for a session the complete catalog did not see belongs to a deleted session.
                            pins: state.pins.filter((id) => ids.has(id)),
                            selectedId:
                                state.selectedId !== null && ids.has(state.selectedId) ? state.selectedId : null,
                        };
                    });
                    if (cache !== undefined && updatedAtMs !== null) {
                        void cache.put({ sessions, updatedAtMs }).catch((error: unknown) => {
                            Log.warn("Failed to persist workspace catalog cache", error);
                        });
                    }
                },
                setSync: (sync) =>
                    set((state) => {
                        if (sync.kind === "syncing" && state.sync.kind === "syncing") {
                            return state;
                        }
                        return { sync };
                    }),
                applyCatalogDelta: (delta) =>
                    set((state) => {
                        const reduced = catalogReducer.applyDelta(
                            { sessions: state.sessions, updatedAtMs: state.updatedAtMs },
                            delta,
                        );
                        if (delta.op === "remove") {
                            return {
                                sessions: reduced.sessions,
                                pins: state.pins.filter((pinned) => pinned !== delta.id),
                                selectedId: state.selectedId === delta.id ? null : state.selectedId,
                            };
                        }
                        return reduced.sessions === state.sessions ? state : { sessions: reduced.sessions };
                    }),
                setQuery: (query) => set({ query }),
                select: (selectedId) => set({ selectedId }),
                togglePinned: (id) =>
                    set((state) => ({
                        pins: state.pins.includes(id)
                            ? state.pins.filter((pinned) => pinned !== id)
                            : [id, ...state.pins],
                    })),
                toggleFolder: (cwd) =>
                    set((state) => ({
                        collapsed: state.collapsed.includes(cwd)
                            ? state.collapsed.filter((collapsed) => collapsed !== cwd)
                            : [...state.collapsed, cwd],
                    })),
                reset: () =>
                    set((state) => ({
                        ...initialWorkspaceState,
                        // Pins follow the user, not the connection that happened to be open.
                        pins: state.pins,
                    })),
            }),
            {
                name: "pivia.workspace.v1",
                version: 1,
                storage: createJSONStorage(() => persistedStorage()),
                partialize: ({ pins }) => ({ pins }),
                merge: (persisted, current) => ({ ...current, pins: persistedPins(persisted) }),
            },
        ),
    );
}
