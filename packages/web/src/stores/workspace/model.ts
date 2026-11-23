import {
    assertNever,
    type CatalogDelta,
    type CatalogSnapshot,
    type SessionId,
    type SessionSummary,
    type SessionSummaryPatch,
    type SyncReducer,
} from "@pivia/protocol";

import { createCollectionSyncReducer } from "@/lib/sync";

/** Where workspace catalog synchronization stands. */
export type CatalogSyncPhase =
    | { readonly kind: "idle" }
    | { readonly kind: "syncing" }
    | { readonly kind: "live" }
    | { readonly kind: "reconnecting"; readonly attempt: number }
    | { readonly kind: "failed"; readonly message: string };

/** What a row title is, and whether it shows a name or a first message. */
export interface SessionTitle {
    readonly title: string;
    readonly named: boolean;
}

/** Topbar view of the currently selected session without exposing host file paths. */
export type SelectedSession = Pick<SessionSummary, "id" | "cwd" | "runtimeState" | "attachedClients"> & SessionTitle;

/** Display badge state for an active session runtime. */
export type ActiveSessionBadge = "starting" | "attached" | "streaming" | "compacting" | "closing";

/** Trailing status slot of a {@link SessionRow}: relative age when idle, badge when active. */
export type SessionRowStatus =
    | { readonly kind: "idle"; readonly modifiedAtMs: number }
    | { readonly kind: "active"; readonly state: ActiveSessionBadge; readonly label: string };

/** One session as the workspace list shows it. */
export interface SessionRow extends SelectedSession, Pick<SessionSummary, "modifiedAtMs"> {
    readonly pinned: boolean;
    readonly selected: boolean;
}

/** One working directory and its unpinned sessions. */
export interface FolderSection {
    readonly cwd: string;
    /** The last path segment, or the whole path when it has none. */
    readonly label: string;
    readonly collapsed: boolean;
    readonly sessions: readonly SessionRow[];
}

/** Everything the session list renders. */
export interface WorkspaceModel {
    /** Pinned sessions, newest first. A pinned session does not also appear under its folder. */
    readonly pinned: readonly SessionRow[];
    /** Unpinned sessions grouped by working directory, newest group first. */
    readonly folders: readonly FolderSection[];
    /** How many sessions the scan returned. */
    readonly total: number;
    /** How many sessions match the search. */
    readonly matched: number;
}

/** What {@link buildWorkspaceModel} needs. */
export interface WorkspaceModelInput {
    readonly sessions: readonly SessionSummary[];
    readonly pins: readonly SessionId[];
    readonly query: string;
    readonly selectedId: SessionId | null;
    readonly collapsed: readonly string[];
}

const UNTITLED = "Untitled session";

/** Shows the session name, else the first message, else a placeholder. */
export function sessionTitle(summary: SessionSummary): SessionTitle {
    const name = summary.name?.trim() ?? "";
    if (name !== "") {
        return { title: name, named: true };
    }
    const firstMessage = summary.firstMessage.trim();
    if (firstMessage !== "") {
        return { title: firstMessage, named: false };
    }
    return { title: UNTITLED, named: false };
}

/**
 * Shows what a folder header is: the last path segment, or the whole path when it has none.
 *
 * A filesystem root keeps the separator that its whole path is. Both separators are honoured so a
 * Windows cwd still shows one segment.
 */
export function folderLabel(cwd: string): string {
    const withoutTrailing = cwd.replace(/[\\/]+$/u, "");
    if (withoutTrailing === "") {
        return cwd === "" ? "Unknown directory" : cwd;
    }
    const separator = Math.max(withoutTrailing.lastIndexOf("/"), withoutTrailing.lastIndexOf("\\"));
    return separator === -1 ? withoutTrailing : withoutTrailing.slice(separator + 1);
}

function matchesSearch(summary: SessionSummary, needle: string): boolean {
    return (
        (summary.name?.toLowerCase().includes(needle) ?? false) ||
        summary.firstMessage.toLowerCase().includes(needle) ||
        summary.cwd.toLowerCase().includes(needle)
    );
}

/** Orders sessions newest first, with the id as a stable tiebreak. */
export function compareSessions(a: SessionSummary, b: SessionSummary): number {
    if (a.modifiedAtMs !== b.modifiedAtMs) {
        return b.modifiedAtMs - a.modifiedAtMs;
    }
    if (a.id === b.id) {
        return 0;
    }
    return a.id < b.id ? -1 : 1;
}

