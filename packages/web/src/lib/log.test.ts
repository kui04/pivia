import { afterEach, describe, expect, it, vi } from "vitest";

import { createLog, Log, type LogLevel } from "./log";

function fakeConsole(): Pick<Console, LogLevel> {
    return {
        trace: vi.fn<(message?: unknown, ...details: unknown[]) => void>(),
        debug: vi.fn<(message?: unknown, ...details: unknown[]) => void>(),
        info: vi.fn<(message?: unknown, ...details: unknown[]) => void>(),
        warn: vi.fn<(message?: unknown, ...details: unknown[]) => void>(),
        error: vi.fn<(message?: unknown, ...details: unknown[]) => void>(),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("createLog", () => {
    it("writes each level through the console method with the same name", () => {
        const sink = fakeConsole();
        const log = createLog({ console: sink, level: "trace" });

        log.trace("trace message");
        log.debug("debug message");
        log.info("info message");
        log.warn("warn message");
        log.error("error message");

        expect(sink.trace).toHaveBeenCalledExactlyOnceWith("[Pivia] trace message");
        expect(sink.debug).toHaveBeenCalledExactlyOnceWith("[Pivia] debug message");
        expect(sink.info).toHaveBeenCalledExactlyOnceWith("[Pivia] info message");
        expect(sink.warn).toHaveBeenCalledExactlyOnceWith("[Pivia] warn message");
        expect(sink.error).toHaveBeenCalledExactlyOnceWith("[Pivia] error message");
    });

    it("drops records below the configured level", () => {
        const sink = fakeConsole();
        const log = createLog({ console: sink, level: "warn" });

        log.trace("hidden trace");
        log.debug("hidden debug");
        log.info("hidden info");
        log.warn("shown warn");
        log.error("shown error");

        expect(sink.trace).not.toHaveBeenCalled();
        expect(sink.debug).not.toHaveBeenCalled();
        expect(sink.info).not.toHaveBeenCalled();
        expect(sink.warn).toHaveBeenCalledExactlyOnceWith("[Pivia] shown warn");
        expect(sink.error).toHaveBeenCalledExactlyOnceWith("[Pivia] shown error");
    });

    it("keeps debug records outside production by default", () => {
        const sink = fakeConsole();
        const log = createLog({ console: sink });

        log.trace("hidden trace");
        log.debug("shown debug");

        expect(sink.trace).not.toHaveBeenCalled();
        expect(sink.debug).toHaveBeenCalledExactlyOnceWith("[Pivia] shown debug");
    });

    it("passes details after the message in their original order", () => {
        const sink = fakeConsole();
        const log = createLog({ console: sink, level: "info" });
        const record = { sessionId: "abc" };

        log.info("session opened", record, 42);

        expect(sink.info).toHaveBeenCalledExactlyOnceWith("[Pivia] session opened", record, 42);
    });

    it("uses the global console when no sink is supplied", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        Log.warn("server unreachable");

        expect(warn).toHaveBeenCalledExactlyOnceWith("[Pivia] server unreachable");
    });
});
