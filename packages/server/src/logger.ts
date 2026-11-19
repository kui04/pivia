import { pino, type DestinationStream, type LevelWithSilent, type Logger } from "pino";

/** Log levels accepted by the server logger, ordered from most verbose to silent. */
export const LOG_LEVELS: readonly LevelWithSilent[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];

/** Options for {@link createLogger}. */
export interface CreateLoggerOptions {
    /** Minimum level emitted; defaults to `"info"`. */
    level?: LevelWithSilent | undefined;
    /** Output stream; defaults to `stderr` (fd 2) so `stdout` stays clean. */
    destination?: DestinationStream | undefined;
}

/** Returns true when `value` is a supported server log level. */
export function isLogLevel(value: string): value is LevelWithSilent {
    return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Create a structured Pino logger that writes to `stderr` by default.
 * Keeping logs off `stdout` leaves standard output unambiguous for CLI commands.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
    const level = options.level ?? "info";
    const destination = options.destination ?? pino.destination(2);
    return pino({ level }, destination);
}
