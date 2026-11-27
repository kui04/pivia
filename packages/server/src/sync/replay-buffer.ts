import {
    initialSyncSeq,
    nextSyncSeq,
    type SequencedDelta,
    type SyncCursor,
    type SyncEpoch,
    type SyncSeq,
} from "@pivia/protocol";

/** Default maximum number of delta entries retained for Tier 1 replay. */
export const DEFAULT_REPLAY_MAX_ENTRIES = 512;

/** Options for {@link ReplayRingBuffer}. */
export interface ReplayRingBufferOptions<D extends string, TDelta> {
    readonly epoch: SyncEpoch<D>;
    /** Maximum number of retained entries (`>= 1`). Defaults to `512`. */
    readonly maxEntries?: number | undefined;
    /** Optional UTF-8 byte budget across retained delta payloads (`>= 1`). */
    readonly maxBytes?: number | undefined;
    /** Optional custom byte estimator used when `maxBytes` is configured. */
    readonly measureBytes?: ((payload: TDelta) => number) | undefined;
}

/** Explicit lookup result returned by {@link ReplayRingBuffer.since}. */
export type ReplayLookupResult<D extends string, TDelta> =
    | {
          readonly kind: "replay";
          readonly fromSeq: SyncSeq<D>;
          readonly cursor: SyncCursor<D>;
          readonly deltas: readonly SequencedDelta<D, TDelta>[];
      }
    | {
          readonly kind: "snapshot_required";
          readonly cursor: SyncCursor<D>;
          readonly reason: "missing_cursor" | "epoch_changed" | "buffer_evicted" | "ahead_of_head";
      };

interface StoredEntry<D extends string, TDelta> {
    readonly item: SequencedDelta<D, TDelta>;
    readonly bytes: number;
}

function defaultMeasureBytes(payload: unknown): number {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/**
 * Bounded, epoch-scoped ring buffer of sequenced domain deltas.
 *
 * Enforces `maxEntries` and an optional `maxBytes` budget on retained entries. When a single delta
 * alone exceeds `maxBytes`, it is still assigned a monotonic sequence number and immediately
 * evicted so memory stays bounded and older clients fall back to a snapshot.
 */
export class ReplayRingBuffer<D extends string, TDelta> {
    readonly epoch: SyncEpoch<D>;
    private readonly maxEntries: number;
    private readonly maxBytes: number | undefined;
    private readonly measureBytes: (payload: TDelta) => number;
    private readonly entries: Array<StoredEntry<D, TDelta> | undefined>;
    private head = 0;
    private size = 0;
    private totalBytes = 0;
    private lastSeq: SyncSeq<D>;

    constructor(options: ReplayRingBufferOptions<D, TDelta>) {
        const maxEntries = options.maxEntries ?? DEFAULT_REPLAY_MAX_ENTRIES;
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
            throw new RangeError("ReplayRingBuffer maxEntries must be a positive integer.");
        }
        if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) {
            throw new RangeError("ReplayRingBuffer maxBytes must be a positive integer.");
        }
        this.epoch = options.epoch;
        this.maxEntries = maxEntries;
        this.maxBytes = options.maxBytes;
        this.measureBytes = options.measureBytes ?? defaultMeasureBytes;
        this.entries = new Array<StoredEntry<D, TDelta> | undefined>(maxEntries).fill(undefined);
        this.lastSeq = initialSyncSeq<D>();
    }

    /** Sequence number of the newest pushed delta, or `0` before the first push. */
    get currentSeq(): SyncSeq<D> {
        return this.lastSeq;
    }

    /** Logical cursor pointing to the newest published state in this epoch. */
    get currentCursor(): SyncCursor<D> {
        return { epoch: this.epoch, seq: this.lastSeq };
    }

    /** Sequence number of the oldest retained delta, or `currentSeq + 1` when empty. */
    get earliestSeq(): SyncSeq<D> {
        if (this.size === 0) {
            return nextSyncSeq(this.lastSeq);
        }
        return this.entries[this.head]?.item.seq ?? nextSyncSeq(this.lastSeq);
    }

    /** Number of deltas currently retained in the buffer. */
    get retainedCount(): number {
        return this.size;
    }

    /** Tracked byte size of retained deltas (`0` when `maxBytes` is unset). */
    get retainedBytes(): number {
        return this.totalBytes;
    }

    /**
     * Assign the next monotonic sequence number, store `payload`, and evict oldest entries until
     * entry and byte bounds hold.
     */
    push(payload: TDelta, precomputedBytes?: number): SequencedDelta<D, TDelta> {
        const seq = nextSyncSeq(this.lastSeq);
        this.lastSeq = seq;
        const item: SequencedDelta<D, TDelta> = { seq, payload };
        const bytes =
            this.maxBytes === undefined
                ? 0
                : precomputedBytes !== undefined
                  ? precomputedBytes
                  : this.measureBytes(payload);

        if (this.maxBytes !== undefined && bytes > this.maxBytes) {
            // Drop everything instead of retaining an oversized entry that blows the byte budget.
            this.clearRetained();
            return item;
        }

        if (this.size === this.maxEntries) {
            this.evictOldest();
        }
        const tail = (this.head + this.size) % this.maxEntries;
        this.entries[tail] = { item, bytes };
        this.size += 1;
        this.totalBytes += bytes;

        if (this.maxBytes !== undefined) {
            while (this.size > 0 && this.totalBytes > this.maxBytes) {
                this.evictOldest();
            }
        }
        return item;
    }

    /**
     * Return all contiguous deltas strictly after `cursor.seq`, or indicate why a snapshot is
     * required instead.
     */
    since(cursor?: SyncCursor<D>): ReplayLookupResult<D, TDelta> {
        const headCursor = this.currentCursor;
        if (cursor === undefined) {
            return { kind: "snapshot_required", cursor: headCursor, reason: "missing_cursor" };
        }
        if (cursor.epoch !== this.epoch) {
            return { kind: "snapshot_required", cursor: headCursor, reason: "epoch_changed" };
        }
        if (cursor.seq > this.lastSeq) {
            return { kind: "snapshot_required", cursor: headCursor, reason: "ahead_of_head" };
        }
        if (cursor.seq < this.earliestSeq - 1) {
            return { kind: "snapshot_required", cursor: headCursor, reason: "buffer_evicted" };
        }

        const deltas: SequencedDelta<D, TDelta>[] = [];
        for (let index = 0; index < this.size; index += 1) {
            const entry = this.entries[(this.head + index) % this.maxEntries];
            if (entry !== undefined && entry.item.seq > cursor.seq) {
                deltas.push(entry.item);
            }
        }
        return {
            kind: "replay",
            fromSeq: cursor.seq,
            cursor: headCursor,
            deltas,
        };
    }

    private evictOldest(): void {
        if (this.size === 0) {
            return;
        }
        const oldest = this.entries[this.head];
        this.entries[this.head] = undefined;
        this.head = (this.head + 1) % this.maxEntries;
        this.size -= 1;
        if (oldest !== undefined) {
            this.totalBytes = Math.max(0, this.totalBytes - oldest.bytes);
        }
    }

    private clearRetained(): void {
        if (this.size === 0) {
            return;
        }
        this.entries.fill(undefined);
        this.head = 0;
        this.size = 0;
        this.totalBytes = 0;
    }
}
