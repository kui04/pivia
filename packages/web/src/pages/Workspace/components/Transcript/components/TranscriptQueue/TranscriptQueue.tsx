import { Clock } from "lucide-react";
import type { ReactElement } from "react";

import { Icon } from "@components";
import { cn } from "@/lib";

import { collectQueuedEntries, type TranscriptQueuedMessages } from "./queue";
import styles from "./TranscriptQueue.module.css";

/** Props of {@link TranscriptQueue}. */
export type TranscriptQueueProps = {
    /** Pending steering and follow-up messages waiting in the agent queue. */
    readonly queue: TranscriptQueuedMessages;
    /** Optional class name on the outer list container. */
    readonly className?: string | undefined;
};

/**
 * Read-only list of queued steering and follow-up prompts shown at the end of the transcript.
 *
 * Uses the same right-aligned bubble geometry and multi-line wrapping as `UserMessage` so queued
 * inputs read naturally in the conversation column, while pairing a dashed container bubble with a
 * subtle status caption to distinguish pending entries from committed turns.
 */
export function TranscriptQueue({ queue, className }: TranscriptQueueProps): ReactElement | null {
    const entries = collectQueuedEntries(queue);

    if (entries.length === 0) {
        return null;
    }

    return (
        <ul className={cn(styles.root, className)} aria-label="Queued messages">
            {entries.map((entry, index) => (
                <li key={`${entry.kind}-${index}`} className={styles.item}>
                    <div className={styles.bubble}>{entry.text}</div>
                    <div className={styles.meta} data-kind={entry.kind}>
                        <Icon size="no-container" glyphSize={12}>
                            <Clock strokeWidth={1.75} />
                        </Icon>
                        <span>{entry.label}</span>
                    </div>
                </li>
            ))}
        </ul>
    );
}
