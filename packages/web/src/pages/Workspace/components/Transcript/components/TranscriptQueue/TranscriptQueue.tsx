import { Clock } from "lucide-react";
import type { ReactElement } from "react";

import { Icon } from "@components";
import { cn } from "@/lib";

import bubbleStyles from "../UserMessage/Bubble.module.css";
import { type QueuedEntry } from "./queue";
import styles from "./TranscriptQueue.module.css";

/** Props of {@link TranscriptQueue}. */
export type TranscriptQueueProps = {
    /** Visible queued entries in render order; the caller collects them with `collectQueuedEntries`. */
    readonly entries: readonly QueuedEntry[];
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
export function TranscriptQueue({ entries, className }: TranscriptQueueProps): ReactElement | null {
    if (entries.length === 0) {
        return null;
    }

    return (
        <ul className={cn(styles.root, className)} aria-label="Queued messages">
            {entries.map((entry, index) => (
                <li key={`${entry.kind}-${index}`} className={styles.item}>
                    <div className={cn(bubbleStyles.bubble, styles.queued)}>{entry.text}</div>
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
