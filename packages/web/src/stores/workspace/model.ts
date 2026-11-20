import type { SessionRuntimeState, SessionSummary } from "@pivia/protocol";

/** Where the last session scan stands. */
export type ScanPhase =
    | { readonly kind: "idle" }
    | {
          readonly kind: "scanning";
          /** True when a person asked for this scan, so the list may show its skeleton. */
          readonly manual: boolean;
      }
    | { readonly kind: "ready" }
    | { readonly kind: "failed"; readonly message: string };

/** One session as the workspace list shows it. */
export interface SessionRow {
    /** Opaque server id; the only identity the browser ever uses for a session. */
    readonly id: string;
    /** The name, else the first message, else a placeholder. */
    readonly title: string;
    /** True when `title` came from a session name rather than the first message. */
    readonly named: boolean;
    /** Working directory recorded in the session header. */
    readonly cwd: string;
    readonly modifiedAtMs: number;
    readonly runtimeState: SessionRuntimeState;
    readonly attachedClients: number;
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
    readonly pins: readonly string[];
    readonly query: string;
    readonly selectedId: string | null;
    readonly collapsed: readonly string[];
}

const UNTITLED = "Untitled session";

/** What a row title is, and whether it shows a name or a first message. */
export interface SessionTitle {
    readonly title: string;
    readonly named: boolean;
}

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

/** Replaces the session with the same id, or appends it when the id is new. */
export function upsertSession(sessions: readonly SessionSummary[], session: SessionSummary): readonly SessionSummary[] {
    const index = sessions.findIndex((candidate) => candidate.id === session.id);
    if (index === -1) {
        return [...sessions, session];
    }
    const next = [...sessions];
    next[index] = session;
    return next;
}

/** Returns a new list without the session of `id`. */
export function removeSession(sessions: readonly SessionSummary[], id: string): readonly SessionSummary[] {
    return sessions.filter((session) => session.id !== id);
}

function toRow(summary: SessionSummary, pins: ReadonlySet<string>, selectedId: string | null): SessionRow {
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
 * A search matches the name, the first message and the cwd, and it expands every folder so a
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
