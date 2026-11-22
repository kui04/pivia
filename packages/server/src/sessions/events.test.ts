import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { describe, expect, it } from "vitest";

import { toWireSessionEvent } from "./events.ts";

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
