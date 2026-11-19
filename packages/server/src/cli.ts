#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { LevelWithSilent } from "pino";

import { buildApp } from "./app.ts";
import { createLogger, isLogLevel, LOG_LEVELS } from "./logger.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3141;

/** Parsed CLI action. */
export type CliAction =
    | { readonly kind: "help" }
    | {
          readonly kind: "serve";
          readonly host: string;
          readonly port: number;
          readonly logLevel: LevelWithSilent;
      };

/** Raised when CLI arguments fail validation. */
export class CliArgumentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CliArgumentError";
    }
}

/**
 * Format the CLI usage text.
 */
export function formatHelp(): string {
    return [
        "Usage: pivia [serve] [options]",
        "",
        "Options:",
        `  --host <addr>       Bind address (default: ${DEFAULT_HOST})`,
        `  -p, --port <port>   Listen port, 0-65535 (default: ${DEFAULT_PORT})`,
        `  --log-level <lvl>   ${LOG_LEVELS.join(" | ")} (default: info)`,
        "  -h, --help          Show this help message",
        "",
    ].join("\n");
}

function parsePort(raw: string): number {
    if (!/^\d+$/.test(raw)) {
        throw new CliArgumentError(`Invalid port "${raw}": expected an integer between 0 and 65535.`);
    }
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new CliArgumentError(`Invalid port "${raw}": expected an integer between 0 and 65535.`);
    }
    return port;
}

/**
 * Parse and validate CLI arguments without performing I/O.
 * Throws {@link CliArgumentError} on unknown options, subcommands, or invalid values.
 */
export function parseCliArgs(argv: readonly string[]): CliAction {
    let parsed;
    try {
        parsed = parseArgs({
            args: [...argv],
            allowPositionals: true,
            strict: true,
            options: {
                host: { type: "string" },
                port: { type: "string", short: "p" },
                "log-level": { type: "string" },
                help: { type: "boolean", short: "h" },
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliArgumentError(message);
    }

    if (parsed.values.help) {
        return { kind: "help" };
    }

    if (parsed.positionals.length > 1) {
        throw new CliArgumentError(`Unexpected arguments: ${parsed.positionals.join(" ")}`);
    }

    const command = parsed.positionals[0];
    if (command !== undefined && command !== "serve") {
        throw new CliArgumentError(`Unknown command "${command}". Use "pivia serve" or "pivia --help".`);
    }

    const host = parsed.values.host ?? DEFAULT_HOST;
    if (host.trim() === "") {
        throw new CliArgumentError("Host address must not be empty.");
    }

    const port = parsed.values.port !== undefined ? parsePort(parsed.values.port) : DEFAULT_PORT;

    const rawLevel = parsed.values["log-level"] ?? "info";
    if (!isLogLevel(rawLevel)) {
        throw new CliArgumentError(`Invalid log level "${rawLevel}". Expected one of: ${LOG_LEVELS.join(", ")}.`);
    }

    return {
        kind: "serve",
        host,
        port,
        logLevel: rawLevel,
    };
}

function readPackageVersion(): string {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
        return parsed.version;
    }
    return "0.0.0";
}

async function runCli(argv: readonly string[]): Promise<void> {
    let action: CliAction;
    try {
        action = parseCliArgs(argv);
    } catch (error) {
        if (error instanceof CliArgumentError) {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 2;
            return;
        }
        throw error;
    }

    if (action.kind === "help") {
        process.stdout.write(formatHelp());
        return;
    }

    const logger = createLogger({ level: action.logLevel });
    const app = buildApp({
        version: readPackageVersion(),
        logger,
    });

    let closing = false;
    const shutdown = (signal: NodeJS.Signals) => {
        if (closing) {
            return;
        }
        closing = true;
        logger.info({ signal }, "shutting down server");
        void app.close().then(
            () => {
                process.exitCode = 0;
            },
            (err: unknown) => {
                logger.error({ err }, "failed to close server cleanly");
                process.exitCode = 1;
            },
        );
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    try {
        const address = await app.listen({ host: action.host, port: action.port });
        logger.info({ address }, "pivia server listening");
    } catch (err) {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        logger.error({ err }, "failed to start server");
        process.exitCode = 1;
    }
}

function isMainEntry(): boolean {
    const entry = process.argv[1];
    if (entry === undefined) {
        return false;
    }
    try {
        // Resolve symlinks so `node_modules/.bin/pivia` still matches `dist/cli.js`.
        return realpathSync(entry) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isMainEntry()) {
    void runCli(process.argv.slice(2));
}
