import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { SessionStateSnapshot } from "@pivia/protocol";
import { useMemo, type ReactElement } from "react";

import { cn, Formatter } from "@/lib";
import { summarizeSessionStats, type SessionStatsSummary } from "@/stores/session";

import styles from "./SessionStatusBar.module.css";

/** Props of the compact status strip below the composer. */
export interface SessionStatusBarProps {
    readonly state: SessionStateSnapshot | null;
    readonly entries: readonly FileEntry[];
    readonly className?: string | undefined;
}

function formatThinking(level: SessionStateSnapshot["thinkingLevel"]): string {
    return level === "off" ? "thinking off" : level;
}

function modelLabel(state: SessionStateSnapshot): string {
    const model = state.model;
    const name = model === null ? "No model" : model.name.length > 0 ? model.name : model.id;
    const thinking = model?.reasoning === true ? ` • ${formatThinking(state.thinkingLevel)}` : "";
    const routed =
        state.routedModel === null
            ? ""
            : ` → ${state.routedModel.model.id}${
                  state.routedModel.thinkingLevel === undefined ? "" : ` • ${state.routedModel.thinkingLevel}`
              }`;
    return `${name}${thinking}${routed}`;
}

function statsParts(stats: SessionStatsSummary): string[] {
    const parts: string[] = [];
    if (stats.input > 0) {
        parts.push(`↑${Formatter.compactTokenCount(stats.input)}`);
    }
    if (stats.output > 0) {
        parts.push(`↓${Formatter.compactTokenCount(stats.output)}`);
    }
    if (stats.cacheRead > 0) {
        parts.push(`R${Formatter.compactTokenCount(stats.cacheRead)}`);
    }
    if (stats.cacheWrite > 0) {
        parts.push(`W${Formatter.compactTokenCount(stats.cacheWrite)}`);
    }
    if (stats.cacheHitRate !== null && (stats.cacheRead > 0 || stats.cacheWrite > 0)) {
        parts.push(`CH${stats.cacheHitRate.toFixed(1)}%`);
    }
    if (stats.cost > 0) {
        parts.push(`$${stats.cost.toFixed(3)}`);
    }
    return parts;
}

/**
 * Compact usage and model strip below the composer.
 *
 * The totals come from the synced entries because the SDK computes them the same way; the context
 * window and percentage come from the server snapshot because the SDK estimates them from the live
 * agent state. A percentage above 70 warns and above 90 reads as an error, matching `pi-tui`.
 */
export function SessionStatusBar({ state, entries, className }: SessionStatusBarProps): ReactElement | null {
    const stats = useMemo(() => summarizeSessionStats(entries), [entries]);

    if (state === null) {
        return null;
    }

    const contextUsage = state.contextUsage;
    const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
    const percent = contextUsage?.percent ?? null;
    const contextText =
        contextWindow === 0 && percent === null
            ? null
            : percent === null
              ? `?/${Formatter.compactTokenCount(contextWindow)}`
              : `${percent.toFixed(1)}%/${Formatter.compactTokenCount(contextWindow)}`;
    const contextTone = percent === null ? undefined : percent > 90 ? "error" : percent > 70 ? "warning" : undefined;
    const totals = statsParts(stats);

    return (
        <div role="group" aria-label="Session status" className={cn(styles.bar, className)}>
            <span className={styles.totals}>
                {totals.length > 0 ? `${totals.join(" ")} ` : "No usage yet "}
                {contextText === null ? null : (
                    <span className={styles.context} data-tone={contextTone}>
                        {contextText}
                        {state.autoCompactionEnabled ? " (auto)" : ""}
                    </span>
                )}
            </span>
            <span className={styles.model} title={modelLabel(state)}>
                {modelLabel(state)}
            </span>
        </div>
    );
}
