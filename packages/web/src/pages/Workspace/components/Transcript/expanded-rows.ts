import type { TranscriptItem } from "@/stores/session";

/** Turn rows the reader expanded, keyed by row id. */
export type ExpandedRows = ReadonlySet<string>;

/** Count and first row id of a rendered row list. */
export type RowShape = {
    readonly count: number;
    readonly firstId: string | undefined;
};

/** Shape of a row list, used to decide whether a change can orphan an expanded id. */
export function rowShape(rows: readonly TranscriptItem[]): RowShape {
    return { count: rows.length, firstId: rows[0]?.id };
}

/**
 * Whether a row-list change can leave an expanded id without its row.
 *
 * Only a shorter list or another first row can: rows are identified by entry, and the entries a
 * projection appends keep every earlier id. A middle row removed while the list keeps its length and
 * its first row is not tracked, because a stale id can only matter when that exact entry returns.
 */
export function orphansExpandedRows(previous: RowShape, next: RowShape): boolean {
    return next.count < previous.count || next.firstId !== previous.firstId;
}

/**
 * Drops expanded ids that no longer name a row.
 *
 * Returns the same set when every id still exists, so a caller can skip a re-render.
 */
export function removeMissingRows(expanded: ExpandedRows, rows: readonly TranscriptItem[]): ExpandedRows {
    if (expanded.size === 0) {
        return expanded;
    }
    const present = new Set(rows.map((row) => row.id));
    let next: Set<string> | null = null;
    for (const rowId of expanded) {
        if (!present.has(rowId)) {
            next ??= new Set(expanded);
            next.delete(rowId);
        }
    }
    return next ?? expanded;
}
