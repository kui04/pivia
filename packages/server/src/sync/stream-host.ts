import {
    WS_CLOSE_CODE,
    type SequencedDelta,
    type SyncCursor,
    type SyncFrame,
    type SyncHandshake,
    type SyncSeq,
    type WsCloseCode,
} from "@pivia/protocol";

import type { ReplayRingBuffer } from "./replay-buffer.ts";
import type { SyncGuardLogger, SyncTransportClient } from "./ws-guard.ts";

/** Default maximum number of deltas buffered per handshaking client before forcing resync. */
export const DEFAULT_MAX_HANDSHAKE_PENDING = 512;

/** Snapshot paired with the exact logical cursor it reflects. */
export interface SyncSnapshotResult<D extends string, TSnapshot> {
    readonly cursor: SyncCursor<D>;
    readonly snapshot: TSnapshot;
}

/** Options for {@link SyncStreamHost}. */
export interface SyncStreamHostOptions<D extends string, TSnapshot, TDelta, THint = undefined> {
    readonly buffer: ReplayRingBuffer<D, TDelta>;
    /**
     * Produce a linearized snapshot and its corresponding cursor.
     *
     * Callers must capture `cursor` synchronously for the exact state reflected in `snapshot`—never
     * lagging behind mutations already included in `snapshot` and never advancing past omitted ones—so
     * the watermark drain skips deltas already inside `snapshot` (`seq <= cursor.seq`) and forwards
     * every newer delta without duplicates or gaps.
     */
    readonly getSnapshot: (
        hint: THint | undefined,
    ) => Promise<SyncSnapshotResult<D, TSnapshot>> | SyncSnapshotResult<D, TSnapshot>;
    readonly maxPendingPerClient?: number | undefined;
    readonly logger?: SyncGuardLogger | undefined;
}

type HandshakingPendingItem<D extends string> = {
    readonly seq: SyncSeq<D>;
    readonly raw: string;
};

type HostClientPhase<D extends string> =
    | {
          readonly kind: "handshaking";
          readonly pending: Array<HandshakingPendingItem<D>>;
          overflowed: boolean;
      }
    | { readonly kind: "live" };

interface AttachedClient<D extends string> {
    phase: HostClientPhase<D>;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

/**
 * Shared server-side synchronization engine for one domain stream.
 *
 * Owns monotonic `publish()` into {@link ReplayRingBuffer}, Tier 1 replay handshakes,
 * Subscribe-before-Snapshot watermark draining for async snapshots, and fan-out to live clients.
 */
export class SyncStreamHost<D extends string, TSnapshot, TDelta, THint = undefined, TCloseCode extends number = never> {
    readonly buffer: ReplayRingBuffer<D, TDelta>;
    private readonly getSnapshot: SyncStreamHostOptions<D, TSnapshot, TDelta, THint>["getSnapshot"];
    private readonly maxPendingPerClient: number;
    private readonly logger: SyncGuardLogger | undefined;
    private readonly clients = new Map<SyncTransportClient<TCloseCode>, AttachedClient<D>>();
    private disposed = false;

    constructor(options: SyncStreamHostOptions<D, TSnapshot, TDelta, THint>) {
        const maxPending = options.maxPendingPerClient ?? DEFAULT_MAX_HANDSHAKE_PENDING;
        if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
            throw new RangeError("SyncStreamHost maxPendingPerClient must be a positive integer.");
        }
        this.buffer = options.buffer;
        this.getSnapshot = options.getSnapshot;
        this.maxPendingPerClient = maxPending;
        this.logger = options.logger;
    }

    /** Current number of attached clients (both `handshaking` and `live`). */
    get subscriberCount(): number {
        return this.clients.size;
    }

