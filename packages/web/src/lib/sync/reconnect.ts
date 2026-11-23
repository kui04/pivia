import type { AuthStatusResponse, SyncResyncReason } from "@pivia/protocol";

/** Default exponential backoff intervals (ms) between reconnect or repeated resync attempts. */
export const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** Default consecutive transport closes before probing `/api/auth/status`. */
export const DEFAULT_AUTH_PROBE_THRESHOLD = 2;

/** Options for {@link createReconnectController}. */
export interface ReconnectControllerOptions {
    readonly delaysMs?: readonly number[] | undefined;
    /** Maximum consecutive reconnect attempts before giving up. Defaults to `Infinity`. */
    readonly maxAttempts?: number | undefined;
    /** Consecutive closes before calling `authProbe`. Defaults to `2`. */
    readonly authProbeFailureThreshold?: number | undefined;
    /** Optional auth status probe called after repeated close failures. */
    readonly authProbe?: (() => Promise<AuthStatusResponse>) | undefined;
    readonly onUnauthorized?: (() => void) | undefined;
    /** Invoked when a reconnect or resync timer fires to open/re-open the transport. */
    readonly onReconnect: (attempt: number) => void;
    /** Invoked when a reconnect attempt is scheduled with backoff. */
    readonly onScheduled?: ((attempt: number, delayMs: number) => void) | undefined;
    /** Invoked when `maxAttempts` is reached without a successful handshake. */
    readonly onExhausted?: (() => void) | undefined;
    /** Optional clock override for testing resync cooldown backoff. */
    readonly nowMs?: (() => number) | undefined;
    /** Register `visibilitychange` / `online` browser listeners while started. Defaults to `true`. */
    readonly listenBrowserEvents?: boolean | undefined;
}

/** Shared WebSocket reconnection and resync storm-protection controller. */
export interface ReconnectController {
    start(): void;
    stop(): void;
    /** Notify controller that a transport handshake succeeded, resetting failure counters. */
    markConnected(): void;
    /** Notify controller that the transport closed unexpectedly and schedule a backoff retry. */
    notifyClosed(): void;
    /**
     * Request a single-flight resynchronization for `reason`.
     *
     * The first resync after steady state fires immediately; repeated resyncs inside the cooldown
     * window back off exponentially to avoid server snapshot storms.
     */
    scheduleResync(reason: SyncResyncReason): void;
    /** Immediately trigger a reconnect when disconnected (used on visibility/online wake or retry). */
    wake(): void;
    handleVisibilityChange(visible: boolean): void;
    handleOnline(): void;
}

