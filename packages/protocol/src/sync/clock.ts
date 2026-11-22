declare const SyncDomainBrand: unique symbol;

/** Domain-scoped epoch identifier that changes whenever server or runtime state resets. */
export type SyncEpoch<D extends string> = string & {
    readonly [SyncDomainBrand]: { readonly kind: "epoch"; readonly domain: (domain: D) => D };
};

/** Non-negative safe integer sequence strictly monotonic within one {@link SyncEpoch}. */
export type SyncSeq<D extends string> = number & {
    readonly [SyncDomainBrand]: { readonly kind: "seq"; readonly domain: (domain: D) => D };
};

/** Logical clock cursor pairing a domain epoch with its sequence number. */
export interface SyncCursor<D extends string> {
    readonly epoch: SyncEpoch<D>;
    readonly seq: SyncSeq<D>;
}

/** Return the initial zero sequence (`0`) for domain `D`, representing state before the first delta. */
export function initialSyncSeq<D extends string>(): SyncSeq<D> {
    // 0 satisfies the non-negative safe-integer invariant of SyncSeq<D>.
    return 0 as SyncSeq<D>;
}

/** Parse a non-empty string into a branded {@link SyncEpoch}, or return `null` when invalid. */
export function parseSyncEpoch<D extends string>(raw: unknown): SyncEpoch<D> | null {
    return typeof raw === "string" && raw.length > 0 ? (raw as SyncEpoch<D>) : null;
}

/** Parse a non-negative safe integer into a branded {@link SyncSeq}, or return `null` when invalid. */
export function parseSyncSeq<D extends string>(raw: unknown): SyncSeq<D> | null {
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? (raw as SyncSeq<D>) : null;
}

/**
 * Parse a strictly positive (`>= 1`) safe integer into a branded {@link SyncSeq}.
 *
 * Published deltas and replay entries always start at `1`; `0` is reserved for empty snapshots and
 * `fromSeq` anchors.
 */
export function parsePositiveSyncSeq<D extends string>(raw: unknown): SyncSeq<D> | null {
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? (raw as SyncSeq<D>) : null;
}

/** Parse a base-10 non-negative integer string into a {@link SyncSeq}, or return `null`. */
export function parseSyncSeqString<D extends string>(raw: unknown): SyncSeq<D> | null {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
        return null;
    }
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? (parsed as SyncSeq<D>) : null;
}

/**
 * Advance `seq` by one.
 *
 * @throws RangeError when incrementing exceeds `Number.MAX_SAFE_INTEGER`.
 */
export function nextSyncSeq<D extends string>(seq: SyncSeq<D>): SyncSeq<D> {
    const next = seq + 1;
    if (!Number.isSafeInteger(next)) {
        throw new RangeError("Sync sequence overflow.");
    }
    return next as SyncSeq<D>;
}

/** Explicit decision distinguishing normal advance, duplicates, gaps, and epoch changes. */
export type DeltaCursorDecision<D extends string> =
    | { readonly kind: "apply" }
    | { readonly kind: "duplicate" }
    | { readonly kind: "gap"; readonly expectedSeq: SyncSeq<D>; readonly receivedSeq: SyncSeq<D> }
    | { readonly kind: "epoch_mismatch" };

/** Compare an incoming delta cursor against the client's applied cursor without boolean blindness. */
export function evaluateDeltaCursor<D extends string>(
    current: SyncCursor<D>,
    incoming: SyncCursor<D>,
): DeltaCursorDecision<D> {
    if (current.epoch !== incoming.epoch) {
        return { kind: "epoch_mismatch" };
    }
    if (incoming.seq <= current.seq) {
        return { kind: "duplicate" };
    }
    const expectedSeq = nextSyncSeq(current.seq);
    if (incoming.seq === expectedSeq) {
        return { kind: "apply" };
    }
    return { kind: "gap", expectedSeq, receivedSeq: incoming.seq };
}

/**
 * Return true when an incoming snapshot supersedes or matches `current`.
 *
 * Cross-epoch snapshots always supersede because a new epoch restarts the sequence space.
 */
export function canApplySyncSnapshot<D extends string>(
    current: SyncCursor<D> | null,
    incoming: SyncCursor<D>,
): boolean {
    return current === null || current.epoch !== incoming.epoch || incoming.seq >= current.seq;
}
