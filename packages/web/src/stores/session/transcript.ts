import type { AssistantMessage, ImageContent, ProjectedTranscriptItem } from "@pivia/protocol";

/**
 * The Pi built-in tools that receive dedicated icons and argument summaries in the transcript.
 *
 * Every extension or MCP tool falls back to `generic`, so a custom ecosystem never splinters into
 * inconsistent row layouts.
 */
export type TranscriptToolKind =
    "bash" | "powershell" | "read" | "write" | "edit" | "grep" | "find" | "ls" | "codemode" | "tool_search" | "generic";

type ProjectedEntryItem = Extract<ProjectedTranscriptItem, { kind: "entry" }>;
type SessionEntry = ProjectedEntryItem["entry"];
type EntryOf<TType extends SessionEntry["type"]> = Extract<SessionEntry, { type: TType }>;
type MessageEntry = EntryOf<"message">;
type MessageOf<TRole extends MessageEntry["message"]["role"]> = Extract<MessageEntry["message"], { role: TRole }>;
type AssistantEntryMessage = MessageOf<"assistant">;
type ToolResultEntryMessage = MessageOf<"toolResult">;
type EditableContent = NonNullable<ProjectedEntryItem["editedContent"]>;

/**
 * Tool arguments as they reached the view.
 *
 * Session parsing only checks the message envelope, so the values stay unknown and every reader
 * narrows them again. A caller must not assume any key exists.
 */
export type TranscriptToolArguments = Readonly<Record<string, unknown>>;

/** Display metadata extracted for one tool call header row. */
export type TranscriptToolMeta = {
    /** Built-in tool category, or `generic` for extension and MCP tools. */
    kind: TranscriptToolKind;
    /** Display label rendered on the tool header row. */
    label: string;
    /** Single-line primary argument summary rendered beside the label. */
    summary: string;
};

/**
 * How a duration reaches the view.
 *
 * The two cases are exclusive: a static item carries its final duration, and a running item only
 * carries its start time and lets the component count. Keeping both numbers in one item allowed a
 * caller to add them twice.
 */
export type TranscriptTiming =
    | { readonly kind: "static"; readonly durationMs: number | null }
    | { readonly kind: "since"; readonly startedAtMs: number };

/** One collapsible thinking block inside a turn timeline. */
export type TranscriptThinkingStep = {
    kind: "thinking";
    id: string;
    thinking: string;
    redacted: boolean;
    streaming: boolean;
};

/** One collapsible tool call and its paired result inside a turn timeline. */
export type TranscriptToolCallStep = {
    kind: "toolCall";
    id: string;
    name: string;
    toolKind: TranscriptToolKind;
    label: string;
    summary: string;
    arguments: TranscriptToolArguments;
    argumentsError: string | null;
    status: "running" | "done" | "error";
    output: string;
    images: readonly ImageContent[];
    timing: TranscriptTiming;
};

/** One intermediate assistant reply rendered directly inside the turn timeline. */
export type TranscriptReplyStep = {
    kind: "reply";
    id: string;
    text: string;
    streaming: boolean;
};

/** One chronological item inside a collapsed turn group. */
export type TranscriptStep = TranscriptThinkingStep | TranscriptToolCallStep | TranscriptReplyStep;

/** One user prompt (or displayed extension message) rendered as a bubble. */
export type TranscriptUserItem = {
    kind: "user";
    id: string;
    text: string;
    images: readonly ImageContent[];
    timestamp: number;
};

/** One system note between prompts, such as a compaction checkpoint or a branch summary. */
export type TranscriptNoteItem = {
    kind: "note";
    id: string;
    /** Short heading that names the checkpoint. */
    title: string;
    /** Text the entry carries; the transcript renders it as Markdown. */
    text: string;
};

/**
 * One complete agent response cycle between user prompts.
 *
 * The final text reply sits below the `Worked for Xs` group while all thoughts, tool calls and
 * intermediate replies stay inside `steps`.
 */
export type TranscriptTurnItem = {
    kind: "turn";
    id: string;
    steps: readonly TranscriptStep[];
    finalReply: string | null;
    errorMessage: string | null;
    timing: TranscriptTiming;
    streaming: boolean;
};

