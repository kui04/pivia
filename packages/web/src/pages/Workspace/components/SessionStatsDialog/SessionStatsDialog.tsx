import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { SessionStateSnapshot } from "@pivia/protocol";
import { useMemo, type ReactElement } from "react";

import { Button, Dialog, DialogActions, DialogDescription, DialogHeader, DialogTitle, Tabular } from "@components";
import { cn, Formatter } from "@/lib";
import { summarizeSessionStats, type SessionStatsSummary } from "@/stores/session";

import styles from "./SessionStatsDialog.module.css";

/** Props of the detailed session statistics dialog. */
export interface SessionStatsDialogProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly state: SessionStateSnapshot | null;
    readonly entries: readonly FileEntry[];
    readonly className?: string | undefined;
}

const EMPTY_STATS: SessionStatsSummary = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    cacheHitRate: null,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
};

function percentLabel(percent: number | null, contextWindow: number): string {
    if (percent === null) {
        return contextWindow === 0 ? "Unknown" : `Unknown of ${Formatter.compactTokenCount(contextWindow)}`;
    }
    return `${percent.toFixed(1)}% of ${Formatter.compactTokenCount(contextWindow)}`;
}

/**
 * Detailed token, cost, and message statistics for one session.
 *
 * The values are derived from the synced entries and the session snapshot, mirroring the SDK's
 * `getSessionStats()` without ever exposing the session file path.
 */
export function SessionStatsDialog({
    open,
    onOpenChange,
    state,
    entries,
    className,
}: SessionStatsDialogProps): ReactElement {
    const stats = useMemo(() => (open ? summarizeSessionStats(entries) : EMPTY_STATS), [entries, open]);
    const model = state?.model ?? null;
    const contextUsage = state?.contextUsage ?? null;
    const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange} className={cn(styles.popup, className)}>
            <DialogHeader>
                <DialogTitle>Session stats</DialogTitle>
                <DialogDescription>Usage and message counts for this session.</DialogDescription>
            </DialogHeader>
            <dl className={styles.facts}>
                <dt className={styles.term}>Session</dt>
                <dd className={styles.monoValue}>{state?.sessionId ?? "No session"}</dd>
                <dt className={styles.term}>Working directory</dt>
                <dd className={styles.monoValue}>{state?.cwd ?? "Unknown"}</dd>
                <dt className={styles.term}>Model</dt>
                <dd className={styles.value}>{model === null ? "No model" : model.name || model.id}</dd>
                <dt className={styles.term}>Context</dt>
                <dd className={styles.value}>
                    <Tabular>{percentLabel(contextUsage?.percent ?? null, contextWindow)}</Tabular>
                    {state?.autoCompactionEnabled === true ? " (auto compaction)" : ""}
                </dd>
                <dt className={styles.term}>Messages</dt>
                <dd className={styles.value}>
                    <Tabular>{String(stats.userMessages)}</Tabular> user,{" "}
                    <Tabular>{String(stats.assistantMessages)}</Tabular> assistant,{" "}
                    <Tabular>{String(stats.toolResults)}</Tabular> tool results,{" "}
                    <Tabular>{String(stats.totalMessages)}</Tabular> total
                </dd>
                <dt className={styles.term}>Tool calls</dt>
                <dd className={styles.value}>
                    <Tabular>{String(stats.toolCalls)}</Tabular>
                </dd>
                <dt className={styles.term}>Tokens</dt>
                <dd className={styles.value}>
                    <Tabular>{String(stats.input)}</Tabular> input, <Tabular>{String(stats.output)}</Tabular> output,{" "}
                    <Tabular>{String(stats.cacheRead)}</Tabular> cache read,{" "}
                    <Tabular>{String(stats.cacheWrite)}</Tabular> cache write
                </dd>
                <dt className={styles.term}>Cache hit rate</dt>
                <dd className={styles.value}>
                    <Tabular>{stats.cacheHitRate === null ? "Unknown" : `${stats.cacheHitRate.toFixed(1)}%`}</Tabular>
                </dd>
                <dt className={styles.term}>Cost</dt>
                <dd className={styles.value}>
                    <Tabular>${stats.cost.toFixed(4)}</Tabular>
                </dd>
            </dl>
            <DialogActions>
                <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                        onOpenChange(false);
                    }}
                >
                    Close
                </Button>
            </DialogActions>
        </Dialog>
    );
}
