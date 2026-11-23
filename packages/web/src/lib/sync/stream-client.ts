import {
    assertNever,
    canApplySyncSnapshot,
    evaluateDeltaCursor,
    type HydratableSyncReducer,
    type SequencedDelta,
    type SyncCursor,
    type SyncFrame,
    type SyncResyncReason,
} from "@pivia/protocol";

import { Log } from "@/lib/log";

/** Default maximum deltas buffered while an HTTP hydration request is in flight. */
export const DEFAULT_MAX_PENDING_DELTAS = 512;

/**
 * Discriminated WebSocket synchronization phase.
 *
 * `pending` exists only in `hydrating_http`, and `cursor` is guaranteed non-null in `live`.
 */
export type SyncPhase<D extends string, TDelta> =
    | { readonly kind: "idle"; readonly lastCursor: SyncCursor<D> | null }
    | { readonly kind: "connecting"; readonly lastCursor: SyncCursor<D> | null }
    | {
          readonly kind: "hydrating_http";
          readonly targetCursor: SyncCursor<D>;
          /** Last fully-applied cursor before entering `hydrating_http`, used if disconnected early. */
          readonly committedCursor: SyncCursor<D> | null;
          readonly pending: readonly SequencedDelta<D, TDelta>[];
          readonly pendingOverflow: boolean;
      }
    | { readonly kind: "live"; readonly cursor: SyncCursor<D> }
    | { readonly kind: "reconnecting"; readonly lastCursor: SyncCursor<D> | null; readonly attempt: number }
    | { readonly kind: "resyncing"; readonly reason: SyncResyncReason; readonly resumeCursor: SyncCursor<D> | null }
    | { readonly kind: "error"; readonly message: string; readonly lastCursor: SyncCursor<D> | null };

/** One buffered delta retained while an orthogonal HTTP refresh is in flight. */
export interface BufferedExternalDelta<D extends string, TDelta> {
    readonly cursor: SyncCursor<D>;
    readonly payload: TDelta;
}

/** Orthogonal manual/external HTTP refresh state kept independent of {@link SyncPhase}. */
export type ExternalRefreshPhase<D extends string, TDelta> =
    | { readonly kind: "idle" }
    | {
          readonly kind: "in_flight";
          readonly startCursor: SyncCursor<D> | null;
          readonly wsSnapshotCursor: SyncCursor<D> | null;
          readonly buffered: readonly BufferedExternalDelta<D, TDelta>[];
          readonly overflowed: boolean;
      };

interface MutableExternalRefresh<D extends string, TDelta> {
    readonly kind: "in_flight";
    readonly startCursor: SyncCursor<D> | null;
    wsSnapshotCursor: SyncCursor<D> | null;
    readonly buffered: BufferedExternalDelta<D, TDelta>[];
    overflowed: boolean;
}

/** Source classification passed to `onStateChange`. */
export type SyncStateChangeSource = "snapshot" | "replay" | "delta" | "hydrate" | "external_refresh" | "phase";

/** Metadata emitted alongside state changes. */
export interface SyncStateChangeMeta<D extends string, TDelta> {
    readonly cursor: SyncCursor<D> | null;
    readonly phase: SyncPhase<D, TDelta>;
    readonly source: SyncStateChangeSource;
}

/** Context passed to `onHydrateHttp` when a snapshot or delta offloaded data to HTTP. */
export interface SyncHttpHydrationContext<D extends string, TState> {
    readonly signal: AbortSignal;
    readonly currentState: TState;
    /** Returns the latest reduced client state at async completion time (for background retries). */
    readonly getLatestState: () => TState;
    readonly targetCursor: SyncCursor<D>;
}

