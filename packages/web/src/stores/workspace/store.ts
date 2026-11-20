import type { SessionListResponse, SessionSummary } from "@pivia/protocol";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { sessionCache, type SessionCacheStore } from "@/lib/cache/session-cache";

import { removeSession, upsertSession, type ScanPhase } from "./model";

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
    /** Sessions from the last complete scan, in server order. */
    readonly sessions: readonly SessionSummary[];
    /** Time the server finished the last scan, in Unix epoch milliseconds. */
    readonly scannedAtMs: number | null;
    readonly scan: ScanPhase;
    readonly query: string;
    readonly selectedId: string | null;
    /** Pinned session ids; only this field persists across reloads. */
    readonly pins: readonly string[];
    /** Working directories whose rows are hidden. */
    readonly collapsed: readonly string[];
}

/** What a caller may change in the workspace store. */
export interface WorkspaceActions {
    /** Hydrate stale-while-revalidate catalog rows from IndexedDB before the first scan finishes. */
    hydrateCatalog: (cache: SessionCacheStore) => Promise<void>;
    beginScan: (manual: boolean) => void;
    applyScan: (result: SessionListResponse) => void;
    failScan: (message: string) => void;
    setQuery: (query: string) => void;
    select: (id: string | null) => void;
    togglePinned: (id: string) => void;
    toggleFolder: (cwd: string) => void;
    upsertSession: (session: SessionSummary) => void;
    removeSession: (id: string) => void;
    /** Drops connection-scoped state but keeps the pins the user set. */
    reset: () => void;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

export const initialWorkspaceState: WorkspaceState = {
    sessions: [],
    scannedAtMs: null,
    scan: { kind: "idle" },
    query: "",
    selectedId: null,
    pins: [],
    collapsed: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the persisted pins and drops every value a previous version could not have written.
 *
 * localStorage is outside the type system, so a hand edit or an interrupted write can leave
 * anything there. A malformed entry reads as no pins instead of throwing while the list hydrates.
 */
function persistedPins(persisted: unknown): readonly string[] {
    if (!isRecord(persisted)) {
        return [];
    }
    const stored = persisted["pins"];
    if (!Array.isArray(stored)) {
        return [];
    }
    const pins: string[] = [];
    for (const entry of stored) {
        if (typeof entry === "string" && !pins.includes(entry)) {
            pins.push(entry);
        }
    }
    return pins;
}

/**
 * The session catalog of the single host.
 *
 * Pins persist in localStorage. The session list is a stale-while-revalidate snapshot: `applyScan`
 * stores it in the IndexedDB cache and a view may call `hydrateCatalog` before this page scans, so
 * every real scan still replaces it.
 */
export const useWorkspaceStore = create<WorkspaceStore>()(
    persist(
        (set, get) => ({
            ...initialWorkspaceState,
            hydrateCatalog: async (cache) => {
                const cached = await cache.getWorkspaceCatalog();
                if (cached === null) {
                    return;
                }
                const current = get();
                if (current.scan.kind !== "idle" || current.scannedAtMs !== null) {
                    return;
                }
                set({
                    sessions: cached.sessions,
                    scannedAtMs: cached.scannedAtMs,
                });
            },
            beginScan: (manual) =>
                set((state) =>
                    state.scan.kind === "scanning"
                        ? state
                        : {
                              // The rows stay in place: a manual scan draws its skeleton from the phase,
                              // and a failed scan leaves the last rows visible.
                              scan: { kind: "scanning", manual },
                          },
                ),
            applyScan: (result) => {
                void sessionCache.putWorkspaceCatalog(result.sessions, result.scannedAtMs);
                set((state) => {
                    const ids = new Set(result.sessions.map((session) => session.id));
                    return {
                        sessions: result.sessions,
                        scannedAtMs: result.scannedAtMs,
                        scan: { kind: "ready" },
                        // A pin for a session the complete scan did not see belongs to a deleted session.
                        pins: state.pins.filter((id) => ids.has(id)),
                        selectedId: state.selectedId !== null && ids.has(state.selectedId) ? state.selectedId : null,
                    };
                });
            },
            failScan: (message) =>
                set({
                    // The last rows and their timestamp stay, marked with the failure.
                    scan: { kind: "failed", message },
                }),
            setQuery: (query) => set({ query }),
            select: (selectedId) => set({ selectedId }),
            togglePinned: (id) =>
                set((state) => ({
                    pins: state.pins.includes(id) ? state.pins.filter((pinned) => pinned !== id) : [id, ...state.pins],
                })),
            toggleFolder: (cwd) =>
                set((state) => ({
                    collapsed: state.collapsed.includes(cwd)
                        ? state.collapsed.filter((collapsed) => collapsed !== cwd)
                        : [...state.collapsed, cwd],
                })),
            upsertSession: (session) =>
                set((state) => ({
                    sessions: upsertSession(state.sessions, session),
                })),
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
