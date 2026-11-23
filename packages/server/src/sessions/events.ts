import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Streaming event type whose cumulative snapshots must not reach the wire. */
type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;

/** Wire shape of a `message_update` event derived directly from the SDK `JsonAgentSessionEvent`. */
type WireMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

function toWireAssistantMessageEvent(
    event: MessageUpdateEvent["assistantMessageEvent"],
): WireMessageUpdateEvent["assistantMessageEvent"] {
    if (event.type === "toolcall_start") {
        const toolCall = event.partial.content[event.contentIndex];
        if (toolCall?.type !== "toolCall") {
            throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
        }
        const { partial: _partial, ...deltaEvent } = event;
        void _partial;
        return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
    }
    if (!("partial" in event)) {
        return event;
    }
    const { partial: _partial, ...deltaEvent } = event;
    void _partial;
    return deltaEvent;
}

/**
 * Convert one SDK session event to its wire shape.
 *
 * `message_update` carries the complete accumulated assistant message and a `partial` snapshot on
 * every token. Sending those unchanged makes stream traffic quadratic in message length, so the
 * wire event keeps only the usage counters and the delta. `message_start` and `message_end` carry
 * the authoritative message around the delta sequence.
 *
 * Mirrors the SDK JSON/RPC contract because the package exports only the `JsonAgentSessionEvent`
 * type, not the transformer.
 *
 * @throws Error when a `message_update` event does not describe an assistant message or its
 * `toolcall_start` index does not point at a tool call.
 */
export function toWireSessionEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
    if (event.type !== "message_update") {
        return event;
    }
    if (event.message.role !== "assistant") {
        throw new Error("message_update message is not an assistant message");
    }
    return {
        type: "message_update",
        usage: event.message.usage,
        assistantMessageEvent: toWireAssistantMessageEvent(event.assistantMessageEvent),
    };
}