/** One top-level entry in the transcript list. */
export type TranscriptItem = TranscriptUserItem | TranscriptTurnItem | TranscriptNoteItem;

/** Optional inputs for live transcript rendering. */
export type BuildTranscriptOptions = {
    /**
     * Assistant message still streaming over the socket, or settled and waiting for its persisted
     * entry. It joins the turn aggregation after the projected entries.
     */
    readonly liveMessage?: AssistantMessage | null | undefined;
    /**
     * True while the runtime can still append a result for the trailing turn.
     *
     * Only the trailing turn may report a tool call as running. A historical call without a result
     * cannot still run, and a live message without this flag is not animated, so a reconnected but
     * idle session never shows a fake working state.
     */
    readonly runtimeActive?: boolean | undefined;
};

/** One normalized assistant content block, safe to render. */
type AssistantBlock =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "thinking"; readonly thinking: string; readonly redacted: boolean }
    | {
          readonly type: "toolCall";
          readonly id: string;
          readonly name: string;
          readonly arguments: TranscriptToolArguments;
          readonly argumentsError: string | null;
      };

/** One normalized tool result block, safe to render. */
type ToolResultBlock = { readonly type: "text"; readonly text: string } | ImageContent;

/** Assistant message reduced to the fields the transcript reads. */
type ViewAssistantMessage = {
    readonly role: "assistant";
    readonly content: readonly AssistantBlock[];
    readonly timestamp: number;
    readonly stopReason: AssistantEntryMessage["stopReason"];
    readonly errorMessage: string | null;
    readonly durationMs: number | null;
};

/** Tool result reduced to the fields the transcript reads. */
type ViewToolResultMessage = {
    readonly role: "toolResult";
    readonly toolCallId: string;
    readonly content: readonly ToolResultBlock[];
    readonly isError: boolean;
    readonly timestamp: number;
    readonly durationMs: number | null;
};

/** One message of a turn. */
type TurnMessage = {
    readonly message: ViewAssistantMessage | ViewToolResultMessage;
    /** True for the live assistant message that has no persisted entry yet. */
    readonly live: boolean;
};

/** One assistant message of a turn, narrowed so the builder never re-checks the role. */
type AssistantTurnMessage = {
    readonly message: ViewAssistantMessage;
    readonly live: boolean;
};

/** A timestamp is only useful when it is finite; a broken one must not poison ids or durations. */
function toTimestamp(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A duration is only useful when it is a finite, non-negative number. */
function toDuration(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function stringArg(args: TranscriptToolArguments, key: string): string {
    const raw = args[key];
    return typeof raw === "string" ? collapseWhitespace(raw) : "";
}

function firstCodeLine(args: TranscriptToolArguments): string {
    const raw = args.code;
    if (typeof raw !== "string") {
        return "";
    }
    const line = raw
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== "");
    return line === undefined ? "" : collapseWhitespace(line);
}

function firstScalarValue(args: TranscriptToolArguments): string {
    for (const value of Object.values(args)) {
        if (typeof value === "string") {
            const collapsed = collapseWhitespace(value);
            if (collapsed !== "") {
                return collapsed;
            }
        } else if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
    }
    return "";
}

const BUILTIN_TOOL_LABELS: Record<Exclude<TranscriptToolKind, "generic">, string> = {
    bash: "Bash",
    powershell: "PowerShell",
    read: "Read",
    write: "Write",
    edit: "Edit",
    grep: "Grep",
    find: "Find",
    ls: "Ls",
    codemode: "Codemode",
    tool_search: "Tool search",
};

function isBuiltinTool(name: string): name is Exclude<TranscriptToolKind, "generic"> {
    return Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_LABELS, name);
}

/**
 * Classifies one tool call and extracts a single-line primary argument summary for its header row.
 *
 * Only Pi's built-in tools map to dedicated kinds; all extension and MCP tools share `generic`.
 */
