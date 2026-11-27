import { describe, expect, it } from "vitest";

import { makeSessionStateSnapshot } from "@/test/fixtures";

import { toComposerRuntimePhase } from "./types";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" } as const;

function state(overrides: Partial<Parameters<typeof makeSessionStateSnapshot>[0]> = {}) {
    return makeSessionStateSnapshot({ model: MODEL, ...overrides });
}

describe("toComposerRuntimePhase", () => {
    it("returns unavailable when disconnected or missing initial state", () => {
        expect(toComposerRuntimePhase(false, state(), "Session closed.")).toEqual({
            kind: "unavailable",
            reason: "Session closed.",
        });
        expect(toComposerRuntimePhase(true, null, "Connecting...")).toEqual({
            kind: "unavailable",
            reason: "Connecting...",
        });
    });

    it("projects connected state snapshot into ready phase", () => {
        const ready = state({ isStreaming: true });
        expect(toComposerRuntimePhase(true, ready, "")).toEqual({
            kind: "ready",
            isStreaming: true,
            model: ready.model,
            thinkingLevel: "medium",
        });
    });
});
