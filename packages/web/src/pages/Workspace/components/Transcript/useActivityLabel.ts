import { useEffect, useState } from "react";

import type { SessionLiveActivity } from "@/stores/session/store";

/** Formats a {@link SessionLiveActivity} into its visible status label with an optional retry countdown. */
export function formatActivityLabel(activity: SessionLiveActivity, retryRemainingSeconds = 0): string | null {
    switch (activity.kind) {
        case "idle":
            return null;
        case "working":
            return "Working...";
        case "compacting":
            return activity.reason === "threshold" || activity.reason === "overflow"
                ? "Auto-compacting context..."
                : "Compacting context...";
        case "summarizingBranch":
            return "Summarizing branch...";
        case "retrying": {
            const prefix = `Retrying (${activity.attempt}/${activity.maxAttempts})`;
            return retryRemainingSeconds > 0 ? `${prefix} in ${retryRemainingSeconds}s...` : `${prefix}...`;
        }
    }
}

/**
 * Returns the live status label for a {@link SessionLiveActivity} and ticks retry delay countdowns once
 * per second while a retry wait is active.
 */
export function useActivityLabel(activity: SessionLiveActivity): string | null {
    const retryKey =
        activity.kind === "retrying"
            ? `${activity.scope}:${activity.attempt}:${activity.maxAttempts}:${activity.delayMs}`
            : null;
    const initialSeconds = activity.kind === "retrying" ? Math.max(0, Math.ceil(activity.delayMs / 1000)) : 0;

    const [countdown, setCountdown] = useState<{ readonly key: string | null; readonly seconds: number }>({
        key: retryKey,
        seconds: initialSeconds,
    });

    const activeSeconds = countdown.key === retryKey ? countdown.seconds : initialSeconds;

    useEffect(() => {
        if (retryKey === null) {
            let active = true;
            queueMicrotask(() => {
                if (active) {
                    setCountdown((prev) => (prev.key === null ? prev : { key: null, seconds: 0 }));
                }
            });
            return () => {
                active = false;
            };
        }
        if (initialSeconds <= 0) {
            return;
        }
        const intervalId = setInterval(() => {
            setCountdown((prev) => {
                const current = prev.key === retryKey ? prev.seconds : initialSeconds;
                if (current <= 1) {
                    clearInterval(intervalId);
                }
                return current <= 0 ? prev : { key: retryKey, seconds: current - 1 };
            });
        }, 1000);
        return () => clearInterval(intervalId);
    }, [initialSeconds, retryKey]);

    return formatActivityLabel(activity, activeSeconds);
}
