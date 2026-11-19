import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { describe, expect, it } from "vitest";

import { SessionEventBuffer, toWireSessionEvent } from "./session-events.ts";

const USAGE = {
    input: 12,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ASSISTANT_MESSAGE = {
    role: "assistant",
    content: [{ type: "text", text: "CUMULATIVE-MESSAGE-MARKER" }],
    api: "fake",
    provider: "fake",
    model: "fake-model",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 1,
};

function asSessionEvent(value: unknown): AgentSessionEvent {
    return value as AgentSessionEvent;
}

function textDeltaEvent(): AgentSessionEvent {
    return asSessionEvent({
        type: "message_update",
        message: ASSISTANT_MESSAGE,
        assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Hello",
            partial: { ...ASSISTANT_MESSAGE, content: [{ type: "text", text: "Hello" }] },
        },
    });
}

describe("toWireSessionEvent", () => {
    it("strips cumulative message and partial snapshots from text deltas", () => {
        const wire = toWireSessionEvent(textDeltaEvent());

        expect(wire).toEqual({
            type: "message_update",
            usage: USAGE,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
        });
        expect("message" in wire).toBe(false);
        const serialized = JSON.stringify(wire);
        expect(serialized).not.toContain('"partial"');
        expect(serialized).not.toContain("CUMULATIVE-MESSAGE-MARKER");
    });

    it("keeps constant-size usage and all non-partial delta fields", () => {
        const wire = toWireSessionEvent(
            asSessionEvent({
                type: "message_update",
                message: ASSISTANT_MESSAGE,
                assistantMessageEvent: {
                    type: "text_end",
                    contentIndex: 0,
                    content: "Hello world",
                    partial: ASSISTANT_MESSAGE,
                },
            }),
        );

        if (wire.type !== "message_update") {
            throw new Error("expected a message_update event");
        }
        expect(wire.usage).toEqual(USAGE);
        expect(wire.assistantMessageEvent).toEqual({
            type: "text_end",
            contentIndex: 0,
            content: "Hello world",
        });
    });

    it("extracts the tool call id and name on toolcall_start", () => {
        const partial = {
            ...ASSISTANT_MESSAGE,
            content: [{ type: "toolCall", id: "call_123", name: "read", arguments: { path: "README.md" } }],
        };
        const wire = toWireSessionEvent(
            asSessionEvent({
                type: "message_update",
                message: { ...partial, content: [...partial.content] },
                assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
            }),
        );

        if (wire.type !== "message_update") {
            throw new Error("expected a message_update event");
        }
        expect(wire.assistantMessageEvent).toEqual({
            type: "toolcall_start",
            contentIndex: 0,
            id: "call_123",
            toolName: "read",
        });
        expect(JSON.stringify(wire)).not.toContain('"partial"');
    });

    it("passes other session events through unchanged", () => {
        const event = asSessionEvent({ type: "agent_start" });
        expect(toWireSessionEvent(event)).toBe(event);
    });

    it("rejects message updates that do not describe an assistant message", () => {
        const event = asSessionEvent({
            type: "message_update",
            message: { role: "user", content: "hi", timestamp: 1 },
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} },
        });

        expect(() => toWireSessionEvent(event)).toThrow("not an assistant message");
    });

    it("rejects toolcall_start indexes that do not point at a tool call", () => {
        const partial = { ...ASSISTANT_MESSAGE, content: [{ type: "text", text: "not a tool call" }] };
        const event = asSessionEvent({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
        });

        expect(() => toWireSessionEvent(event)).toThrow("is not a tool call");
    });
});

function event(type: "agent_start" | "agent_settled"): JsonAgentSessionEvent {
    if (type === "agent_start") {
        return { type: "agent_start" };
    }
    return { type: "agent_settled", aborted: false };
}

describe("SessionEventBuffer", () => {
    it("assigns monotonic sequence numbers starting at 1", () => {
        const buffer = new SessionEventBuffer();
        expect(buffer.currentSeq).toBe(0);
        expect(buffer.push(event("agent_start")).seq).toBe(1);
        expect(buffer.push(event("agent_settled")).seq).toBe(2);
        expect(buffer.currentSeq).toBe(2);
        expect(buffer.earliestSeq).toBe(1);
    });

    it("replays all events after 0 and an empty replay after the current sequence", () => {
        const buffer = new SessionEventBuffer();
        const first = buffer.push(event("agent_start"));
        const second = buffer.push(event("agent_settled"));

        const fromZero = buffer.since(0);
        expect(fromZero.kind).toBe("replay");
        if (fromZero.kind !== "replay") {
            throw new Error("expected a replay");
        }
        expect(fromZero.seq).toBe(2);
        expect(fromZero.events).toEqual([first, second]);

        const fromCurrent = buffer.since(2);
        expect(fromCurrent).toEqual({ kind: "replay", events: [], seq: 2 });

        const fromFirst = buffer.since(1);
        expect(fromFirst).toEqual({ kind: "replay", events: [second], seq: 2 });
    });

    it("requires a snapshot when no afterSeq is provided", () => {
        const buffer = new SessionEventBuffer();
        buffer.push(event("agent_start"));
        expect(buffer.since()).toEqual({ kind: "snapshot_required", seq: 1 });
    });

    it("falls back to a snapshot after the ring buffer evicted missing events", () => {
        const buffer = new SessionEventBuffer({ capacity: 2 });
        buffer.push(event("agent_start"));
        buffer.push(event("agent_settled"));
        buffer.push(event("agent_start"));

        expect(buffer.currentSeq).toBe(3);
        expect(buffer.earliestSeq).toBe(2);
        const replay = buffer.since(1);
        expect(replay.kind).toBe("replay");
        if (replay.kind === "replay") {
            expect(replay.events.map((entry) => entry.seq)).toEqual([2, 3]);
        }
        expect(buffer.since(0)).toEqual({ kind: "snapshot_required", seq: 3 });
    });

    it("requires a snapshot when a client sends a sequence newer than the server", () => {
        const restarted = new SessionEventBuffer();
        expect(restarted.since(5)).toEqual({ kind: "snapshot_required", seq: 0 });
        expect(restarted.since(0)).toEqual({ kind: "replay", events: [], seq: 0 });
    });

    it("treats negative and non-integer sequences as snapshot requests", () => {
        const buffer = new SessionEventBuffer();
        buffer.push(event("agent_start"));
        expect(buffer.since(-1)).toEqual({ kind: "snapshot_required", seq: 1 });
        expect(buffer.since(1.5)).toEqual({ kind: "snapshot_required", seq: 1 });
        expect(buffer.since(Number.NaN)).toEqual({ kind: "snapshot_required", seq: 1 });
    });

    it("rejects a capacity below one", () => {
        expect(() => new SessionEventBuffer({ capacity: 0 })).toThrow("positive integer");
        expect(() => new SessionEventBuffer({ capacity: 1.5 })).toThrow("positive integer");
    });
});
