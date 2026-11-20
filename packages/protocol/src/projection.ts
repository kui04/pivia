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
 * Mirrors the active-branch and compaction rules of the SDK `SessionManager` without importing
 * Node-only modules (`node:fs`, `readline`).
 */
export type ProjectedTranscriptItem =
    | {
          readonly kind: "entry";
          readonly entry: SessionEntry;
          /** Resolved latest bookmark label targeting `entry.id`, if any. */
          readonly label?: string | undefined;
          /** Content replacement applied by the latest `context_edit` targeting `entry.id`. */
          readonly editedContent?: ContextEditableContent | undefined;
      }
    | {
          readonly kind: "compaction";
          readonly entry: CompactionEntry;
          /** Active-branch entries summarized away before `entry.firstKeptEntryId`. */
          readonly compactedBefore: readonly SessionEntry[];
      };

/** Complete projection of the active branch in a session transcript. */
export interface SessionTranscriptProjection {
    /** Items along the active branch from root to `leafId`, with the latest compaction folded. */
    readonly items: readonly ProjectedTranscriptItem[];
    /** Entries omitted from active context because they precede `compaction.firstKeptEntryId`. */
    readonly compactedBefore: readonly SessionEntry[];
    /** Latest compaction entry on the active branch, or `null` when none exists. */
    readonly compaction: CompactionEntry | null;
    /** Active, compaction-aware raw entries matching `SessionManager.buildContextEntries()`. */
    readonly activeEntries: readonly SessionEntry[];
    /** Latest resolved bookmark labels keyed by target entry id. */
    readonly labelsById: ReadonlyMap<string, string>;
    /** Latest non-empty session name from `session_info` entries, or `null`. */
    readonly sessionName: string | null;
    /** Resolved leaf entry id used as the branch tip, or `null` when the session has no entries. */
    readonly leafId: string | null;
}

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
): { readonly path: readonly SessionEntry[]; readonly leafId: string | null } {
    if (leafIdOption === null) {
        return { path: [], leafId: null };
    }
    const leaf = (leafIdOption !== undefined ? byId.get(leafIdOption) : undefined) ?? sessionEntries.at(-1);
    if (leaf === undefined) {
        return { path: [], leafId: null };
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
    return { path: reversed, leafId: leaf.id };
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
 * Project raw `FileEntry[]` into a compaction-aware, context-edit-aware transcript for UI rendering.
 */
export function projectSessionTranscript(
    entries: readonly FileEntry[],
    options?: ProjectTranscriptOptions,
): SessionTranscriptProjection {
    const sessionEntries: SessionEntry[] = [];
    const byId = new Map<string, SessionEntry>();
    const labelsById = new Map<string, string>();
    let sessionName: string | null = null;

    for (const entry of entries) {
        if (entry.type === "session") {
            continue;
        }
        sessionEntries.push(entry);
        byId.set(entry.id, entry);
        if (entry.type === "label") {
            if (entry.label) {
                labelsById.set(entry.targetId, entry.label);
            } else {
                labelsById.delete(entry.targetId);
            }
        } else if (entry.type === "session_info") {
            const trimmed = entry.name?.trim();
            sessionName = trimmed ? trimmed : null;
        }
    }

    const { path, leafId } = buildEntryPath(sessionEntries, byId, options?.leafId);

    let compaction: CompactionEntry | null = null;
    let compactionIdx = -1;
    for (let index = 0; index < path.length; index += 1) {
        const candidate = path[index];
        if (candidate?.type === "compaction") {
            compaction = candidate;
            compactionIdx = index;
        }
    }

    const compactedBefore: SessionEntry[] = [];
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
            if (!foundFirstKept) {
                compactedBefore.push(candidate);
            } else if (!(candidate.type === "message" && candidate.message.role === "system")) {
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
            items.push({ kind: "compaction", entry: compaction, compactedBefore });
            continue;
        }
        const editResult = resolveEditedContent(entry, editsByTargetId.get(entry.id));
        if (editResult.omitted) {
            continue;
        }
        const label = labelsById.get(entry.id);
        items.push({
            kind: "entry",
            entry,
            ...(label === undefined ? {} : { label }),
            ...(editResult.editedContent === undefined ? {} : { editedContent: editResult.editedContent }),
        });
    }

    return {
        items,
        compactedBefore,
        compaction,
        activeEntries,
        labelsById,
        sessionName,
        leafId,
    };
}

export type { CompactionEntry, ContextEditableContent, ContextEditEntry };
