import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliArgumentError, formatHelp, parseCliArgs, resolveAuthConfig } from "./cli.ts";

describe("parseCliArgs", () => {
    it("returns default serve options when called with no arguments", () => {
        expect(parseCliArgs([])).toEqual({
            kind: "serve",
            host: "127.0.0.1",
            port: 3141,
            logLevel: "info",
            noAuth: false,
            passwordFile: undefined,
            sessionDir: undefined,
        });
    });

    it("accepts the serve subcommand and explicit flags", () => {
        expect(
            parseCliArgs([
                "serve",
                "--host",
                "0.0.0.0",
                "-p",
                "8080",
                "--password-file",
                "/tmp/pw",
                "--session-dir",
                "/tmp/sessions",
                "--log-level",
                "debug",
            ]),
        ).toEqual({
            kind: "serve",
            host: "0.0.0.0",
            port: 8080,
            logLevel: "debug",
            noAuth: false,
            passwordFile: "/tmp/pw",
            sessionDir: "/tmp/sessions",
        });
    });

    it("allows --no-auth on bindable loopback hosts only", () => {
        expect(parseCliArgs(["--no-auth"])).toEqual({
            kind: "serve",
            host: "127.0.0.1",
            port: 3141,
            logLevel: "info",
            noAuth: true,
            passwordFile: undefined,
            sessionDir: undefined,
        });
        expect(() => parseCliArgs(["--host", "[::1]", "--no-auth"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--host", "0.0.0.0", "--no-auth"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--no-auth", "--password-file", "/tmp/pw"])).toThrow(CliArgumentError);
    });

    it("returns help action for --help", () => {
        expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
        const help = formatHelp();
        expect(help).toContain("Usage: pivia [serve] [options]");
        expect(help).toContain("printed to stderr");
        expect(help).toContain("--session-dir <path>");
        expect(help).toContain("PI_CODING_AGENT_SESSION_DIR");
    });

    it("accepts --session-dir and rejects an empty value", () => {
        const action = parseCliArgs(["--session-dir", "~/pivia-sessions"]);
        expect(action).toMatchObject({ kind: "serve", sessionDir: "~/pivia-sessions" });
        expect(() => parseCliArgs(["--session-dir", "   "])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--session-dir"])).toThrow(CliArgumentError);
    });

    it("rejects invalid ports, log levels, and unknown commands", () => {
        expect(() => parseCliArgs(["--port", "70000"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--port", "abc"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--log-level", "loud"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["unknown"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--unknown"])).toThrow(CliArgumentError);
    });
});

describe("resolveAuthConfig", () => {
    const dirs: string[] = [];

    afterEach(() => {
        while (dirs.length > 0) {
            const dir = dirs.pop();
            if (dir !== undefined) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    function createTempFile(name: string, content: string): string {
        const dir = mkdtempSync(join(tmpdir(), "pivia-cli-test-"));
        dirs.push(dir);
        const filePath = join(dir, name);
        writeFileSync(filePath, content, "utf8");
        return filePath;
    }

    it("reads password-file, strips trailing line breaks, and overrides PIVIA_PASSWORD", () => {
        const filePath = createTempFile("pw", "my-secret\r\n\n");
        const action = parseCliArgs(["--password-file", filePath]);
        if (action.kind !== "serve") {
            throw new Error("expected serve action");
        }

        expect(resolveAuthConfig(action, { PIVIA_PASSWORD: "env-secret" })).toEqual({
            mode: "configured",
            password: "my-secret",
        });
    });

    it("rejects missing, empty, or multi-line password files", () => {
        const emptyPath = createTempFile("empty", "\r\n\n");
        const multiLinePath = createTempFile("multi", "line1\nline2\n");

        const missingAction = parseCliArgs(["--password-file", "/nonexistent/pivia/password"]);
        const emptyAction = parseCliArgs(["--password-file", emptyPath]);
        const multiAction = parseCliArgs(["--password-file", multiLinePath]);
        if (missingAction.kind !== "serve" || emptyAction.kind !== "serve" || multiAction.kind !== "serve") {
            throw new Error("expected serve actions");
        }

        expect(() => resolveAuthConfig(missingAction, {})).toThrow(CliArgumentError);
        expect(() => resolveAuthConfig(emptyAction, {})).toThrow(CliArgumentError);
        expect(() => resolveAuthConfig(multiAction, {})).toThrow(CliArgumentError);
    });

    it("uses PIVIA_PASSWORD when configured and rejects empty PIVIA_PASSWORD", () => {
        const action = parseCliArgs([]);
        if (action.kind !== "serve") {
            throw new Error("expected serve action");
        }

        expect(resolveAuthConfig(action, { PIVIA_PASSWORD: "from-env" })).toEqual({
            mode: "configured",
            password: "from-env",
        });
        expect(() => resolveAuthConfig(action, { PIVIA_PASSWORD: "" })).toThrow(CliArgumentError);
    });

    it("generates a startup secret when no password source or --no-auth is set", () => {
        const action = parseCliArgs([]);
        if (action.kind !== "serve") {
            throw new Error("expected serve action");
        }

        const resolved = resolveAuthConfig(action, {});
        expect(resolved.mode).toBe("generated");
        if (resolved.mode === "generated") {
            expect(resolved.password.length).toBeGreaterThanOrEqual(32);
        }
    });

    it("rejects combining --no-auth with PIVIA_PASSWORD even when empty", () => {
        const action = parseCliArgs(["--no-auth"]);
        if (action.kind !== "serve") {
            throw new Error("expected serve action");
        }

        expect(() => resolveAuthConfig(action, { PIVIA_PASSWORD: "secret" })).toThrow(CliArgumentError);
        expect(() => resolveAuthConfig(action, { PIVIA_PASSWORD: "" })).toThrow(CliArgumentError);
        expect(resolveAuthConfig(action, {})).toEqual({ mode: "disabled" });
    });
});