/** Options for {@link SyncStreamClient}. */
export interface SyncStreamClientOptions<D extends string, TState, TSnapshot, TDelta, THydration = never> {
    readonly initialState: TState;
    readonly reducer: HydratableSyncReducer<TState, TSnapshot, TDelta, THydration>;
    readonly maxPendingDeltas?: number | undefined;
    readonly onHydrateHttp?: (descriptor: THydration, context: SyncHttpHydrationContext<D, TState>) => Promise<TState>;
    readonly onStateChange?: (state: TState, meta: SyncStateChangeMeta<D, TDelta>) => void;
    readonly onResyncRequired?: (reason: SyncResyncReason, resumeCursor: SyncCursor<D> | null) => void;
}

/**
 * Verify the 4 integrity invariants required to accept a `sync:replay` frame:
 * 1) `lastCursor !== null`
 * 2) `frame.cursor.epoch === lastCursor.epoch`
 * 3) `frame.fromSeq === lastCursor.seq`
 * 4) `deltas` advance strictly by 1 from `lastCursor.seq + 1` to `frame.cursor.seq`
 *    (or `deltas` is empty and `frame.cursor.seq === lastCursor.seq`).
 */
export function isValidSyncReplay<D extends string, TSnapshot, TDelta>(
    lastCursor: SyncCursor<D> | null,
    frame: Extract<SyncFrame<D, TSnapshot, TDelta>, { readonly type: "sync:replay" }>,
): boolean {
    if (lastCursor === null) {
        return false;
    }
    if (frame.cursor.epoch !== lastCursor.epoch || frame.fromSeq !== lastCursor.seq) {
        return false;
    }
    if (frame.deltas.length === 0) {
        return frame.cursor.seq === lastCursor.seq;
    }
    let expectedSeq: number = lastCursor.seq + 1;
    for (const item of frame.deltas) {
        if (item.seq !== expectedSeq || item.seq > frame.cursor.seq) {
            return false;
        }
        expectedSeq += 1;
    }
    return expectedSeq - 1 === frame.cursor.seq;
}

/**
 * Shared client-side synchronization state machine for one domain stream.
 *
 * Handles `sync:snapshot`, 4-point verified `sync:replay`, strict contiguous `sync:delta`,
 * `Delivery.http` hydration + bounded pending drain (including offloaded deltas inside `sync:replay`
 * or `pending`), resyncing, and an orthogonal external HTTP refresh track.
 */
export class SyncStreamClient<D extends string, TState, TSnapshot, TDelta, THydration = never> {
    private readonly reducer: HydratableSyncReducer<TState, TSnapshot, TDelta, THydration>;
    private readonly maxPendingDeltas: number;
    private readonly onHydrateHttp: SyncStreamClientOptions<D, TState, TSnapshot, TDelta, THydration>["onHydrateHttp"];
    private readonly onStateChange: SyncStreamClientOptions<D, TState, TSnapshot, TDelta, THydration>["onStateChange"];
    private readonly onResyncRequired: SyncStreamClientOptions<
        D,
        TState,
        TSnapshot,
        TDelta,
        THydration
    >["onResyncRequired"];

    private state: TState;
    private phase: SyncPhase<D, TDelta> = { kind: "idle", lastCursor: null };
    private externalRefresh: { readonly kind: "idle" } | MutableExternalRefresh<D, TDelta> = { kind: "idle" };
    private hydrationAbort: AbortController | null = null;
    private hydrationToken = 0;
    private failedHydration: { readonly descriptor: THydration; readonly cursor: SyncCursor<D> } | null = null;

