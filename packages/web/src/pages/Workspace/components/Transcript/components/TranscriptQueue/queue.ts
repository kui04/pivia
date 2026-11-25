import type { SessionStateSnapshot } from "@pivia/protocol";

/** Queued prompt slices read from {@link SessionStateSnapshot}. */
export type TranscriptQueuedMessages = Pick<SessionStateSnapshot, "steeringMessages" | "followUpMessages">;

export type QueueKind = "steering" | "followUp";

export type QueuedEntry = {
    readonly kind: QueueKind;
    readonly label: string;
    readonly text: string;
};

const QUEUE_SECTIONS: readonly {
    readonly kind: QueueKind;
    readonly label: string;
    readonly key: keyof TranscriptQueuedMessages;
}[] = [
    { kind: "steering", label: "Queued · Steering", key: "steeringMessages" },
    { kind: "followUp", label: "Queued · Follow-up", key: "followUpMessages" },
];

/** Collects non-blank queued prompts in render order (`steeringMessages` before `followUpMessages`). */
export function collectQueuedEntries(queue: TranscriptQueuedMessages): readonly QueuedEntry[] {
    const entries: QueuedEntry[] = [];
    for (const section of QUEUE_SECTIONS) {
        for (const raw of queue[section.key]) {
            if (raw.trim() !== "") {
                entries.push({ kind: section.kind, label: section.label, text: raw });
            }
        }
    }
    return entries;
}

/** Counts non-blank items in a single queued prompt slice so trailing blank entries are ignored. */
export function countVisibleQueueMessages(messages: readonly string[] | undefined): number {
    if (!messages) {
        return 0;
    }
    let count = 0;
    for (const raw of messages) {
        if (raw.trim() !== "") {
            count += 1;
        }
    }
    return count;
}

/**
 * Reports whether either queue contains at least one non-blank message that `TranscriptQueue`
 * renders, so parent views do not treat whitespace-only items as visible transcript activity.
 */
export function hasQueuedMessages(queue: TranscriptQueuedMessages): boolean {
    return collectQueuedEntries(queue).length > 0;
}
