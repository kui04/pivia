import { useEffect, useState } from "react";

/** How often the relative ages refresh: a half minute keeps a row from reading as stale. */
const TICK_MS = 30_000;

/**
 * Returns the current time in milliseconds and refreshes it on a slow timer.
 *
 * It only drives the relative ages, so the tick is coarse on purpose: a scan never runs because
 * of it, and a minute-granularity row cannot be off by more than half a tick.
 */
export function useNow(tickMs: number = TICK_MS): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = window.setInterval(() => {
            setNow(Date.now());
        }, tickMs);
        return () => {
            window.clearInterval(timer);
        };
    }, [tickMs]);

    return now;
}
