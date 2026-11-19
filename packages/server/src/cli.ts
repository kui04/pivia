#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { LevelWithSilent } from "pino";

import { buildApp } from "./app.ts";
import { generateStartupSecret, isLoopbackHost } from "./auth/service.ts";
import { createLogger, isLogLevel, LOG_LEVELS } from "./logger.ts";
import { SessionCatalog } from "./sessions/catalog.ts";

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
          readonly noAuth: boolean;
          readonly passwordFile: string | undefined;
          readonly sessionDir: string | undefined;
      };

/** Resolved startup authentication configuration. */
export type ResolvedAuthConfig =
    { readonly mode: "disabled" } | { readonly mode: "configured" | "generated"; readonly password: string };

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
        `  --host <addr>           Bind address (default: ${DEFAULT_HOST})`,
        `  -p, --port <port>       Listen port, 0-65535 (default: ${DEFAULT_PORT})`,
        "  --password-file <path>  Read single-line login password from file (overrides PIVIA_PASSWORD)",
        "  --session-dir <path>    Session directory to read (flat <path>/*.jsonl layout)",
        "  --no-auth               Disable authentication (loopback host only)",
        `  --log-level <lvl>       ${LOG_LEVELS.join(" | ")} (default: info)`,
        "  -h, --help              Show this help message",
        "",
        "Environment & Startup Auth:",
        "  PIVIA_PASSWORD          Login password when --password-file is not provided",
        "  If neither --password-file, PIVIA_PASSWORD, nor --no-auth is set,",
        "  a random startup password is generated and printed to stderr.",
        "",
        "Session Storage:",
        "  The session directory is resolved in this order: --session-dir, PI_CODING_AGENT_SESSION_DIR,",
        "  the pi sessionDir setting, then <PI_CODING_AGENT_DIR>/sessions, which groups sessions by",
        "  working directory. A leading ~/ in PI_CODING_AGENT_SESSION_DIR expands to the home",
        "  directory.",
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
                "password-file": { type: "string" },
                "session-dir": { type: "string" },
                "no-auth": { type: "boolean" },
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

    const noAuth = parsed.values["no-auth"] === true;
    const passwordFile = parsed.values["password-file"];
    if (noAuth && passwordFile !== undefined) {
        throw new CliArgumentError("Cannot combine --no-auth with --password-file.");
    }
    if (noAuth && !isLoopbackHost(host)) {
        throw new CliArgumentError("--no-auth is only permitted when binding a loopback address.");
    }

    const sessionDir = parsed.values["session-dir"];
    if (sessionDir !== undefined && sessionDir.trim() === "") {
        throw new CliArgumentError("--session-dir must not be empty.");
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
        noAuth,
        passwordFile,
        sessionDir,
    };
}

/**
 * Resolve the startup authentication configuration from CLI options and environment variables.
 */
export function resolveAuthConfig(
    action: Extract<CliAction, { kind: "serve" }>,
    env: Readonly<Record<string, string | undefined>>,
): ResolvedAuthConfig {
    if (action.noAuth) {
        if (env.PIVIA_PASSWORD !== undefined) {
            throw new CliArgumentError("Cannot combine --no-auth with PIVIA_PASSWORD.");
        }
        return { mode: "disabled" };
    }
    if (action.passwordFile !== undefined) {
        let content: string;
        try {
            content = readFileSync(action.passwordFile, "utf8");
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new CliArgumentError(`Failed to read password file "${action.passwordFile}": ${detail}`);
        }
        const stripped = content.replace(/[\r\n]+$/, "");
        if (stripped.includes("\n") || stripped.includes("\r")) {
            throw new CliArgumentError(`Password file "${action.passwordFile}" must contain a single line.`);
        }
        if (stripped.length === 0) {
            throw new CliArgumentError(`Password file "${action.passwordFile}" is empty.`);
        }
        return { mode: "configured", password: stripped };
    }
    const envPassword = env.PIVIA_PASSWORD;
    if (envPassword !== undefined) {
        if (envPassword.length === 0) {
            throw new CliArgumentError("PIVIA_PASSWORD must not be empty when set.");
        }
        return { mode: "configured", password: envPassword };
    }
    return { mode: "generated", password: generateStartupSecret() };
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
    let authResolution: ResolvedAuthConfig;
    try {
        action = parseCliArgs(argv);
        if (action.kind === "help") {
            process.stdout.write(formatHelp());
            return;
        }
        authResolution = resolveAuthConfig(action, process.env);
    } catch (error) {
        if (error instanceof CliArgumentError) {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 2;
            return;
        }
        throw error;
    }

    const logger = createLogger({ level: action.logLevel });
    const sessions = new SessionCatalog({ sessionDir: action.sessionDir, logger });
    const app = buildApp({
        version: readPackageVersion(),
        logger,
        sessions,
        auth: authResolution.mode === "disabled" ? { disabled: true } : { password: authResolution.password },
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
        if (authResolution.mode === "generated") {
            // Print directly to stderr so `--log-level warn|error|fatal|silent` never hides the only password,
            // and omit the secret itself from the structured logger stream.
            process.stderr.write(`pivia: generated startup password: ${authResolution.password}\n`);
        }
        logger.info({ address, authMode: authResolution.mode }, "pivia server listening");
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