/** Returns a new list ordered by {@link compareSessions}. */
export function sortSessions(sessions: readonly SessionSummary[]): readonly SessionSummary[] {
    return [...sessions].sort(compareSessions);
}

function summariesEqual(a: SessionSummary, b: SessionSummary): boolean {
    return (
        a.id === b.id &&
        a.cwd === b.cwd &&
        a.name === b.name &&
        a.firstMessage === b.firstMessage &&
        a.messageCount === b.messageCount &&
        a.createdAtMs === b.createdAtMs &&
        a.modifiedAtMs === b.modifiedAtMs &&
        a.hasParent === b.hasParent &&
        a.runtimeState === b.runtimeState &&
        a.attachedClients === b.attachedClients
    );
}

function patchChangesSession(existing: SessionSummary, patch: SessionSummaryPatch): boolean {
    return (
        (patch.name !== undefined && patch.name !== existing.name) ||
        (patch.firstMessage !== undefined && patch.firstMessage !== existing.firstMessage) ||
        (patch.messageCount !== undefined && patch.messageCount !== existing.messageCount) ||
        (patch.modifiedAtMs !== undefined && patch.modifiedAtMs !== existing.modifiedAtMs) ||
        (patch.runtimeState !== undefined && patch.runtimeState !== existing.runtimeState) ||
        (patch.attachedClients !== undefined && patch.attachedClients !== existing.attachedClients)
    );
}

function applySessionSummaryPatch(existing: SessionSummary, patch: SessionSummaryPatch): SessionSummary {
    return {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.firstMessage !== undefined ? { firstMessage: patch.firstMessage } : {}),
        ...(patch.messageCount !== undefined ? { messageCount: patch.messageCount } : {}),
        ...(patch.modifiedAtMs !== undefined ? { modifiedAtMs: patch.modifiedAtMs } : {}),
        ...(patch.runtimeState !== undefined ? { runtimeState: patch.runtimeState } : {}),
        ...(patch.attachedClients !== undefined ? { attachedClients: patch.attachedClients } : {}),
    };
}

/** Snapshot-derived collection state managed by {@link createCatalogSyncReducer}. */
export interface CatalogSyncState {
    readonly sessions: readonly SessionSummary[];
    readonly updatedAtMs: number | null;
}

/**
 * Create a {@link SyncReducer} for the workspace session catalog built on {@link createCollectionSyncReducer}.
 */
export function createCatalogSyncReducer(): SyncReducer<CatalogSyncState, CatalogSnapshot, CatalogDelta> {
    return createCollectionSyncReducer<
        CatalogSyncState,
        CatalogSnapshot,
        SessionId,
        SessionSummary,
        SessionSummaryPatch
    >({
        getItems: (snapshot) => snapshot.sessions,
        getId: (session) => session.id,
        applyPatch: (existing, patch) =>
            patchChangesSession(existing, patch) ? applySessionSummaryPatch(existing, patch) : existing,
        itemsEqual: summariesEqual,
        fromItems: (prev, sessions, snapshot) => ({
            sessions,
            updatedAtMs: snapshot === undefined ? prev.updatedAtMs : snapshot.updatedAtMs,
        }),
        toItems: (state) => state.sessions,
    });
}

function toRow(summary: SessionSummary, pins: ReadonlySet<SessionId>, selectedId: SessionId | null): SessionRow {
    const { title, named } = sessionTitle(summary);
    return {
        id: summary.id,
        title,
        named,
        cwd: summary.cwd,
        modifiedAtMs: summary.modifiedAtMs,
        runtimeState: summary.runtimeState,
        attachedClients: summary.attachedClients,
        pinned: pins.has(summary.id),
        selected: summary.id === selectedId,
    };
}

/**
 * Builds the pinned rows and the folder sections.
 *
 * A search matches the name, the first-message prefix and the cwd, and it expands every folder so a
 * match never hides inside a collapsed group. Pins only reorder; they never bypass the filter.
 */
