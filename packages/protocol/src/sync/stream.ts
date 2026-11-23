import type { SyncCursor, SyncSeq } from "./clock.ts";

/** Generic payload container switching transparently between inline WS frames and HTTP fetches. */
export type Delivery<T, THttpMeta> =
    { readonly mode: "inline"; readonly data: T } | { readonly mode: "http"; readonly meta: THttpMeta };

/** One delta paired with its monotonic domain sequence number (`seq >= 1`). */
export interface SequencedDelta<D extends string, TDelta> {
    readonly seq: SyncSeq<D>;
    readonly payload: TDelta;
}

/** Client handshake parameters carrying an optional cursor and optional domain-specific hint. */
export interface SyncHandshake<D extends string, THint = undefined> {
    readonly cursor?: SyncCursor<D> | undefined;
    readonly hint?: THint | undefined;
}

/** Resynchronization reasons sent by the server on `sync:resync`. */
export type SyncServerResyncReason = "gap" | "epoch_changed" | "buffer_evicted";

/** All reasons that trigger client resynchronization, including client-detected integrity faults. */
export type SyncResyncReason = SyncServerResyncReason | "invalid_replay" | "hydration_gap" | "pending_overflow";

/** Standard server-to-client synchronization envelope shared by every SyncStream domain. */
export type SyncFrame<D extends string, TSnapshot, TDelta> =
    | {
          readonly type: "sync:snapshot";
          readonly cursor: SyncCursor<D>;
          readonly snapshot: TSnapshot;
      }
    | {
          readonly type: "sync:replay";
          readonly cursor: SyncCursor<D>;
          readonly fromSeq: SyncSeq<D>;
          readonly deltas: readonly SequencedDelta<D, TDelta>[];
      }
    | {
          readonly type: "sync:delta";
          readonly cursor: SyncCursor<D>;
          readonly delta: TDelta;
      }
    | {
          readonly type: "sync:resync";
          readonly reason: SyncServerResyncReason;
      };

/** Standard delta archetype for keyed entity collections. */
export type CollectionDelta<TId extends string, TItem, TPatch> =
    | { readonly op: "upsert"; readonly item: TItem }
    | { readonly op: "patch"; readonly id: TId; readonly patch: TPatch }
    | { readonly op: "remove"; readonly id: TId };

/** Pure state reduction contract consumed by `SyncStreamClient`. */
export interface SyncReducer<TState, TSnapshot, TDelta> {
    applySnapshot(prev: TState, snapshot: TSnapshot): TState;
    applyDelta(prev: TState, delta: TDelta): TState;
}

/**
 * Extended reducer contract for domains whose snapshots or deltas may offload payloads to HTTP.
 *
 * Returning a non-null descriptor switches the client into `hydrating_http` before subsequent
 * deltas are applied.
 */
export interface HydratableSyncReducer<TState, TSnapshot, TDelta, THydration = never> extends SyncReducer<
    TState,
    TSnapshot,
    TDelta
> {
    inspectSnapshot?(snapshot: TSnapshot, state: TState): THydration | null;
    inspectDelta?(delta: TDelta, state: TState): THydration | null;
    /** Optional non-fatal recovery when an HTTP hydration fails (keeps live WS deltas flowing). */
    recoverHydrationFailure?(prevState: TState, descriptor: THydration, message: string): TState;
}
