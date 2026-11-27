import type {
    CatalogDelta,
    SessionId,
    SessionRuntimeState,
    SessionSummary,
    SessionSummaryPatch,
} from "@pivia/protocol";

import type { CatalogDiskEntry, DiskFileStamp } from "./catalog.ts";

/** Tracked on-disk backing state for an open `ActiveSession`. */
export type TrackedDiskFile =
    | { readonly kind: "ephemeral" }
    | { readonly kind: "unflushed"; readonly expectedPath: string }
    | {
          readonly kind: "persisted";
          readonly realPath: string;
          readonly stamp: DiskFileStamp;
      };

/** Outcome of comparing an open runtime's {@link TrackedDiskFile} against the latest disk scan. */
export type ActiveDiskChange =
    | { readonly kind: "unchanged" }
    | { readonly kind: "modified"; readonly diskEntry: CatalogDiskEntry }
    | { readonly kind: "deleted" };

/** Deferred external reload state while an `ActiveSession` is starting, streaming, compacting, or awaiting UI. */
export type PendingExternalSync = "none" | "reload_when_idle";

/** Options controlling how {@link diffCatalogSnapshots} handles missing sessions. */
export interface DiffCatalogOptions {
    /** When true, omit `{ op: "remove" }` deltas for sessions absent from `next` (for incomplete scans). */
    readonly suppressRemovals?: boolean | undefined;
}

/** Return true when two disk file stamps represent the same file size, timestamps, and inode. */
export function stampsEqual(left: DiskFileStamp, right: DiskFileStamp): boolean {
    return (
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs &&
        left.sizeBytes === right.sizeBytes &&
        left.ino === right.ino
    );
}

/** Detect whether an open session's disk file was modified or deleted outside Pivia. */
export function detectActiveDiskChange(
    tracked: TrackedDiskFile,
    diskEntry: CatalogDiskEntry | undefined,
): ActiveDiskChange {
    switch (tracked.kind) {
        case "ephemeral":
            return { kind: "unchanged" };
        case "unflushed":
            return diskEntry === undefined ? { kind: "unchanged" } : { kind: "modified", diskEntry };
        case "persisted":
            if (diskEntry === undefined) {
                return { kind: "deleted" };
            }
            if (diskEntry.realPath !== tracked.realPath || !stampsEqual(tracked.stamp, diskEntry.stamp)) {
                return { kind: "modified", diskEntry };
            }
            return { kind: "unchanged" };
    }
}

/**
 * Compute a minimal {@link SessionSummaryPatch} over mutable fields, or `null` if identical.
 */
export function diffSessionSummaryPatch(previous: SessionSummary, next: SessionSummary): SessionSummaryPatch | null {
    const patch: {
        name?: string | null;
        firstMessage?: string;
        messageCount?: number;
        modifiedAtMs?: number;
        runtimeState?: SessionRuntimeState;
        attachedClients?: number;
    } = {};
    let changed = false;

    if (previous.name !== next.name) {
        patch.name = next.name;
        changed = true;
    }
    if (previous.firstMessage !== next.firstMessage) {
        patch.firstMessage = next.firstMessage;
        changed = true;
    }
    if (previous.messageCount !== next.messageCount) {
        patch.messageCount = next.messageCount;
        changed = true;
    }
    if (previous.modifiedAtMs !== next.modifiedAtMs) {
        patch.modifiedAtMs = next.modifiedAtMs;
        changed = true;
    }
    if (previous.runtimeState !== next.runtimeState) {
        patch.runtimeState = next.runtimeState;
        changed = true;
    }
    if (previous.attachedClients !== next.attachedClients) {
        patch.attachedClients = next.attachedClients;
        changed = true;
    }

    return changed ? patch : null;
}

/**
 * Compute the minimal {@link CatalogDelta} transforming `previous` into `next`, or `null` if equal.
 *
 * Emits `{ op: "upsert" }` when immutable fields (`cwd`, `createdAtMs`, `hasParent`) change, and
 * `{ op: "patch" }` when only mutable fields change.
 */
export function diffSessionSummaryForCatalog(previous: SessionSummary, next: SessionSummary): CatalogDelta | null {
    if (
        previous.cwd !== next.cwd ||
        previous.createdAtMs !== next.createdAtMs ||
        previous.hasParent !== next.hasParent
    ) {
        return { op: "upsert", item: next };
    }

    const patch = diffSessionSummaryPatch(previous, next);
    return patch === null ? null : { op: "patch", id: next.id, patch };
}

/** Compute ordered {@link CatalogDelta} operations transforming `previous` into `next`. */
export function diffCatalogSnapshots(
    previous: ReadonlyMap<SessionId, SessionSummary>,
    next: ReadonlyMap<SessionId, SessionSummary>,
    options: DiffCatalogOptions = {},
): readonly CatalogDelta[] {
    const deltas: CatalogDelta[] = [];

    for (const [id, nextSummary] of next) {
        const previousSummary = previous.get(id);
        if (previousSummary === undefined) {
            deltas.push({ op: "upsert", item: nextSummary });
            continue;
        }
        const delta = diffSessionSummaryForCatalog(previousSummary, nextSummary);
        if (delta !== null) {
            deltas.push(delta);
        }
    }

    if (options.suppressRemovals !== true) {
        for (const id of previous.keys()) {
            if (!next.has(id)) {
                deltas.push({ op: "remove", id });
            }
        }
    }

    return deltas;
}

/** Merge disk session summaries with live active summaries, sorted newest activity first. */
export function mergeSessionSummaries(
    diskSummaries: readonly SessionSummary[],
    activeSummaries: readonly SessionSummary[],
): readonly SessionSummary[] {
    const activeById = new Map(activeSummaries.map((summary) => [summary.id, summary]));
    const merged = diskSummaries.map((summary) => activeById.get(summary.id) ?? summary);
    const mergedIds = new Set(merged.map((summary) => summary.id));
    const missing = activeSummaries.filter((summary) => !mergedIds.has(summary.id));
    return [...merged, ...missing].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
}

/** Merge disk-discovered session entries with live active summaries, sorted newest activity first. */
export function mergeCatalogEntries(
    diskEntries: readonly CatalogDiskEntry[],
    activeSummaries: readonly SessionSummary[],
): readonly SessionSummary[] {
    return mergeSessionSummaries(
        diskEntries.map((entry) => entry.summary),
        activeSummaries,
    );
}
