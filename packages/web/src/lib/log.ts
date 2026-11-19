/** Console method names, ordered from the most to the least verbose. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogOptions = {
    /** Console-like destination. Defaults to the global console. */
    console?: Pick<Console, LogLevel>;
    /**
     * Lowest level that is written. Defaults to "debug" during development and
     * "info" in production, so production builds drop trace and debug records.
     */
    level?: LogLevel;
};

export type Log = {
    trace: (message: string, ...details: unknown[]) => void;
    debug: (message: string, ...details: unknown[]) => void;
    info: (message: string, ...details: unknown[]) => void;
    warn: (message: string, ...details: unknown[]) => void;
    error: (message: string, ...details: unknown[]) => void;
};

const LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];

const PREFIX = "[Pivia]";

function defaultLevel(): LogLevel {
    return import.meta.env.PROD ? "info" : "debug";
}

/**
 * Creates a log facade over a console-like sink. Application code calls the
 * exported `Log` instead of `console.*`, so one module owns the prefix, the
 * level threshold and the call site a future transport can replace.
 *
 * The sink and the level are injectable for tests and non-browser hosts.
 */
export function createLog(options: LogOptions = {}): Log {
    const sink = options.console ?? globalThis.console;
    const minimumIndex = LEVELS.indexOf(options.level ?? defaultLevel());

    const write = (level: LogLevel, message: string, details: unknown[]): void => {
        if (LEVELS.indexOf(level) < minimumIndex) {
            return;
        }

        sink[level](`${PREFIX} ${message}`, ...details);
    };

    return {
        trace: (message, ...details) => {
            write("trace", message, details);
        },
        debug: (message, ...details) => {
            write("debug", message, details);
        },
        info: (message, ...details) => {
            write("info", message, details);
        },
        warn: (message, ...details) => {
            write("warn", message, details);
        },
        error: (message, ...details) => {
            write("error", message, details);
        },
    };
}

/** The app-wide logger. Use this object wherever frontend code needs to log. */
export const Log: Log = createLog();