export function describeToolCall(name: string, args: TranscriptToolArguments): TranscriptToolMeta {
    if (!isBuiltinTool(name)) {
        return { kind: "generic", label: name, summary: firstScalarValue(args) };
    }

    const label = BUILTIN_TOOL_LABELS[name];
    let summary = "";

    switch (name) {
        case "bash":
        case "powershell":
            summary = stringArg(args, "command");
            break;
        case "read":
        case "write":
        case "edit":
            summary = stringArg(args, "path");
            break;
        case "grep":
        case "find": {
            const pattern = stringArg(args, "pattern");
            const path = stringArg(args, "path");
            if (pattern !== "" && path !== "") {
                summary = `${pattern} in ${path}`;
            } else {
                summary = pattern !== "" ? pattern : path;
            }
            break;
        }
        case "ls": {
            const path = stringArg(args, "path");
            summary = path !== "" ? path : ".";
            break;
        }
        case "codemode":
            summary = firstCodeLine(args);
            break;
        case "tool_search":
            summary = stringArg(args, "query");
            break;
    }

    return { kind: name, label, summary };
}

function parseIsoTimestamp(iso: string): number {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
}

/**
 * Copy tool arguments into a plain object.
 *
 * Session parsing leaves the value unvalidated, so a null, array or scalar becomes an empty object
 * and the view never calls `Object.keys` on a non-object.
 */
function toArguments(raw: unknown): TranscriptToolArguments {
    return isRecord(raw) ? { ...raw } : {};
}

/** Read one image block, or return null when its required fields are missing. */
function toImageBlock(raw: unknown): ImageContent | null {
    if (!isRecord(raw) || raw.type !== "image") {
        return null;
    }
    return typeof raw.data === "string" && typeof raw.mimeType === "string"
        ? { type: "image", data: raw.data, mimeType: raw.mimeType }
        : null;
}

/** Read one assistant block, or return null for an unknown or incomplete block. */
function toAssistantBlock(raw: unknown): AssistantBlock | null {
    if (!isRecord(raw)) {
        return null;
    }
    switch (raw.type) {
        case "text":
            return typeof raw.text === "string" ? { type: "text", text: raw.text } : null;
        case "thinking":
            return typeof raw.thinking === "string"
                ? { type: "thinking", thinking: raw.thinking, redacted: raw.redacted === true }
                : null;
        case "toolCall":
            return {
                type: "toolCall",
                // A call without an id still renders; the step id then falls back to its position.
                id: typeof raw.id === "string" ? raw.id : "",
                name: typeof raw.name === "string" && raw.name !== "" ? raw.name : "unknown",
                arguments: toArguments(raw.arguments),
                argumentsError: typeof raw.argumentsError === "string" ? raw.argumentsError : null,
            };
        default:
            return null;
    }
}

/**
 * Read edited or stored assistant content as renderable blocks.
 *
 * A `context_edit` may replace an assistant message with a plain string, and a streamed message can
 * hold sparse content holes after an out-of-order delta. Both become a dense, typed block list so
 * no later reader has to re-check the shape.
 */
