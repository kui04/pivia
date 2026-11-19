import { describe, expect, it } from "vitest";

import { CliArgumentError, formatHelp, parseCliArgs } from "./cli.ts";

describe("parseCliArgs", () => {
    it("returns default serve options when called with no arguments", () => {
        expect(parseCliArgs([])).toEqual({
            kind: "serve",
            host: "127.0.0.1",
            port: 3141,
            logLevel: "info",
        });
    });

    it("accepts the serve subcommand and explicit flags", () => {
        expect(parseCliArgs(["serve", "--host", "0.0.0.0", "-p", "8080", "--log-level", "debug"])).toEqual({
            kind: "serve",
            host: "0.0.0.0",
            port: 8080,
            logLevel: "debug",
        });
    });

    it("returns help action for --help", () => {
        expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
        expect(formatHelp()).toContain("Usage: pivia [serve] [options]");
    });

    it("rejects invalid ports, log levels, and unknown commands", () => {
        expect(() => parseCliArgs(["--port", "70000"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--port", "abc"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--log-level", "loud"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["unknown"])).toThrow(CliArgumentError);
        expect(() => parseCliArgs(["--unknown"])).toThrow(CliArgumentError);
    });
});
