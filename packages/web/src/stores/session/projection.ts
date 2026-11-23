import type {
    CompactionEntry,
    ContextEditableContent,
    ContextEditEntry,
    FileEntry,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * Browser-safe transcript projection produced from raw `FileEntry[]`.
 *
 * Mirrors the active-branch, compaction, and `context_edit` rules of the SDK `SessionManager`
 * without importing Node-only modules (`node:fs`, `readline`).
 */
export type ProjectedTranscriptItem =
    | {
          readonly kind: "entry";
          readonly entry: SessionEntry;
          /** Content replacement applied by the latest `context_edit` targeting `entry.id`. */
          readonly editedContent?: ContextEditableContent | undefined;
      }
    | {
          readonly kind: "compaction";
          readonly entry: CompactionEntry;
      };

/** Options controlling how {@link projectSessionTranscript} walks the entry tree. */
export interface ProjectTranscriptOptions {
    /**
     * Explicit tip entry id to project. Omit to use the last entry; pass `null` to project an
     * empty branch.
     */
    readonly leafId?: string | null | undefined;
}

function buildEntryPath(
    sessionEntries: readonly SessionEntry[],
    byId: ReadonlyMap<string, SessionEntry>,
    leafIdOption: string | null | undefined,
): readonly SessionEntry[] {
    if (leafIdOption === null) {
        return [];
    }
    const leaf = (leafIdOption !== undefined ? byId.get(leafIdOption) : undefined) ?? sessionEntries.at(-1);
    if (leaf === undefined) {
        return [];
    }
    const reversed: SessionEntry[] = [];
    const visited = new Set<string>();
    let current: SessionEntry | undefined = leaf;
    while (current !== undefined && !visited.has(current.id)) {
        visited.add(current.id);
        reversed.push(current);
        current = current.parentId !== null ? byId.get(current.parentId) : undefined;
    }
    reversed.reverse();
    return reversed;
}

/**
 * Report whether a `context_edit` can change this entry.
 *
 * `projectContextEntry` rewrites only user, assistant, toolResult and custom messages; an edit that
 * targets any other entry leaves the model context unchanged.
 */
function isContextEditable(entry: SessionEntry): boolean {
    if (entry.type === "custom_message") {
        return true;
    }
    if (entry.type !== "message") {
        return false;
    }
    const { role } = entry.message;
    return role === "user" || role === "assistant" || role === "toolResult";
}

function resolveEditedContent(
    entry: SessionEntry,
    edit: ContextEditEntry | undefined,
):
    | { readonly omitted: true }
    | { readonly omitted: false; readonly editedContent?: ContextEditableContent | undefined } {
    if (edit === undefined || !isContextEditable(entry)) {
        return { omitted: false };
    }
    if (edit.replacement === null) {
        return { omitted: true };
    }
    const isAssistantOrToolResult =
        entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult");
    const content: ContextEditableContent =
        isAssistantOrToolResult && typeof edit.replacement.content === "string"
            ? [{ type: "text", text: edit.replacement.content }]
            : edit.replacement.content;
    return { omitted: false, editedContent: content };
}

/**
 * Project raw `FileEntry[]` into a compaction-aware, context-edit-aware item list for UI rendering.
 */
export function projectSessionTranscript(
    entries: readonly FileEntry[],
    options?: ProjectTranscriptOptions,
): readonly ProjectedTranscriptItem[] {
    const sessionEntries: SessionEntry[] = [];
    const byId = new Map<string, SessionEntry>();

    for (const entry of entries) {
        if (entry.type === "session") {
            continue;
        }
        sessionEntries.push(entry);
        byId.set(entry.id, entry);
    }

    const path = buildEntryPath(sessionEntries, byId, options?.leafId);

    let compaction: CompactionEntry | null = null;
    let compactionIdx = -1;
    for (let index = 0; index < path.length; index += 1) {
        const candidate = path[index];
        if (candidate?.type === "compaction") {
            compaction = candidate;
            compactionIdx = index;
        }
    }

    const activeEntries: SessionEntry[] = [];

    if (compaction === null || compactionIdx < 0) {
        activeEntries.push(...path);
    } else {
        activeEntries.push(compaction);
        let foundFirstKept = false;
        for (let index = 0; index < compactionIdx; index += 1) {
            const candidate = path[index];
            if (candidate === undefined) {
                continue;
            }
            if (candidate.id === compaction.firstKeptEntryId) {
                foundFirstKept = true;
            }
            if (foundFirstKept && !(candidate.type === "message" && candidate.message.role === "system")) {
                activeEntries.push(candidate);
            }
        }
        activeEntries.push(...path.slice(compactionIdx + 1));
    }

    const editsByTargetId = new Map<string, ContextEditEntry>();
    for (const entry of activeEntries) {
        if (entry.type === "context_edit") {
            editsByTargetId.set(entry.targetId, entry);
        }
    }

    const items: ProjectedTranscriptItem[] = [];
    for (let index = 0; index < activeEntries.length; index += 1) {
        const entry = activeEntries[index];
        if (entry === undefined) {
            continue;
        }
        if (index === 0 && compaction !== null && entry.id === compaction.id) {
            items.push({ kind: "compaction", entry: compaction });
            continue;
        }
        const editResult = resolveEditedContent(entry, editsByTargetId.get(entry.id));
        if (editResult.omitted) {
            continue;
        }
        items.push({
            kind: "entry",
            entry,
            ...(editResult.editedContent === undefined ? {} : { editedContent: editResult.editedContent }),
        });
    }

    return items;
}
