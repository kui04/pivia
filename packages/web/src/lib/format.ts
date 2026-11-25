const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

function readNonNegativeFinite(value: number): number | null {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Formats an elapsed time from milliseconds: `12ms` below one second, `1.4s` below one minute,
 * then `1m 1s` and `1h 5m 3s`. Zero seconds are dropped above a minute.
 *
 * Negative and non-finite input reads as zero so a broken clock never prints NaN into the view.
 */
function formatDuration(durationMs: number): string {
    const safeMs = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
    const roundedMs = Math.round(safeMs);
    if (roundedMs < 1_000) {
        return `${roundedMs}ms`;
    }
    const tenths = Math.round(safeMs / 100);
    if (tenths < 600) {
        return `${(tenths / 10).toFixed(1)}s`;
    }
    const totalSeconds = Math.round(tenths / 10);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    const base = hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
    return seconds === 0 ? base : `${base} ${seconds}s`;
}

/** Formats a byte count using the same IEC units as `pi-coding-agent` (`B`, `KB`, `MB`). */
function formatByteSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "0B";
    }
    if (bytes < 1024) {
        return `${bytes}B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Formats USD cost using two decimals, or two significant digits for fractions of a cent. */
function formatUsdCost(cost: number): string {
    const safe = readNonNegativeFinite(cost) ?? 0;
    return `$${safe >= 0.01 ? safe.toFixed(2) : safe.toPrecision(2)}`;
}

/** Formats a token count with compact `k`/`M` suffixes matching `pi-coding-agent` footer output. */
function formatCompactTokenCount(count: number): string {
    const safeCount = readNonNegativeFinite(count) ?? 0;
    if (safeCount < 1_000) {
        return Math.round(safeCount).toString();
    }
    if (safeCount < 10_000) {
        return `${(safeCount / 1_000).toFixed(1)}k`;
    }
    if (safeCount < 1_000_000) {
        return `${Math.round(safeCount / 1_000)}k`;
    }
    if (safeCount < 10_000_000) {
        return `${(safeCount / 1_000_000).toFixed(1)}M`;
    }
    return `${Math.round(safeCount / 1_000_000)}M`;
}

/** Formats a compact relative age (`now`, `5m`, `2h`, `3d`, `2w`, `1y`). */
function formatRelativeAge(timestampMs: number, nowMs: number): string {
    const deltaMs = Math.max(0, nowMs - timestampMs);
    if (deltaMs < MINUTE_MS) {
        return "now";
    }
    if (deltaMs < HOUR_MS) {
        return `${String(Math.floor(deltaMs / MINUTE_MS))}m`;
    }
    if (deltaMs < DAY_MS) {
        return `${String(Math.floor(deltaMs / HOUR_MS))}h`;
    }
    if (deltaMs < WEEK_MS) {
        return `${String(Math.floor(deltaMs / DAY_MS))}d`;
    }
    if (deltaMs < YEAR_MS) {
        return `${String(Math.floor(deltaMs / WEEK_MS))}w`;
    }
    return `${String(Math.floor(deltaMs / YEAR_MS))}y`;
}

/** Display formatters shared by components and stores. */
export type Formatter = {
    /** Formats an elapsed time from milliseconds; see the private implementation for the tiers. */
    duration(durationMs: number): string;
    /** Formats a byte count with IEC units. */
    byteSize(bytes: number): string;
    /** Formats a USD cost with cents or two significant digits. */
    usdCost(cost: number): string;
    /** Formats a token count with compact `k`/`M` suffixes. */
    compactTokenCount(count: number): string;
    /** Formats a compact relative age. */
    relativeAge(timestampMs: number, nowMs: number): string;
};

/** The app-wide display formatters. */
export const Formatter: Formatter = {
    duration: formatDuration,
    byteSize: formatByteSize,
    usdCost: formatUsdCost,
    compactTokenCount: formatCompactTokenCount,
    relativeAge: formatRelativeAge,
};
