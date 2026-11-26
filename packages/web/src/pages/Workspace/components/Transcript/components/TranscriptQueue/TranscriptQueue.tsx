import type { ReactElement } from "react";

import { Button } from "@components";
import { cn } from "@/lib";

import bubbleStyles from "../UserMessage/Bubble.module.css";
import { type QueueKind, type QueuedEntry } from "./queue";
import styles from "./TranscriptQueue.module.css";

/** Props of {@link TranscriptQueue}. */
export type TranscriptQueueProps = {
    /** Visible queued entries in render order; the caller collects them with `collectQueuedEntries`. */
    readonly entries: readonly QueuedEntry[];
    /** Clears all queued steering and follow-up messages when invoked. */
    readonly onClearQueue?: (() => void) | undefined;
    /** Disables the clear button while a `clear_queue` command is in flight. */
    readonly clearing?: boolean | undefined;
    /** Optional class name on the outer list container. */
    readonly className?: string | undefined;
};

type QueueSection = {
    readonly kind: QueueKind;
    readonly label: string;
    readonly entries: readonly QueuedEntry[];
};

/**
 * Group consecutive entries of the same queue, keeping the order `collectQueuedEntries` produced.
 *
 * The label is read from the first entry of each group; the group renders it once as a badge on
 * its last bubble.
 */
function groupSections(entries: readonly QueuedEntry[]): readonly QueueSection[] {
    const sections: { kind: QueueKind; label: string; entries: QueuedEntry[] }[] = [];
    for (const entry of entries) {
        const last = sections.at(-1);
        if (last !== undefined && last.kind === entry.kind) {
            last.entries.push(entry);
            continue;
        }
        sections.push({ kind: entry.kind, label: entry.label, entries: [entry] });
    }
    return sections;
}

/**
 * Read-only grouped list of queued steering and follow-up prompts shown at the end of the
 * transcript.
 *
 * Uses the same right-aligned bubble geometry and multi-line wrapping as `UserMessage` so queued
 * inputs read naturally in the conversation column. One badge on the last bubble of each queue
 * names the group, so pending entries stay distinguishable from committed turns without repeating
 * a caption under every message.
 */
export function TranscriptQueue({
    entries,
    onClearQueue,
    clearing = false,
    className,
}: TranscriptQueueProps): ReactElement | null {
    if (entries.length === 0) {
        return null;
    }

    return (
        <div className={cn(styles.root, className)} role="group" aria-label="Queued messages">
            {groupSections(entries).map((section) => (
                <ul key={section.kind} className={styles.list} aria-label={section.label}>
                    {section.entries.map((entry, index) => (
                        <li key={`${section.kind}-${index}`} className={styles.item}>
                            <div className={cn(bubbleStyles.bubble, styles.queued)}>{entry.text}</div>
                            {index === section.entries.length - 1 ? (
                                <span className={styles.badge} aria-hidden="true">
                                    {section.label}
                                </span>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ))}
            {onClearQueue === undefined ? null : (
                <div className={styles.actions}>
                    <Button
                        type="button"
                        variant="secondary"
                        size="md"
                        radius="full"
                        disabled={clearing}
                        className={styles.clearButton}
                        onClick={onClearQueue}
                    >
                        {clearing ? "Clearing queue..." : "Clear queue"}
                    </Button>
                </div>
            )}
        </div>
    );
}
