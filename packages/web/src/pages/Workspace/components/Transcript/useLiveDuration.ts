import { useEffect, useState } from "react";

import type { TranscriptTiming } from "@/stores/session";

/**
 * Elapsed time between two wall-clock samples, clamped so a clock step never shows negative time.
 *
 * A clock that jumps backwards (NTP correction, a restored tab) must not make a running timer read
 * as negative.
 */
function elapsedSince(startedAtMs: number, sampledAtMs: number): number {
    return Math.max(0, sampledAtMs - startedAtMs);
}

type Sample = {
    readonly startedAtMs: number;
    readonly sampledAtMs: number;
};

/**
 * Drive a running timer for one transcript item.
 *
 * A static timing returns its final duration. A `since` timing samples the wall clock on the next
 * frame and then on an interval, so a turn that began before the view mounted shows its real
 * elapsed time instead of restarting at zero. The sample is bound to its start time, so a new run
 * never displays the previous run's elapsed value.
 *
 * @param timing - Final duration, or the start time of the running work.
 * @param tickMs - Sampling interval while the work runs.
 * @returns The duration in milliseconds, or null until the first sample of a running item exists.
 */
export function useLiveDuration(timing: TranscriptTiming, tickMs: number): number | null {
    const startedAtMs = timing.kind === "since" ? timing.startedAtMs : null;
    const [sample, setSample] = useState<Sample | null>(null);

    useEffect(() => {
        if (startedAtMs === null) {
            return;
        }

        let cancelled = false;
        const take = (): void => {
            if (!cancelled) {
                setSample({ startedAtMs, sampledAtMs: Date.now() });
            }
        };

        const frame = window.requestAnimationFrame(take);
        const timer = window.setInterval(take, tickMs);

        return () => {
            cancelled = true;
            window.cancelAnimationFrame(frame);
            window.clearInterval(timer);
        };
    }, [startedAtMs, tickMs]);

    if (timing.kind === "static") {
        return timing.durationMs;
    }
    if (sample === null || sample.startedAtMs !== startedAtMs) {
        return null;
    }
    return elapsedSince(sample.startedAtMs, sample.sampledAtMs);
}