export function buildWorkspaceModel(input: WorkspaceModelInput): WorkspaceModel {
    const { sessions, pins, query, selectedId, collapsed } = input;
    const needle = query.trim().toLowerCase();
    const pinnedIds = new Set(pins);

    const matched: { readonly summary: SessionSummary; readonly row: SessionRow }[] = [];
    for (const summary of sessions) {
        if (needle !== "" && !matchesSearch(summary, needle)) {
            continue;
        }
        matched.push({ summary, row: toRow(summary, pinnedIds, selectedId) });
    }

    const pinned = matched
        .filter((entry) => entry.row.pinned)
        .sort((a, b) => compareSessions(a.summary, b.summary))
        .map((entry) => entry.row);

    const grouped = new Map<string, { readonly summary: SessionSummary; readonly row: SessionRow }[]>();
    for (const entry of matched) {
        if (entry.row.pinned) {
            continue;
        }
        const group = grouped.get(entry.summary.cwd);
        if (group === undefined) {
            grouped.set(entry.summary.cwd, [entry]);
        } else {
            group.push(entry);
        }
    }

    const folders: FolderSection[] = [];
    for (const group of grouped.values()) {
        const sorted = [...group].sort((a, b) => compareSessions(a.summary, b.summary));
        const first = sorted[0];
        if (first === undefined) {
            continue;
        }
        folders.push({
            cwd: first.summary.cwd,
            label: folderLabel(first.summary.cwd),
            // A search always expands its matches, so only an empty query applies the collapsed set.
            collapsed: needle === "" && collapsed.includes(first.summary.cwd),
            sessions: sorted.map((entry) => entry.row),
        });
    }
    folders.sort((a, b) => {
        const newestA = a.sessions[0]?.modifiedAtMs ?? 0;
        const newestB = b.sessions[0]?.modifiedAtMs ?? 0;
        if (newestA !== newestB) {
            return newestB - newestA;
        }
        return a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0;
    });

    return {
        pinned,
        folders,
        total: sessions.length,
        matched: matched.length,
    };
}

/** Derives the selected session header view from the catalog, or returns `null` when missing. */
export function selectedSession(
    sessions: readonly SessionSummary[],
    selectedId: SessionId | null,
): SelectedSession | null {
    if (selectedId === null) {
        return null;
    }
    const found = sessions.find((candidate) => candidate.id === selectedId);
    if (found === undefined) {
        return null;
    }
    const { title, named } = sessionTitle(found);
    return {
        id: found.id,
        title,
        named,
        cwd: found.cwd,
        runtimeState: found.runtimeState,
        attachedClients: found.attachedClients,
    };
}

/** Maps a row's runtime state and client attachment count into a display status union. */
export function sessionRowStatus(
    row: Pick<SessionRow, "runtimeState" | "attachedClients" | "modifiedAtMs">,
): SessionRowStatus {
    switch (row.runtimeState) {
        case "starting":
            return { kind: "active", state: "starting", label: "Starting" };
        case "streaming":
            return { kind: "active", state: "streaming", label: "Streaming" };
        case "compacting":
            return { kind: "active", state: "compacting", label: "Compacting" };
        case "closing":
            return { kind: "active", state: "closing", label: "Closing" };
        case "idle":
            return row.attachedClients > 0
                ? { kind: "active", state: "attached", label: "Attached" }
                : { kind: "idle", modifiedAtMs: row.modifiedAtMs };
        default:
            return assertNever(row.runtimeState, "Unknown session runtime state");
    }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** Formats a compact relative age (`now`, `5m`, `2h`, `3d`, `2w`, `1y`). */
export function formatRelativeAge(timestampMs: number, nowMs: number): string {
    const deltaMs = Math.max(0, nowMs - timestampMs);
    if (deltaMs < MINUTE_MS) {
        return "now";
    }
    if (deltaMs < HOUR_MS) {
        return `${String(Math.floor(deltaMs / MINUTE_MS))}m`;
    }
    if (deltaMs < DAY_MS) {
        return `${String(Math.floor(deltaMs / HOUR_MS))}h`;
    }
    if (deltaMs < WEEK_MS) {
        return `${String(Math.floor(deltaMs / DAY_MS))}d`;
    }
    if (deltaMs < YEAR_MS) {
        return `${String(Math.floor(deltaMs / WEEK_MS))}w`;
    }
    return `${String(Math.floor(deltaMs / YEAR_MS))}y`;
}

/** Collects unique non-empty working directories ordered by most recently active session first. */
export function collectKnownCwds(sessions: readonly SessionSummary[]): readonly string[] {
    const seen = new Set<string>();
    const cwds: string[] = [];
    for (const session of sortSessions(sessions)) {
        if (session.cwd.trim() === "" || seen.has(session.cwd)) {
            continue;
        }
        seen.add(session.cwd);
        cwds.push(session.cwd);
    }
    return cwds;
}