function toAssistantBlocks(content: unknown): AssistantBlock[] {
    if (typeof content === "string") {
        return [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const blocks: AssistantBlock[] = [];
    for (const raw of content) {
        const block = toAssistantBlock(raw);
        if (block !== null) {
            blocks.push(block);
        }
    }
    return blocks;
}

/** Read edited or stored tool result content as renderable blocks. */
function toToolResultBlocks(content: unknown): ToolResultBlock[] {
    if (typeof content === "string") {
        return [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const blocks: ToolResultBlock[] = [];
    for (const raw of content) {
        if (!isRecord(raw)) {
            continue;
        }
        if (raw.type === "text" && typeof raw.text === "string") {
            blocks.push({ type: "text", text: raw.text });
        } else {
            const image = toImageBlock(raw);
            if (image !== null) {
                blocks.push(image);
            }
        }
    }
    return blocks;
}

/** Split a user or extension message into the bubble text and its attachments. */
function readUserContent(content: unknown): { text: string; images: ImageContent[] } {
    if (typeof content === "string") {
        return { text: content.trim(), images: [] };
    }
    if (!Array.isArray(content)) {
        return { text: "", images: [] };
    }
    const texts: string[] = [];
    const images: ImageContent[] = [];
    for (const raw of content) {
        if (!isRecord(raw)) {
            continue;
        }
        if (raw.type === "text" && typeof raw.text === "string") {
            if (raw.text.trim() !== "") {
                texts.push(raw.text.trim());
            }
        } else {
            const image = toImageBlock(raw);
            if (image !== null) {
                images.push(image);
            }
        }
    }
    return { text: texts.join("\n\n"), images };
}

function readAssistantMessage(
    message: AssistantEntryMessage,
    editedContent: EditableContent | undefined,
): ViewAssistantMessage {
    return {
        role: "assistant",
        content: toAssistantBlocks(editedContent ?? message.content),
        timestamp: toTimestamp(message.timestamp),
        stopReason: message.stopReason,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : null,
        durationMs: toDuration(message.durationMs),
    };
}

function readToolResultMessage(
    message: ToolResultEntryMessage,
    editedContent: EditableContent | undefined,
): ViewToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
        content: toToolResultBlocks(editedContent ?? message.content),
        isError: message.isError === true,
        timestamp: toTimestamp(message.timestamp),
        durationMs: toDuration(message.durationMs),
    };
}

function readToolResultContent(content: readonly ToolResultBlock[]): { output: string; images: ImageContent[] } {
    const texts: string[] = [];
    const images: ImageContent[] = [];
    for (const block of content) {
        if (block.type === "text") {
            texts.push(block.text);
        } else {
            images.push(block);
        }
    }
    return { output: texts.join("\n"), images };
}

function computeToolDurationMs(
    assistant: ViewAssistantMessage,
    result: ViewToolResultMessage | undefined,
): number | null {
    if (result === undefined) {
        return null;
    }
    if (result.durationMs !== null) {
        return result.durationMs;
    }
    return result.timestamp >= assistant.timestamp ? result.timestamp - assistant.timestamp : null;
}

function buildTurnItem(
    turnMessages: readonly TurnMessage[],
    precedingUserTimestamp: number | null,
    options: BuildTranscriptOptions,
    isTrailingTurn: boolean,
): TranscriptTurnItem | null {
    const assistants: AssistantTurnMessage[] = [];
    const toolResults = new Map<string, ViewToolResultMessage>();
    for (const turnMessage of turnMessages) {
        if (turnMessage.message.role === "assistant") {
            assistants.push({ message: turnMessage.message, live: turnMessage.live });
        } else {
            toolResults.set(turnMessage.message.toolCallId, turnMessage.message);
        }
    }

    const firstAssistant = assistants[0];
    const lastAssistant = assistants.at(-1);
    if (firstAssistant === undefined || lastAssistant === undefined) {
        return null;
    }

    const lastMessage = lastAssistant.message;
    const lastIsFinalReplyCandidate =
        lastMessage.stopReason !== "toolUse" && !lastMessage.content.some((block) => block.type === "toolCall");
    // Only the trailing turn can still receive a tool result; a historical call without one was
    // interrupted and must not show a spinner that never stops.
    const canStillRun = isTrailingTurn && options.runtimeActive === true;

    const steps: TranscriptStep[] = [];
    const seenToolIds = new Set<string>();
    let finalReply: string | null = null;

    for (let assistantIndex = 0; assistantIndex < assistants.length; assistantIndex += 1) {
        const turnMessage = assistants[assistantIndex];
        if (turnMessage === undefined) {
            continue;
        }
        const assistant = turnMessage.message;
        const isLastAssistant = assistantIndex === assistants.length - 1;
        const extractFinalText = isLastAssistant && lastIsFinalReplyCandidate;
        // A live message only animates while the runtime can still append to it; a persisted
        // pending message has no live flag but is still mid-turn.
        const isStreamingAssistant = turnMessage.live
            ? options.runtimeActive === true && assistant.stopReason === "pending"
            : assistant.stopReason === "pending";
        const finalTextParts: string[] = [];

        for (let blockIndex = 0; blockIndex < assistant.content.length; blockIndex += 1) {
            const block = assistant.content[blockIndex];
            if (block === undefined) {
                continue;
            }
            const isTrailingBlock = isStreamingAssistant && blockIndex === assistant.content.length - 1;
            // The timestamp and indices survive the live-to-persisted handover, so ids stay stable
            // and an expanded step keeps its state while the entry lands.
            const stepPrefix = `${assistant.timestamp}-${assistantIndex}-${blockIndex}`;

            if (block.type === "thinking") {
                if (block.thinking.trim() === "" && !block.redacted && !isTrailingBlock) {
                    continue;
                }
                steps.push({
                    kind: "thinking",
                    id: `${stepPrefix}-thinking`,
                    thinking: block.thinking,
                    redacted: block.redacted,
                    streaming: isTrailingBlock,
                });
            } else if (block.type === "text") {
                if (extractFinalText) {
                    if (block.text.trim() !== "") {
                        finalTextParts.push(block.text.trim());
                    }
                } else if (block.text.trim() !== "" || isTrailingBlock) {
                    steps.push({
                        kind: "reply",
                        id: `${stepPrefix}-reply`,
                        text: block.text.trim(),
                        streaming: isTrailingBlock,
                    });
                }
            } else {
                const result = toolResults.get(block.id);
                const meta = describeToolCall(block.name, block.arguments);
                const { output, images } =
                    result === undefined ? { output: "", images: [] } : readToolResultContent(result.content);

                let status: "running" | "done" | "error";
                if (result !== undefined) {
                    status = result.isError ? "error" : "done";
                } else if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
                    status = "error";
                } else if (canStillRun && isLastAssistant) {
                    status = "running";
                } else {
                    status = "error";
                }

                let stepId = block.id !== "" ? block.id : `${stepPrefix}-tool`;
                if (seenToolIds.has(stepId)) {
                    stepId = `${stepId}-${stepPrefix}`;
                }
                seenToolIds.add(stepId);

                steps.push({
                    kind: "toolCall",
                    id: stepId,
                    name: block.name,
                    toolKind: meta.kind,
                    label: meta.label,
                    summary: meta.summary,
                    arguments: block.arguments,
                    argumentsError: block.argumentsError,
                    status,
                    output,
                    images,
                    timing:
                        status === "running"
                            ? { kind: "since", startedAtMs: assistant.timestamp }
                            : { kind: "static", durationMs: computeToolDurationMs(assistant, result) },
                });
            }
        }

        if (extractFinalText && finalTextParts.length > 0) {
            finalReply = finalTextParts.join("\n\n");
        }
    }

    const streaming = (lastAssistant.live && options.runtimeActive === true) || steps.some(isRunningToolStep);

    const startMs = precedingUserTimestamp ?? firstAssistant.message.timestamp;
    let settledDurationMs: number | null = null;
    if (!streaming) {
        let endMs = firstAssistant.message.timestamp;
        for (const turnMessage of turnMessages) {
            if (turnMessage.message.role === "assistant") {
                const candidate = turnMessage.message.timestamp + (turnMessage.message.durationMs ?? 0);
                if (candidate > endMs) {
                    endMs = candidate;
                }
            } else if (turnMessage.message.timestamp > endMs) {
                endMs = turnMessage.message.timestamp;
            }
        }
        if (endMs >= startMs) {
            settledDurationMs = endMs - startMs;
        }
    }

    const trimmedError = lastMessage.errorMessage?.trim() ?? "";
    const errorMessage =
        trimmedError !== "" ? trimmedError : lastMessage.stopReason === "error" ? "Assistant request failed" : null;

    return {
        kind: "turn",
        id: `turn-${firstAssistant.message.timestamp}`,
        steps,
        finalReply,
        errorMessage,
        timing: streaming ? { kind: "since", startedAtMs: startMs } : { kind: "static", durationMs: settledDurationMs },
        streaming,
    };
}

function isRunningToolStep(step: TranscriptStep): boolean {
    return step.kind === "toolCall" && step.status === "running";
}

/**
 * Aggregate projected transcript items into user bubbles, system notes and `Worked for Xs` groups.
 *
 * Every assistant round and tool result between two user prompts shares one turn group, with the
 * final text-only assistant reply placed outside the group below `steps`. A compaction or branch
 * summary ends the running turn because it marks a context boundary the reader must see.
 */
export function buildTranscript(
    items: readonly ProjectedTranscriptItem[],
    options: BuildTranscriptOptions = {},
): TranscriptItem[] {
    const transcript: TranscriptItem[] = [];
    const usedTurnIds = new Set<string>();
    let pendingTurn: TurnMessage[] = [];
    let lastUserTimestamp: number | null = null;
    let liveMessageDuplicated = false;

    const flushTurn = (isTrailingTurn: boolean): void => {
        if (pendingTurn.length === 0) {
            return;
        }
        const turn = buildTurnItem(pendingTurn, lastUserTimestamp, options, isTrailingTurn);
        pendingTurn = [];
        // A note or compaction ends the previous cycle; the next turn must not inherit its prompt
        // time when no new user message precedes it.
        lastUserTimestamp = null;
        if (turn === null) {
            return;
        }
        // A turn id must stay unique across the list; the live-to-persisted handover keeps the same
        // timestamp, so the same suffix is chosen in both phases.
        let id = turn.id;
        let suffix = 1;
        while (usedTurnIds.has(id)) {
            id = `${turn.id}-${suffix}`;
            suffix += 1;
        }
        usedTurnIds.add(id);
        transcript.push(id === turn.id ? turn : { ...turn, id });
    };

    for (const item of items) {
        if (item.kind === "compaction") {
            flushTurn(false);
            transcript.push({
                kind: "note",
                id: `note-${item.entry.id}`,
                title: "Session compacted",
                text: item.entry.summary,
            });
            continue;
        }

        const entry = item.entry;
        switch (entry.type) {
            case "message": {
                const message = entry.message;
                if (message.role === "user") {
                    flushTurn(false);
                    const { text, images } = readUserContent(item.editedContent ?? message.content);
                    transcript.push({
                        kind: "user",
                        id: `user-${entry.id}`,
                        text,
                        images,
                        timestamp: message.timestamp,
                    });
                    lastUserTimestamp = message.timestamp;
                    break;
                }
                if (message.role === "assistant") {
                    if (options.liveMessage?.timestamp === message.timestamp) {
                        liveMessageDuplicated = true;
                    }
                    pendingTurn.push({ message: readAssistantMessage(message, item.editedContent), live: false });
                    break;
                }
                if (message.role === "toolResult") {
                    pendingTurn.push({ message: readToolResultMessage(message, item.editedContent), live: false });
                }
                // A system message is prompt scaffolding, not conversation.
                break;
            }
            case "custom_message": {
                if (!entry.display) {
                    break;
                }
                flushTurn(false);
                const timestamp = parseIsoTimestamp(entry.timestamp);
                const { text, images } = readUserContent(item.editedContent ?? entry.content);
                transcript.push({ kind: "user", id: `user-${entry.id}`, text, images, timestamp });
                lastUserTimestamp = timestamp;
                break;
            }
            case "branch_summary":
                flushTurn(false);
                transcript.push({
                    kind: "note",
                    id: `note-${entry.id}`,
                    title: "Branch summary",
                    text: entry.summary,
                });
                break;
            case "compaction":
                // Only the newest compaction shapes the view. Older ones inside a kept range stay
                // model-context metadata and would repeat a summary the reader already saw.
                break;
            default:
                // Thinking-level, model, usage, custom-data, context-edit, label and session-info
                // entries never render as conversation.
                break;
        }
    }

    const live = options.liveMessage ?? null;
    if (live !== null && !liveMessageDuplicated) {
        pendingTurn.push({
            message: {
                role: "assistant",
                content: toAssistantBlocks(live.content),
                timestamp: toTimestamp(live.timestamp),
                stopReason: live.stopReason,
                errorMessage: typeof live.errorMessage === "string" ? live.errorMessage : null,
                durationMs: toDuration(live.durationMs),
            },
            live: true,
        });
    }
    flushTurn(true);

    return transcript;
}

/**
 * Formats a turn's total duration for the `Worked for ...` header (`0s`..`59s`, `1m`, `2m 5s`).
 */
export function formatTurnDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Formats a single tool call's duration (`0.0s`..`59.9s`, `1m`, `2m 5s`).
 */
export function formatToolDuration(durationMs: number): string {
    const tenths = Math.max(0, Math.round(durationMs / 100));
    if (tenths < 600) {
        return `${(tenths / 10).toFixed(1)}s`;
    }
    const totalSeconds = Math.round(tenths / 10);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