    /**
     * Publish one domain delta on the stream's monotonic clock.
     *
     * Always records the delta in {@link ReplayRingBuffer} even when `subscriberCount === 0` so
     * reconnecting clients never observe sequence gaps, while skipping JSON serialization when no
     * clients are attached.
     */
    publish(delta: TDelta, precomputedPayloadBytes?: number): SequencedDelta<D, TDelta> {
        const sequenced = this.buffer.push(delta, precomputedPayloadBytes);
        if (this.disposed || this.clients.size === 0) {
            return sequenced;
        }
        const frame: SyncFrame<D, TSnapshot, TDelta> = {
            type: "sync:delta",
            cursor: { epoch: this.buffer.epoch, seq: sequenced.seq },
            delta,
        };
        const raw = JSON.stringify(frame);

        for (const [client, state] of [...this.clients.entries()]) {
            if (state.phase.kind === "handshaking") {
                if (state.phase.overflowed) {
                    continue;
                }
                if (state.phase.pending.length >= this.maxPendingPerClient) {
                    state.phase.overflowed = true;
                    state.phase.pending.length = 0;
                    continue;
                }
                state.phase.pending.push({ seq: sequenced.seq, raw });
                continue;
            }
            client.sendRaw(raw);
        }
        return sequenced;
    }

    /**
     * Attach one client transport and execute Tier 1 replay or Tier 2/3 snapshot + watermark drain.
     *
     * Returns an idempotent `detach()` function immediately so close listeners can clean up even
     * while an async `getSnapshot()` call is still in flight.
     */
    attach(client: SyncTransportClient<TCloseCode>, handshake: SyncHandshake<D, THint> = {}): () => void {
        if (this.disposed) {
            client.close(WS_CLOSE_CODE.goingAway, "Stream disposed");
            return () => {};
        }

        const detach = (): void => {
            this.clients.delete(client);
        };

        if (handshake.cursor !== undefined) {
            const lookup = this.buffer.since(handshake.cursor);
            if (lookup.kind === "replay") {
                this.clients.set(client, { phase: { kind: "live" } });
                const replayFrame: SyncFrame<D, TSnapshot, TDelta> = {
                    type: "sync:replay",
                    cursor: lookup.cursor,
                    fromSeq: lookup.fromSeq,
                    deltas: lookup.deltas,
                };
                client.sendRaw(JSON.stringify(replayFrame));
                return detach;
            }
        }

        const state: AttachedClient<D> = {
            phase: { kind: "handshaking", pending: [], overflowed: false },
        };
        this.clients.set(client, state);

        const completeHandshake = (result: SyncSnapshotResult<D, TSnapshot>): void => {
            if (this.disposed || this.clients.get(client) !== state || state.phase.kind !== "handshaking") {
                return;
            }
            if (state.phase.overflowed) {
                this.clients.delete(client);
                const resyncFrame: SyncFrame<D, TSnapshot, TDelta> = {
                    type: "sync:resync",
                    reason: "buffer_evicted",
                };
                client.sendRaw(JSON.stringify(resyncFrame));
                client.close(WS_CLOSE_CODE.normal, "Handshake resync required");
                return;
            }

            const snapshotFrame: SyncFrame<D, TSnapshot, TDelta> = {
                type: "sync:snapshot",
                cursor: result.cursor,
                snapshot: result.snapshot,
            };
            client.sendRaw(JSON.stringify(snapshotFrame));
            if (this.disposed || this.clients.get(client) !== state) {
                return;
            }

            const pending = state.phase.pending;
            state.phase = { kind: "live" };
            for (const item of pending) {
                if (this.disposed || this.clients.get(client) !== state) {
                    break;
                }
                if (item.seq <= result.cursor.seq) {
                    continue;
                }
                client.sendRaw(item.raw);
            }
            pending.length = 0;
        };

        const failHandshake = (error: unknown): void => {
            if (this.clients.get(client) !== state) {
                return;
            }
            this.clients.delete(client);
            this.logger?.warn({ err: error }, "failed to build sync snapshot for attaching client");
            client.close(WS_CLOSE_CODE.internalError, "Snapshot unavailable");
        };

        try {
            const snapshotOrPromise = this.getSnapshot(handshake.hint);
            if (isPromiseLike(snapshotOrPromise)) {
                void snapshotOrPromise.then(completeHandshake, failHandshake);
            } else {
                completeHandshake(snapshotOrPromise);
            }
        } catch (error) {
            failHandshake(error);
        }

        return detach;
    }

    /** Close all attached clients and reject any in-flight handshakes. Idempotent. */
    dispose(code: WsCloseCode | TCloseCode = WS_CLOSE_CODE.goingAway, reason = "Stream disposed"): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const attached = [...this.clients.keys()];
        this.clients.clear();
        for (const client of attached) {
            client.close(code, reason);
        }
    }
}