    constructor(options: SyncStreamClientOptions<D, TState, TSnapshot, TDelta, THydration>) {
        const maxPending = options.maxPendingDeltas ?? DEFAULT_MAX_PENDING_DELTAS;
        if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
            throw new RangeError("SyncStreamClient maxPendingDeltas must be a positive integer.");
        }
        this.state = options.initialState;
        this.reducer = options.reducer;
        this.maxPendingDeltas = maxPending;
        this.onHydrateHttp = options.onHydrateHttp;
        this.onStateChange = options.onStateChange;
        this.onResyncRequired = options.onResyncRequired;
    }

    get currentState(): TState {
        return this.state;
    }

    get currentPhase(): SyncPhase<D, TDelta> {
        return this.phase;
    }

    /** True when the last HTTP hydration failed via `recoverHydrationFailure` and can be retried. */
    get hasPendingHydrationRetry(): boolean {
        return this.failedHydration !== null;
    }

    /** Cursor of the newest fully-applied state (`live`, `reconnecting`, `connecting`, or `resyncing`). */
    get appliedCursor(): SyncCursor<D> | null {
        switch (this.phase.kind) {
            case "live":
                return this.phase.cursor;
            case "idle":
            case "connecting":
            case "reconnecting":
            case "error":
                return this.phase.lastCursor;
            case "hydrating_http":
                return this.phase.targetCursor;
            case "resyncing":
                return this.phase.resumeCursor;
            default:
                return assertNever(this.phase);
        }
    }

    /** Cursor that should be sent in the next WebSocket handshake query. */
    handshakeCursor(): SyncCursor<D> | undefined {
        // Pending failed HTTP hydration means the local state is incomplete past that offload; force
        // a full snapshot on reconnect instead of replaying deltas past unhydrated history.
        if (this.failedHydration !== null) {
            return undefined;
        }
        switch (this.phase.kind) {
            case "live":
                return this.phase.cursor;
            case "idle":
            case "connecting":
            case "reconnecting":
            case "error":
                return this.phase.lastCursor ?? undefined;
            case "resyncing":
                return this.phase.resumeCursor ?? undefined;
            case "hydrating_http":
                return undefined;
            default:
                return assertNever(this.phase);
        }
    }

    /** Newest cursor whose state and any required HTTP hydration are fully committed. */
    private get committedCursor(): SyncCursor<D> | null {
        switch (this.phase.kind) {
            case "live":
                return this.phase.cursor;
            case "hydrating_http":
                return this.phase.committedCursor;
            case "resyncing":
                return this.phase.resumeCursor;
            case "idle":
            case "connecting":
            case "reconnecting":
            case "error":
                return this.phase.lastCursor;
            default:
                return assertNever(this.phase);
        }
    }

    /** Transition into `connecting` while preserving an optional cursor for Tier 1 replay. */
    markConnecting(lastCursor: SyncCursor<D> | null = this.committedCursor): void {
        this.cancelInFlightHydration();
        this.phase = { kind: "connecting", lastCursor };
        this.emit("phase");
    }

    /** Transition into `reconnecting` on socket close while preserving `lastCursor`. */
    markReconnecting(attempt: number): void {
        const lastCursor = this.committedCursor;
        this.cancelInFlightHydration();
        this.phase = { kind: "reconnecting", lastCursor, attempt };
        this.emit("phase");
    }

    /** Transition into terminal or cooldown `error` without wiping existing state. */
    markError(message: string): void {
        const lastCursor = this.committedCursor;
        this.cancelInFlightHydration();
        this.phase = { kind: "error", message, lastCursor };
        this.emit("phase");
    }

    /** Reset state and cursor completely (used on session switch or logout). */
    reset(nextState: TState, lastCursor: SyncCursor<D> | null = null): void {
        this.cancelInFlightHydration();
        this.clearFailedHydration();
        this.externalRefresh = { kind: "idle" };
        this.state = nextState;
        this.phase = { kind: "idle", lastCursor };
        this.emit("phase");
    }

    /** Update local state from stale cache without inventing a live cursor. */
    hydrateLocalState(nextState: TState): void {
        this.state = nextState;
        this.emit("phase");
    }

    /**
     * Re-run the most recent recoverable HTTP hydration failure while keeping the WebSocket `live`.
     *
     * Returns false when no recoverable failure is pending or the stream is not `live`.
     */
    retryHydration(prepareState?: (prev: TState, descriptor: THydration) => TState): boolean {
        const failed = this.failedHydration;
        if (failed === null || this.phase.kind !== "live" || this.onHydrateHttp === undefined) {
            return false;
        }
        if (prepareState !== undefined) {
            this.state = prepareState(this.state, failed.descriptor);
            this.emit("phase");
        }
        this.runBackgroundHydrationRetry(failed.descriptor, failed.cursor);
        return true;
    }

    /** Start tracking an orthogonal manual HTTP refresh. */
    beginExternalRefresh(): void {
        this.externalRefresh = {
            kind: "in_flight",
            startCursor: this.appliedCursor,
            wsSnapshotCursor: null,
            buffered: [],
            overflowed: false,
        };
    }

    /**
     * Apply a completed external HTTP snapshot if it was not superseded by a newer WS snapshot,
     * folding any deltas that arrived while the HTTP request was in flight.
     */
    completeExternalRefresh(snapshot: TSnapshot, cursor: SyncCursor<D>): boolean {
        const currentRefresh = this.externalRefresh;
        this.externalRefresh = { kind: "idle" };
        if (currentRefresh.kind !== "in_flight" || currentRefresh.overflowed) {
            return false;
        }
        if (this.phase.kind === "live" && cursor.epoch !== this.phase.cursor.epoch) {
            return false;
        }
        if (
            currentRefresh.wsSnapshotCursor !== null &&
            (cursor.epoch !== currentRefresh.wsSnapshotCursor.epoch || cursor.seq < currentRefresh.wsSnapshotCursor.seq)
        ) {
            return false;
        }
        const currentApplied = this.appliedCursor;
        if (
            currentRefresh.startCursor !== null &&
            cursor.epoch === currentRefresh.startCursor.epoch &&
            currentApplied !== null &&
            currentApplied.epoch !== cursor.epoch
        ) {
            return false;
        }

        let nextState = this.reducer.applySnapshot(this.state, snapshot);
        let nextCursor = cursor;
        for (const item of currentRefresh.buffered) {
            if (item.cursor.epoch !== nextCursor.epoch || item.cursor.seq <= nextCursor.seq) {
                continue;
            }
            nextState = this.reducer.applyDelta(nextState, item.payload);
            nextCursor = item.cursor;
        }
        if (!canApplySyncSnapshot(currentApplied, nextCursor)) {
            return false;
        }
        this.state = nextState;
        if (this.phase.kind === "live") {
            this.phase = { kind: "live", cursor: nextCursor };
        } else if (this.phase.kind === "resyncing") {
            this.phase = { ...this.phase, resumeCursor: nextCursor };
        } else if (this.phase.kind !== "hydrating_http") {
            this.phase = { ...this.phase, lastCursor: nextCursor };
        }
        this.emit("external_refresh");
        return true;
    }

    /** Cancel or record failure on the external refresh track without disturbing WS state. */
    failExternalRefresh(): void {
        this.externalRefresh = { kind: "idle" };
    }

    /** Process one validated server {@link SyncFrame}. */
    handleFrame(frame: SyncFrame<D, TSnapshot, TDelta>): void {
        switch (frame.type) {
            case "sync:snapshot":
                this.handleSnapshot(frame);
                return;
            case "sync:replay":
                this.handleReplay(frame);
                return;
            case "sync:delta":
                this.handleDelta(frame);
                return;
            case "sync:resync":
                this.handleServerResync(frame.reason);
                return;
            default:
                assertNever(frame);
        }
    }

    private handleSnapshot(frame: Extract<SyncFrame<D, TSnapshot, TDelta>, { readonly type: "sync:snapshot" }>): void {
        const current = this.phase.kind === "resyncing" ? this.phase.resumeCursor : this.appliedCursor;
        const activatingConnection = this.phase.kind === "connecting" || this.phase.kind === "resyncing";
        if (!canApplySyncSnapshot(current, frame.cursor)) {
            if (activatingConnection && current !== null) {
                const staleHydration = this.reducer.inspectSnapshot?.(frame.snapshot, this.state) ?? null;
                if (staleHydration !== null) {
                    this.enterResyncing("gap", null);
                    return;
                }
                if (this.externalRefresh.kind === "in_flight") {
                    this.externalRefresh.wsSnapshotCursor = current;
                    this.externalRefresh.buffered.length = 0;
                    this.externalRefresh.overflowed = false;
                }
                this.phase = { kind: "live", cursor: current };
                this.emit("snapshot");
            }
            return;
        }
        this.cancelInFlightHydration();
        this.clearFailedHydration();
        if (this.externalRefresh.kind === "in_flight") {
            this.externalRefresh.wsSnapshotCursor = frame.cursor;
            this.externalRefresh.buffered.length = 0;
            this.externalRefresh.overflowed = false;
        }

        const nextState = this.reducer.applySnapshot(this.state, frame.snapshot);
        const hydration = this.reducer.inspectSnapshot?.(frame.snapshot, nextState) ?? null;
        this.state = nextState;

        if (hydration !== null) {
            this.phase = {
                kind: "hydrating_http",
                targetCursor: frame.cursor,
                committedCursor: null,
                pending: [],
                pendingOverflow: false,
            };
            this.emit("snapshot");
            this.startHydration(hydration, frame.cursor);
            return;
        }

        this.phase = { kind: "live", cursor: frame.cursor };
        this.emit("snapshot");
    }

    private handleReplay(frame: Extract<SyncFrame<D, TSnapshot, TDelta>, { readonly type: "sync:replay" }>): void {
        const lastCursor = this.handshakeCursor() ?? null;
        if (lastCursor === null || !isValidSyncReplay(lastCursor, frame)) {
            this.enterResyncing("invalid_replay", null);
            return;
        }
        this.cancelInFlightHydration();

        let nextState = this.state;
        let committed = lastCursor;
        for (let index = 0; index < frame.deltas.length; index += 1) {
            const item = frame.deltas[index];
            if (item === undefined) {
                continue;
            }
            const itemCursor: SyncCursor<D> = { epoch: frame.cursor.epoch, seq: item.seq };
            this.pushExternalBufferedDelta(itemCursor, item.payload);
            const hydration = this.reducer.inspectDelta?.(item.payload, nextState) ?? null;
            if (hydration !== null) {
                this.clearFailedHydration();
                const remaining = frame.deltas.slice(index + 1);
                const overflow = remaining.length > this.maxPendingDeltas;
                this.state = nextState;
                this.phase = {
                    kind: "hydrating_http",
                    targetCursor: itemCursor,
                    committedCursor: committed,
                    pending: overflow ? [] : remaining,
                    pendingOverflow: overflow,
                };
                this.emit("replay");
                this.startHydration(hydration, itemCursor);
                return;
            }
            nextState = this.reducer.applyDelta(nextState, item.payload);
            committed = itemCursor;
        }

        if (this.failedHydration !== null) {
            this.failedHydration = {
                descriptor: this.failedHydration.descriptor,
                cursor: frame.cursor,
            };
        }
        this.state = nextState;
        this.phase = { kind: "live", cursor: frame.cursor };
        this.emit("replay");
    }

    private handleDelta(frame: Extract<SyncFrame<D, TSnapshot, TDelta>, { readonly type: "sync:delta" }>): void {
        if (this.phase.kind === "hydrating_http") {
            if (frame.cursor.epoch !== this.phase.targetCursor.epoch) {
                this.enterResyncing("epoch_changed", null);
                return;
            }
            if (this.phase.pendingOverflow) {
                return;
            }
            const expectedBase = this.phase.pending.at(-1)?.seq ?? this.phase.targetCursor.seq;
            if (frame.cursor.seq <= expectedBase) {
                return;
            }
            if (frame.cursor.seq !== expectedBase + 1) {
                Log.warn(
                    `Sync delta gap while hydrating HTTP: expected seq ${String(expectedBase + 1)}, received ${String(frame.cursor.seq)}`,
                );
                this.enterResyncing("hydration_gap", null);
                return;
            }
            if (this.phase.pending.length >= this.maxPendingDeltas) {
                this.phase = {
                    ...this.phase,
                    pending: [],
                    pendingOverflow: true,
                };
                return;
            }
            this.phase = {
                ...this.phase,
                pending: [...this.phase.pending, { seq: frame.cursor.seq, payload: frame.delta }],
            };
            this.pushExternalBufferedDelta(frame.cursor, frame.delta);
            return;
        }

        if (this.phase.kind !== "live") {
            return;
        }

        const decision = evaluateDeltaCursor(this.phase.cursor, frame.cursor);
        switch (decision.kind) {
            case "duplicate":
                return;
            case "epoch_mismatch":
                this.enterResyncing("epoch_changed", null);
                return;
            case "gap":
                Log.warn(
                    `Sync delta gap: expected seq ${String(decision.expectedSeq)}, received ${String(decision.receivedSeq)}`,
                );
                this.enterResyncing("gap", this.phase.cursor);
                return;
            case "apply": {
                this.pushExternalBufferedDelta(frame.cursor, frame.delta);
                const hydration = this.reducer.inspectDelta?.(frame.delta, this.state) ?? null;
                if (hydration !== null) {
                    this.phase = {
                        kind: "hydrating_http",
                        targetCursor: frame.cursor,
                        committedCursor: this.phase.cursor,
                        pending: [],
                        pendingOverflow: false,
                    };
                    this.emit("phase");
                    this.startHydration(hydration, frame.cursor);
                    return;
                }
                this.state = this.reducer.applyDelta(this.state, frame.delta);
                this.phase = { kind: "live", cursor: frame.cursor };
                this.emit("delta");
                return;
            }
            default:
                assertNever(decision);
        }
    }

    private pushExternalBufferedDelta(cursor: SyncCursor<D>, payload: TDelta): void {
        if (this.externalRefresh.kind !== "in_flight" || this.externalRefresh.overflowed) {
            return;
        }
        if (this.externalRefresh.buffered.length >= this.maxPendingDeltas) {
            this.externalRefresh.buffered.length = 0;
            this.externalRefresh.overflowed = true;
            return;
        }
        this.externalRefresh.buffered.push({ cursor, payload });
    }

    private handleServerResync(reason: SyncResyncReason): void {
        // Server-initiated resync means the server cannot preserve delta continuity from our cursor.
        this.enterResyncing(reason, null);
    }

    private enterResyncing(reason: SyncResyncReason, resumeCursor: SyncCursor<D> | null): void {
        this.cancelInFlightHydration();
        if (resumeCursor === null) {
            this.clearFailedHydration();
        }
        this.phase = { kind: "resyncing", reason, resumeCursor };
        this.emit("phase");
        this.onResyncRequired?.(reason, resumeCursor);
    }

    private startHydration(descriptor: THydration, targetCursor: SyncCursor<D>): void {
        if (this.onHydrateHttp === undefined) {
            const lastCursor = this.committedCursor;
            this.phase = {
                kind: "error",
                message: "Missing HTTP hydration handler.",
                lastCursor,
            };
            this.emit("phase");
            return;
        }
        this.cancelInFlightHydration();
        this.clearFailedHydration();
        const controller = new AbortController();
        this.hydrationAbort = controller;
        const token = ++this.hydrationToken;

        void this.onHydrateHttp(descriptor, {
            signal: controller.signal,
            currentState: this.state,
            getLatestState: () => this.state,
            targetCursor,
        })
            .then((hydratedState) => {
                if (
                    controller.signal.aborted ||
                    token !== this.hydrationToken ||
                    this.phase.kind !== "hydrating_http"
                ) {
                    return;
                }
                this.hydrationAbort = null;
                this.failedHydration = null;
                this.drainHydrationTail(hydratedState, "hydrate");
            })
            .catch((error: unknown) => {
                if (
                    controller.signal.aborted ||
                    token !== this.hydrationToken ||
                    this.phase.kind !== "hydrating_http"
                ) {
                    return;
                }
                this.hydrationAbort = null;
                const message =
                    error instanceof Error && error.message !== "" ? error.message : "HTTP hydration failed.";
                if (this.reducer.recoverHydrationFailure !== undefined) {
                    const recovered = this.reducer.recoverHydrationFailure(this.state, descriptor, message);
                    const failedCursor = this.phase.targetCursor;
                    const resumed = this.drainHydrationTail(recovered, "phase");
                    if (resumed) {
                        this.failedHydration = { descriptor, cursor: failedCursor };
                    }
                    return;
                }
                const lastCursor = this.committedCursor;
                this.phase = { kind: "error", message, lastCursor };
                this.emit("phase");
            });
    }

    private runBackgroundHydrationRetry(descriptor: THydration, targetCursor: SyncCursor<D>): void {
        if (this.onHydrateHttp === undefined) {
            return;
        }
        this.hydrationToken += 1;
        this.hydrationAbort?.abort();
        const controller = new AbortController();
        this.hydrationAbort = controller;
        const token = this.hydrationToken;

        void this.onHydrateHttp(descriptor, {
            signal: controller.signal,
            currentState: this.state,
            getLatestState: () => this.state,
            targetCursor,
        })
            .then((hydratedState) => {
                if (controller.signal.aborted || token !== this.hydrationToken || this.phase.kind !== "live") {
                    return;
                }
                this.hydrationAbort = null;
                this.failedHydration = null;
                this.state = hydratedState;
                this.emit("hydrate");
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted || token !== this.hydrationToken || this.phase.kind !== "live") {
                    return;
                }
                this.hydrationAbort = null;
                const message =
                    error instanceof Error && error.message !== "" ? error.message : "HTTP hydration failed.";
                if (this.reducer.recoverHydrationFailure !== undefined) {
                    this.state = this.reducer.recoverHydrationFailure(this.state, descriptor, message);
                    this.emit("phase");
                }
            });
    }

    private drainHydrationTail(baseState: TState, source: "hydrate" | "phase"): boolean {
        if (this.phase.kind !== "hydrating_http") {
            return false;
        }
        if (this.phase.pendingOverflow) {
            this.enterResyncing("pending_overflow", null);
            return false;
        }

        let nextState = baseState;
        let cursor = this.phase.targetCursor;
        const pending = this.phase.pending;
        for (let index = 0; index < pending.length; index += 1) {
            const item = pending[index];
            if (item === undefined) {
                continue;
            }
            if (item.seq !== cursor.seq + 1) {
                this.enterResyncing("hydration_gap", null);
                return false;
            }
            const nextHydration = this.reducer.inspectDelta?.(item.payload, nextState) ?? null;
            if (nextHydration !== null) {
                const nextTarget: SyncCursor<D> = { epoch: cursor.epoch, seq: item.seq };
                this.state = nextState;
                this.phase = {
                    kind: "hydrating_http",
                    targetCursor: nextTarget,
                    committedCursor: cursor,
                    pending: pending.slice(index + 1),
                    pendingOverflow: false,
                };
                this.emit(source);
                this.startHydration(nextHydration, nextTarget);
                return false;
            }
            nextState = this.reducer.applyDelta(nextState, item.payload);
            cursor = { epoch: cursor.epoch, seq: item.seq };
        }

        this.state = nextState;
        this.phase = { kind: "live", cursor };
        this.emit(source);
        return true;
    }

    private cancelInFlightHydration(): void {
        this.hydrationToken += 1;
        this.hydrationAbort?.abort();
        this.hydrationAbort = null;
    }

    private clearFailedHydration(): void {
        this.failedHydration = null;
    }

    private emit(source: SyncStateChangeSource): void {
        this.onStateChange?.(this.state, {
            cursor: this.appliedCursor,
            phase: this.phase,
            source,
        });
    }
}
