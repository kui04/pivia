import { parseSessionId, type SessionStateSnapshot } from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import { toComposerRuntimePhase } from "./types";

function makeState(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
    const sessionId = parseSessionId("session-1");
    if (sessionId === null) {
        throw new Error("Invalid session id");
    }
    return {
        sessionId,
        cwd: "/repo/pivia",
        name: "Task",
        model: { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 2,
        steeringMessages: [],
        followUpMessages: [],
        ...overrides,
    };
}

describe("toComposerRuntimePhase", () => {
    it("returns unavailable when disconnected or missing initial state", () => {
        expect(toComposerRuntimePhase(false, makeState(), "Session closed.")).toEqual({
            kind: "unavailable",
            reason: "Session closed.",
        });
        expect(toComposerRuntimePhase(true, null, "Connecting...")).toEqual({
            kind: "unavailable",
            reason: "Connecting...",
        });
    });

    it("projects connected state snapshot into ready phase", () => {
        const state = makeState({
            isStreaming: true,
            isCompacting: false,
            steeringMessages: ["steer-1"],
            followUpMessages: ["follow-1", "follow-2"],
        });
        expect(toComposerRuntimePhase(true, state, "")).toEqual({
            kind: "ready",
            isStreaming: true,
            isCompacting: false,
            model: state.model,
            thinkingLevel: "medium",
            queuedCount: 3,
            sessionName: "Task",
        });
    });
});