/** Create a lifecycle-safe reconnection controller with backoff, browser wakeups, and auth probing. */
export function createReconnectController(options: ReconnectControllerOptions): ReconnectController {
    const delays = options.delaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    const authThreshold = Math.max(1, options.authProbeFailureThreshold ?? DEFAULT_AUTH_PROBE_THRESHOLD);
    const nowMs = options.nowMs ?? (() => Date.now());
    const listenBrowserEvents = options.listenBrowserEvents ?? true;

    let started = false;
    let stopped = false;
    let attempt = 0;
    let consecutiveCloseFailures = 0;
    let resyncAttempt = 0;
    let lastResyncMs = 0;
    let probingAuth = false;
    let probeSeq = 0;
    let scheduleSeq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resyncInFlight = false;
    let detachListeners: (() => void) | undefined;

    const clearTimer = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const delayForAttempt = (index: number): number => {
        if (delays.length === 0) {
            return 1_000;
        }
        return delays[Math.min(Math.max(0, index), delays.length - 1)] ?? 1_000;
    };

    const scheduleTimer = (delayMs: number, nextAttempt: number): void => {
        if (stopped || timer !== undefined) {
            return;
        }
        options.onScheduled?.(nextAttempt, delayMs);
        timer = setTimeout(() => {
            timer = undefined;
            if (stopped) {
                return;
            }
            options.onReconnect(nextAttempt);
        }, delayMs);
    };

    const scheduleReconnectAttempt = (): void => {
        if (stopped || timer !== undefined) {
            return;
        }
        if (attempt >= maxAttempts) {
            options.onExhausted?.();
            return;
        }
        attempt += 1;
        scheduleTimer(delayForAttempt(attempt - 1), attempt);
    };

    const bindBrowserListeners = (): void => {
        if (!listenBrowserEvents || detachListeners !== undefined) {
            return;
        }
        const doc = typeof document !== "undefined" ? document : undefined;
        const win = typeof window !== "undefined" ? window : undefined;

        const onVisibility = (): void => {
            if (doc !== undefined) {
                controller.handleVisibilityChange(doc.visibilityState === "visible");
            }
        };
        const onOnline = (): void => {
            controller.handleOnline();
        };

        doc?.addEventListener("visibilitychange", onVisibility);
        win?.addEventListener("online", onOnline);
        detachListeners = () => {
            doc?.removeEventListener("visibilitychange", onVisibility);
            win?.removeEventListener("online", onOnline);
            detachListeners = undefined;
        };
    };

    const controller: ReconnectController = {
        start() {
            started = true;
            stopped = false;
            consecutiveCloseFailures = 0;
            attempt = 0;
            resyncAttempt = 0;
            resyncInFlight = false;
            probingAuth = false;
            probeSeq += 1;
            scheduleSeq += 1;
            clearTimer();
            bindBrowserListeners();
        },
        stop() {
            stopped = true;
            started = false;
            probingAuth = false;
            probeSeq += 1;
            scheduleSeq += 1;
            resyncInFlight = false;
            clearTimer();
            detachListeners?.();
        },
        markConnected() {
            attempt = 0;
            consecutiveCloseFailures = 0;
            resyncInFlight = false;
            probingAuth = false;
            probeSeq += 1;
            scheduleSeq += 1;
            clearTimer();
        },
        notifyClosed() {
            if (stopped || !started) {
                return;
            }
            resyncInFlight = false;
            consecutiveCloseFailures += 1;
            const { authProbe } = options;
            if (authProbe !== undefined && consecutiveCloseFailures >= authThreshold) {
                if (probingAuth) {
                    return;
                }
                probingAuth = true;
                const activeProbe = ++probeSeq;
                void authProbe()
                    .then((status) => {
                        if (stopped || !started || activeProbe !== probeSeq) {
                            return;
                        }
                        probingAuth = false;
                        if (status.authRequired && !status.authenticated) {
                            controller.stop();
                            options.onUnauthorized?.();
                            return;
                        }
                        scheduleReconnectAttempt();
                    })
                    .catch(() => {
                        if (stopped || !started || activeProbe !== probeSeq) {
                            return;
                        }
                        probingAuth = false;
                        scheduleReconnectAttempt();
                    });
                return;
            }
            scheduleReconnectAttempt();
        },
        scheduleResync() {
            if (stopped || !started || resyncInFlight) {
                return;
            }
            resyncInFlight = true;
            clearTimer();
            const now = nowMs();
            const cooldownWindowMs = delayForAttempt(delays.length - 1);
            if (lastResyncMs === 0 || now - lastResyncMs > cooldownWindowMs) {
                resyncAttempt = 0;
            } else {
                resyncAttempt += 1;
            }
            lastResyncMs = now;
            const delayMs = resyncAttempt === 0 ? 0 : delayForAttempt(resyncAttempt - 1);
            if (delayMs === 0) {
                const ticket = ++scheduleSeq;
                queueMicrotask(() => {
                    if (!stopped && started && ticket === scheduleSeq) {
                        options.onReconnect(attempt);
                    }
                });
                return;
            }
            scheduleTimer(delayMs, attempt);
        },
        wake() {
            if (stopped || !started) {
                return;
            }
            clearTimer();
            probingAuth = false;
            probeSeq += 1;
            scheduleSeq += 1;
            resyncInFlight = false;
            attempt = 0;
            options.onReconnect(0);
        },
        handleVisibilityChange(visible: boolean) {
            if (visible && !stopped && started && (timer !== undefined || probingAuth)) {
                controller.wake();
            }
        },
        handleOnline() {
            if (!stopped && started && (timer !== undefined || probingAuth)) {
                controller.wake();
            }
        },
    };

    return controller;
}
