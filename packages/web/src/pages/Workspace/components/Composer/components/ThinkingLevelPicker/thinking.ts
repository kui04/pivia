import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isRecord, isThinkingLevel } from "@pivia/protocol";

/** Boundary parser for the untrusted `data` payload returned by `get_available_thinking_levels`. */
export function parseAvailableThinkingLevelsData(data: unknown): readonly ThinkingLevel[] | null {
    if (!isRecord(data) || !Array.isArray(data.levels)) {
        return null;
    }
    const levels: ThinkingLevel[] = [];
    for (const item of data.levels) {
        if (!isThinkingLevel(item)) {
            return null;
        }
        levels.push(item);
    }
    return levels;
}
