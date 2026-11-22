import {
    isRecord,
    parseSessionId,
    type CatalogCursor,
    type SessionId,
    type SessionSummary,
    type SessionSummaryPatch,
    type WorkspaceWsCatalogEvent,
} from "@pivia/protocol";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import type { SessionCacheStore } from "@/lib/cache/session-cache";
import { Log } from "@/lib/log";

import {
    applyCatalogEvent as applyCatalogEventToSessions,
    canApplyCatalogEvent,
    canApplyCatalogSnapshot,
    patchSession,
    removeSession,
    upsertSession,
    type CatalogSyncPhase,
} from "./model";

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
    /** Server epoch and sequence cursor of the latest applied snapshot or catalog event. */
    readonly catalogCursor: CatalogCursor | null;
    readonly sync: CatalogSyncPhase;
    readonly query: string;
    readonly selectedId: SessionId | null;
    /** Pinned session ids; only this field persists across reloads. */
    readonly pins: readonly SessionId[];
    /** Working directories whose rows are hidden. */
    readonly collapsed: readonly string[];
}

/** Subset of {@link SessionCacheStore} required by the workspace catalog store. */
export type WorkspaceCatalogCache = Pick<SessionCacheStore, "getWorkspaceCatalog" | "putWorkspaceCatalog">;

/** Dependencies injected when creating a workspace store instance. */
export interface WorkspaceStoreOptions {
    readonly cache?: WorkspaceCatalogCache | undefined;
}

/** What a caller may change in the workspace store. */
export interface WorkspaceActions {
    /** Hydrate stale-while-revalidate catalog rows from IndexedDB before the first sync finishes. */
    hydrateCatalog: () => Promise<void>;
    beginSync: () => void;
    applyCatalog: (sessions: readonly SessionSummary[], updatedAtMs: number, cursor: CatalogCursor) => void;
    applyCatalogEvent: (event: WorkspaceWsCatalogEvent) => void;
    markReconnecting: (attempt: number) => void;
    failSync: (message: string) => void;
    setQuery: (query: string) => void;
    select: (id: SessionId | null) => void;
    togglePinned: (id: SessionId) => void;
    toggleFolder: (cwd: string) => void;
    upsertSession: (session: SessionSummary) => void;
    patchSession: (id: SessionId, patch: SessionSummaryPatch) => void;
    removeSession: (id: SessionId) => void;
    /** Drops connection-scoped state but keeps the pins the user set. */
    reset: () => void;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

export const initialWorkspaceState: WorkspaceState = {
    sessions: [],
    updatedAtMs: null,
    catalogCursor: null,
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
 * Pins persist in localStorage. When `options.cache` is provided, `applyCatalog` writes the catalog
 * to IndexedDB and `hydrateCatalog` loads it before the first live sync completes. Without `cache`,
 * catalog persistence is disabled and a warning is logged once.
 */
export function createWorkspaceStore(options: WorkspaceStoreOptions = {}) {
    let warnedMissingCache = false;
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
                    const cached = await cache.getWorkspaceCatalog();
                    if (cached === null) {
                        return;
                    }
                    const current = get();
                    if (current.sync.kind !== "idle" || current.updatedAtMs !== null) {
                        return;
                    }
                    set({
                        sessions: cached.sessions,
                        updatedAtMs: cached.scannedAtMs,
                    });
                },
                beginSync: () =>
                    set((state) =>
                        state.sync.kind === "syncing"
                            ? state
                            : {
                                  // The rows stay in place while the refresh runs so a failed sync keeps them visible.
                                  sync: { kind: "syncing" },
                              },
                    ),
                applyCatalog: (sessions, updatedAtMs, cursor) => {
                    const current = get();
                    if (!canApplyCatalogSnapshot(current.catalogCursor, cursor)) {
                        return;
                    }
                    const cache = resolveCache();
                    set((state) => {
                        if (!canApplyCatalogSnapshot(state.catalogCursor, cursor)) {
                            return state;
                        }
                        if (cache !== undefined) {
                            void cache.putWorkspaceCatalog(sessions, updatedAtMs);
                        }
                        const ids = new Set(sessions.map((session) => session.id));
                        return {
                            sessions,
                            updatedAtMs,
                            catalogCursor: cursor,
                            sync: { kind: "live" },
                            // A pin for a session the complete catalog did not see belongs to a deleted session.
                            pins: state.pins.filter((id) => ids.has(id)),
                            selectedId:
                                state.selectedId !== null && ids.has(state.selectedId) ? state.selectedId : null,
                        };
                    });
                },
                applyCatalogEvent: (event) =>
                    set((state) => {
                        const incomingCursor: CatalogCursor = { epoch: event.catalogEpoch, seq: event.seq };
                        if (!canApplyCatalogEvent(state.catalogCursor, incomingCursor)) {
                            return state;
                        }
                        const nextSessions = applyCatalogEventToSessions(state.sessions, event);
                        if (event.type === "session_removed") {
                            return {
                                sessions: nextSessions,
                                catalogCursor: incomingCursor,
                                pins: state.pins.filter((pinned) => pinned !== event.sessionId),
                                selectedId: state.selectedId === event.sessionId ? null : state.selectedId,
                            };
                        }
                        if (nextSessions === state.sessions) {
                            return { catalogCursor: incomingCursor };
                        }
                        return {
                            sessions: nextSessions,
                            catalogCursor: incomingCursor,
                        };
                    }),
                markReconnecting: (attempt) =>
                    set({
                        sync: { kind: "reconnecting", attempt },
                    }),
                failSync: (message) =>
                    set({
                        // The last rows and their timestamp stay, marked with the failure.
                        sync: { kind: "failed", message },
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
                upsertSession: (session) =>
                    set((state) => {
                        const next = upsertSession(state.sessions, session);
                        return next === state.sessions ? state : { sessions: next };
                    }),
                patchSession: (id, patch) =>
                    set((state) => {
                        const next = patchSession(state.sessions, id, patch);
                        return next === state.sessions ? state : { sessions: next };
                    }),
                removeSession: (id) =>
                    set((state) => ({
                        sessions: removeSession(state.sessions, id),
                        pins: state.pins.filter((pinned) => pinned !== id),
                        selectedId: state.selectedId === id ? null : state.selectedId,
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
