import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { SequencedSessionEvent } from "@pivia/protocol";

/** Streaming event type whose cumulative snapshots must not reach the wire. */
type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;

type AssistantMessageOf<T> = Extract<T, { role: "assistant" }>;

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type WireAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
    ? WithoutPartial<T> & { id: string; toolName: string }
    : WithoutPartial<T>;

type WireMessageUpdateEvent = {
    type: "message_update";
    usage: AssistantMessageOf<MessageUpdateEvent["message"]>["usage"];
    assistantMessageEvent: WireAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
};

/** Default number of session events kept for incremental reconnect replay. */
export const DEFAULT_SESSION_EVENT_BUFFER_CAPACITY = 512;

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

/** Result of a replay request against {@link SessionEventBuffer}. */
export type SessionEventReplay =
    | { readonly kind: "replay"; readonly events: readonly SequencedSessionEvent[]; readonly seq: number }
    | { readonly kind: "snapshot_required"; readonly seq: number };

/** Options for {@link SessionEventBuffer}. */
export interface SessionEventBufferOptions {
    /** Number of events kept for replay, at least 1. Defaults to 512. */
    readonly capacity?: number | undefined;
}

/**
 * Bounded ring buffer of wire events with monotonic sequence numbers.
 *
 * A client that reconnects with `afterSeq` can resume from the buffer only while every missing
 * event is still retained. Older requests fall back to a full snapshot, which is also the only
 * safe answer when the server restarted and sequence numbers restarted with it.
 */
export class SessionEventBuffer {
    private readonly capacity: number;
    private readonly events: Array<SequencedSessionEvent | undefined>;
    private head = 0;
    private size = 0;
    private nextSeq = 1;

    constructor(options: SessionEventBufferOptions = {}) {
        const capacity = options.capacity ?? DEFAULT_SESSION_EVENT_BUFFER_CAPACITY;
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new Error("Session event buffer capacity must be a positive integer.");
        }
        this.capacity = capacity;
        this.events = new Array<SequencedSessionEvent | undefined>(capacity).fill(undefined);
    }

    /** Sequence number of the newest pushed event, or 0 before the first event. */
    get currentSeq(): number {
        return this.nextSeq - 1;
    }

    /** Sequence number of the oldest retained event; `currentSeq + 1` while the buffer is empty. */
    get earliestSeq(): number {
        return this.size === 0 ? this.nextSeq : (this.events[this.head]?.seq ?? this.nextSeq);
    }

    /** Assign the next sequence number, store the event, and evict the oldest event when full. */
    push(event: JsonAgentSessionEvent): SequencedSessionEvent {
        const sequenced: SequencedSessionEvent = { seq: this.nextSeq, event };
        this.nextSeq += 1;
        if (this.size < this.capacity) {
            this.events[(this.head + this.size) % this.capacity] = sequenced;
            this.size += 1;
        } else {
            this.events[this.head] = sequenced;
            this.head = (this.head + 1) % this.capacity;
        }
        return sequenced;
    }

    /**
     * Return the events after `afterSeq`, or ask for a snapshot when the request is outside the
     * retained range. `afterSeq === currentSeq` yields an empty replay so an up-to-date client can
     * reconnect without resending state.
     */
    since(afterSeq?: number): SessionEventReplay {
        const seq = this.currentSeq;
        if (afterSeq === undefined || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
            return { kind: "snapshot_required", seq };
        }
        if (afterSeq > seq || afterSeq < this.earliestSeq - 1) {
            return { kind: "snapshot_required", seq };
        }
        const events: SequencedSessionEvent[] = [];
        for (let index = 0; index < this.size; index += 1) {
            const entry = this.events[(this.head + index) % this.capacity];
            if (entry !== undefined && entry.seq > afterSeq) {
                events.push(entry);
            }
        }
        return { kind: "replay", events, seq };
    }
}
