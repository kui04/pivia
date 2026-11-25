import type { ImageContent, JsonObject, JsonValue, NestedToolCallRecord, NestedToolCalls } from "@earendil-works/pi-ai";
import type {
    BashToolDetails,
    CodemodeToolDetails,
    EditToolDetails,
    FindToolDetails,
    GrepToolDetails,
    LsToolDetails,
    ReadToolDetails,
    ToolCallEvent,
    TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { assertNever, isFiniteNumber, isImageContent, isRecord } from "@pivia/protocol";

import { resolveLanguage } from "@/components/CodeBlock/highlight";
import { Formatter } from "@/lib";

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;
const READ_CONTINUATION_FOOTER =
    /\n\n\[(Showing lines \d+-\d+ of \d+[^\]]*|\d+ more lines in file\. Use offset=\d+ to continue\.)\]$/;
const CODEMODE_SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;

type CodemodeNestedCall = CodemodeToolDetails["calls"][number];
const CODEMODE_CALL_STATUSES: ReadonlySet<CodemodeNestedCall["status"]> = new Set([
    "running",
    "ok",
    "error",
    "cancelled",
]);
const RECORD_CALL_STATUSES: ReadonlySet<NestedToolCallRecord["status"]> = new Set(["ok", "error", "unfinished"]);

type LiteralToolName<TEvent> = TEvent extends { readonly toolName: infer TName extends string }
    ? string extends TName
        ? never
        : TName
    : never;

/** Core tool names derived from the SDK {@link ToolCallEvent} union. */
export type SdkBuiltinToolName = LiteralToolName<ToolCallEvent>;

/**
 * The Pi built-in tools that receive dedicated icons and argument summaries in the transcript.
 *
 * Every extension or MCP tool falls back to `generic`, so a custom ecosystem never splinters into
 * inconsistent row layouts.
 */
export type TranscriptToolKind = SdkBuiltinToolName | "codemode" | "tool_search" | "generic";

/**
 * Tool arguments as they reached the view.
 *
 * Session parsing only checks the message envelope, so the values stay unknown and every reader
 * narrows them again. A caller must not assume any key exists.
 */
export type TranscriptToolArguments = Readonly<Record<string, unknown>>;

/** Terminal outcome of a single tool step, aligned with `TranscriptToolCallStep["status"]`. */
export type TranscriptToolStatus = "running" | "done" | "error";

/** Terminal status of one nested tool call, merging codemode and persisted records. */
export type TranscriptNestedCallStatus =
    CodemodeToolDetails["calls"][number]["status"] | NestedToolCallRecord["status"];

/** Normalized view model for one nested tool call inside an outer tool invocation. */
export interface TranscriptNestedToolCall {
    readonly id: string;
    readonly name: string;
    readonly args: string;
    readonly status: TranscriptNestedCallStatus;
    readonly durationMs: number | null;
    readonly error: string | null;
    readonly cost: number | null;
}

/**
 * Summary of nested tool calls executed within a single outer tool call.
 *
 * Invariant: constructed only when `calls.length > 0 || !complete` so an empty complete list stays
 * represented as `null`.
 */
export interface TranscriptNestedCallsSummary {
    readonly calls: readonly TranscriptNestedToolCall[];
    /** False when the SDK dropped calls or omitted oversized arguments. */
    readonly complete: boolean;
    /** Summed USD cost when two or more nested calls reported positive usage cost, else `null`. */
    readonly totalCost: number | null;
}

/**
 * Rich visual preview extracted for a tool invocation card.
 *
 * Invariants:
 * - `diff` is only produced when `diff.length > 0` and the tool did not fail.
 * - `code` is only produced when `code.length > 0` and replaces the raw result card; `startLine` is
 *   a positive 1-based line number.
 * - `script` represents an input script (`codemode`), rendered alongside any output card.
 */
export type TranscriptToolPreview =
    | { readonly kind: "none" }
    | {
          readonly kind: "diff";
          /** Standard unified patch (preferred) or legacy display diff when `patch` is absent. */
          readonly diff: EditToolDetails["patch"];
      }
    | {
          readonly kind: "code";
          readonly code: string;
          readonly language: string | undefined;
          readonly startLine: number;
      }
    | {
          readonly kind: "script";
          readonly code: string;
          readonly language: "javascript";
      };

/**
 * Actionable truncation or limit notice attached to a tool result.
 *
 * Separating `fullOutput` from plain `notice` lines lets the UI render the path in monospace code
 * without string-splitting rendered notices.
 */
export type TranscriptToolWarning =
    | { readonly kind: "notice"; readonly message: string }
    | { readonly kind: "fullOutput"; readonly path: NonNullable<BashToolDetails["fullOutputPath"]> };

/** Combined rich preview, nested calls, warnings and normalized output for one tool call step. */
export interface TranscriptToolPresentation {
    readonly preview: TranscriptToolPreview;
    readonly warnings: readonly TranscriptToolWarning[];
    readonly nestedCalls: TranscriptNestedCallsSummary | null;
    readonly output: string;
}

/** Input needed to derive a tool call's rich preview, nested calls and truncation notices. */
export interface BuildToolPresentationInput {
    readonly toolKind: TranscriptToolKind;
    readonly args: TranscriptToolArguments;
    readonly argumentsError: string | null;
    readonly status: TranscriptToolStatus;
    readonly output: string;
    readonly hasImages: boolean;
    readonly details: unknown;
    readonly nestedCalls?: unknown;
}

const EXTENSION_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
    mjs: "javascript",
    cjs: "javascript",
    htm: "html",
    h: "c",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    gradle: "groovy",
    zsh: "bash",
};

const BASENAME_LANGUAGES: Readonly<Record<string, string>> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    gnumakefile: "makefile",
};

function parsePositiveInteger(value: unknown): number | undefined {
    const num =
        typeof value === "string" && value.trim() !== "" ? Number(value) : isFiniteNumber(value) ? value : undefined;
    return num !== undefined && Number.isInteger(num) && num >= 1 ? num : undefined;
}

/** One normalized tool result content block, safe to render from either persisted entries or live updates. */
export type NormalizedToolResultBlock = { readonly type: "text"; readonly text: string } | ImageContent;

/** Copy tool arguments into a plain object, rejecting null, arrays, or scalar values. */
export function toToolArguments(raw: unknown): TranscriptToolArguments {
    return isRecord(raw) ? { ...raw } : {};
}

/** Normalize persisted, edited, or live tool result content into renderable blocks. */
export function toToolResultBlocks(content: unknown): NormalizedToolResultBlock[] {
    if (typeof content === "string") {
        return [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const blocks: NormalizedToolResultBlock[] = [];
    for (const raw of content) {
        if (!isRecord(raw)) {
            continue;
        }
        if (raw.type === "text" && typeof raw.text === "string") {
            blocks.push({ type: "text", text: raw.text });
        } else if (isImageContent(raw)) {
            blocks.push({ type: "image", data: raw.data, mimeType: raw.mimeType });
        }
    }
    return blocks;
}

/** Normalize a duration in milliseconds, rejecting non-finite or negative numbers. */
export function toNonNegativeDuration(value: unknown): number | null {
    return isFiniteNumber(value) ? Math.max(0, value) : null;
}

/** Returns `value` when it is a finite positive number, or `undefined` otherwise. */
export function readOptionalPositiveNumber(value: unknown): number | undefined {
    return isFiniteNumber(value) && value > 0 ? value : undefined;
}

function readOptionalNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** Read the target path from `path` or legacy `file_path` arguments, falling back if `path` is blank. */
export function readToolFilePath(args: TranscriptToolArguments): string | null {
    for (const key of ["path", "file_path"] as const) {
        const raw = args[key];
        if (typeof raw === "string") {
            const trimmed = raw.trim();
            if (trimmed !== "") {
                return trimmed;
            }
        }
    }
    return null;
}

/**
 * Formats optional positive integer `offset` / `limit` arguments for a `read` tool summary
 * (`:10`, `:10-59`), returning an empty string for absent or invalid inputs.
 */
export function formatReadLineRangeSummary(offset: unknown, limit: unknown): string {
    if (offset == null && limit == null) {
        return "";
    }
    const start = offset == null ? 1 : parsePositiveInteger(offset);
    if (start === undefined) {
        return "";
    }
    if (limit == null) {
        return `:${start}`;
    }
    const count = parsePositiveInteger(limit);
    if (count === undefined) {
        return "";
    }
    const end = start + count - 1;
    return `:${start}-${end}`;
}

/**
 * Resolves a Shiki-compatible language id from a file path extension or basename, or `undefined`
 * when no highlighting grammar applies.
 */
export function inferLanguageFromPath(filePath: string): string | undefined {
    const trimmed = filePath.trim();
    if (trimmed === "") {
        return undefined;
    }
    const slashIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    const basename = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
    const byBasename = BASENAME_LANGUAGES[basename.toLowerCase()];
    if (byBasename !== undefined) {
        return resolveLanguage(byBasename)?.id;
    }
    const dotIndex = basename.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === basename.length - 1) {
        return undefined;
    }
    const ext = basename.slice(dotIndex + 1).toLowerCase();
    const candidate = EXTENSION_LANGUAGE_ALIASES[ext] ?? ext;
    return resolveLanguage(candidate)?.id;
}

/** Boundary parser for an SDK {@link TruncationResult} object; returns `null` if malformed. */
export function parseTruncationResult(raw: unknown): TruncationResult | null {
    if (!isRecord(raw) || typeof raw.truncated !== "boolean") {
        return null;
    }
    const truncatedBy = raw.truncatedBy;
    if (truncatedBy !== "lines" && truncatedBy !== "bytes" && truncatedBy !== null) {
        return null;
    }
    if (
        typeof raw.content !== "string" ||
        !isFiniteNumber(raw.totalLines) ||
        !isFiniteNumber(raw.totalBytes) ||
        !isFiniteNumber(raw.outputLines) ||
        !isFiniteNumber(raw.outputBytes) ||
        typeof raw.lastLinePartial !== "boolean" ||
        typeof raw.firstLineExceedsLimit !== "boolean" ||
        !isFiniteNumber(raw.maxLines) ||
        !isFiniteNumber(raw.maxBytes)
    ) {
        return null;
    }
    return {
        content: raw.content,
        truncated: raw.truncated,
        truncatedBy,
        totalLines: raw.totalLines,
        totalBytes: raw.totalBytes,
        outputLines: raw.outputLines,
        outputBytes: raw.outputBytes,
        lastLinePartial: raw.lastLinePartial,
        firstLineExceedsLimit: raw.firstLineExceedsLimit,
        maxLines: raw.maxLines,
        maxBytes: raw.maxBytes,
    };
}

/**
 * Boundary parser for {@link EditToolDetails}; returns `null` when neither `patch` nor `diff` is a
 * non-empty string.
 */
export function parseEditToolDetails(
    raw: unknown,
): Pick<EditToolDetails, "patch" | "diff" | "firstChangedLine"> | null {
    if (!isRecord(raw)) {
        return null;
    }
    const patch = readOptionalNonEmptyString(raw.patch) ?? "";
    const diff = readOptionalNonEmptyString(raw.diff) ?? "";
    if (patch === "" && diff === "") {
        return null;
    }
    return {
        patch,
        diff,
        ...(isFiniteNumber(raw.firstChangedLine) ? { firstChangedLine: raw.firstChangedLine } : {}),
    };
}

/** Boundary parser for {@link BashToolDetails}. */
export function parseShellToolDetails(raw: unknown): BashToolDetails | null {
    if (!isRecord(raw)) {
        return null;
    }
    const truncation = parseTruncationResult(raw.truncation);
    const fullOutputPath = readOptionalNonEmptyString(raw.fullOutputPath);
    if (truncation === null && fullOutputPath === undefined) {
        return null;
    }
    return {
        ...(truncation === null ? {} : { truncation }),
        ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    };
}

/** Boundary parser for {@link ReadToolDetails}. */
export function parseReadToolDetails(raw: unknown): ReadToolDetails | null {
    if (!isRecord(raw)) {
        return null;
    }
    const truncation = parseTruncationResult(raw.truncation);
    return truncation === null ? null : { truncation };
}

/** Boundary parser for {@link GrepToolDetails}. */
export function parseGrepToolDetails(raw: unknown): GrepToolDetails | null {
    if (!isRecord(raw)) {
        return null;
    }
    const truncation = parseTruncationResult(raw.truncation);
    const matchLimitReached = readOptionalPositiveNumber(raw.matchLimitReached);
    const linesTruncated = raw.linesTruncated === true ? true : undefined;
    if (truncation === null && matchLimitReached === undefined && linesTruncated === undefined) {
        return null;
    }
    return {
        ...(truncation === null ? {} : { truncation }),
        ...(matchLimitReached === undefined ? {} : { matchLimitReached }),
        ...(linesTruncated === undefined ? {} : { linesTruncated }),
    };
}

function parseSingleLimitDetails<TKey extends "resultLimitReached" | "entryLimitReached">(
    raw: unknown,
    limitKey: TKey,
): ({ truncation?: TruncationResult } & { [K in TKey]?: number }) | null {
    if (!isRecord(raw)) {
        return null;
    }
    const truncation = parseTruncationResult(raw.truncation);
    const limit = readOptionalPositiveNumber(raw[limitKey]);
    if (truncation === null && limit === undefined) {
        return null;
    }
    return {
        ...(truncation === null ? {} : { truncation }),
        ...(limit === undefined ? {} : { [limitKey]: limit }),
    } as { truncation?: TruncationResult } & { [K in TKey]?: number };
}

/** Boundary parser for {@link FindToolDetails}. */
export function parseFindToolDetails(raw: unknown): FindToolDetails | null {
    return parseSingleLimitDetails(raw, "resultLimitReached");
}

/** Boundary parser for {@link LsToolDetails}. */
export function parseLsToolDetails(raw: unknown): LsToolDetails | null {
    return parseSingleLimitDetails(raw, "entryLimitReached");
}

function parseAllowedStatus<T extends string>(raw: unknown, allowed: ReadonlySet<T>): T | undefined {
    for (const candidate of allowed) {
        if (raw === candidate) {
            return candidate;
        }
    }
    return undefined;
}

function toJsonValue(raw: unknown): JsonValue | undefined {
    if (raw === null || typeof raw === "boolean" || typeof raw === "string") {
        return raw;
    }
    if (typeof raw === "number") {
        return Number.isFinite(raw) ? raw : undefined;
    }
    if (Array.isArray(raw)) {
        return raw.map((item) => toJsonValue(item) ?? null);
    }
    if (isRecord(raw)) {
        return toJsonObject(raw);
    }
    return undefined;
}

function toJsonObject(raw: unknown): JsonObject | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    const obj: JsonObject = {};
    for (const [key, value] of Object.entries(raw)) {
        const converted = toJsonValue(value);
        if (converted !== undefined) {
            Object.defineProperty(obj, key, {
                value: converted,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }
    return obj;
}

function parseCodemodeNestedCall(raw: unknown): CodemodeNestedCall | null {
    if (!isRecord(raw)) {
        return null;
    }
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const name = readOptionalNonEmptyString(raw.name);
    const args = typeof raw.args === "string" ? raw.args : undefined;
    const status = parseAllowedStatus(raw.status, CODEMODE_CALL_STATUSES);
    if (id === undefined || name === undefined || args === undefined || status === undefined) {
        return null;
    }
    const durationMs = isFiniteNumber(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : undefined;
    const error = typeof raw.error === "string" ? raw.error : undefined;
    const cost = readOptionalPositiveNumber(raw.cost);
    return {
        id,
        name,
        args,
        status,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(error === undefined ? {} : { error }),
        ...(cost === undefined ? {} : { cost }),
    };
}

/** Boundary parser for {@link CodemodeToolDetails}. */
export function parseCodemodeToolDetails(raw: unknown): CodemodeToolDetails | null {
    if (!isRecord(raw) || !Array.isArray(raw.calls)) {
        return null;
    }
    const calls: CodemodeNestedCall[] = [];
    for (const entry of raw.calls) {
        const parsed = parseCodemodeNestedCall(entry);
        if (parsed !== null) {
            calls.push(parsed);
        }
    }
    const fullOutputPath = readOptionalNonEmptyString(raw.fullOutputPath);
    return {
        calls,
        ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    };
}

function parseNestedToolCallRecord(raw: unknown): NestedToolCallRecord | null {
    if (!isRecord(raw)) {
        return null;
    }
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const name = readOptionalNonEmptyString(raw.name);
    const status = parseAllowedStatus(raw.status, RECORD_CALL_STATUSES);
    if (id === undefined || name === undefined || status === undefined) {
        return null;
    }
    const argsObj = toJsonObject(raw.arguments);
    const argumentsBytes =
        isFiniteNumber(raw.argumentsBytes) && raw.argumentsBytes >= 0 ? raw.argumentsBytes : undefined;
    const durationMs = isFiniteNumber(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : undefined;
    const error = typeof raw.error === "string" ? raw.error : undefined;
    return {
        id,
        name,
        ...(argsObj === undefined ? {} : { arguments: argsObj }),
        ...(argumentsBytes === undefined ? {} : { argumentsBytes }),
        status,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(error === undefined ? {} : { error }),
    };
}

/** Boundary parser for {@link NestedToolCalls}. */
export function parseNestedToolCalls(raw: unknown): NestedToolCalls | null {
    if (!isRecord(raw) || !Array.isArray(raw.calls) || typeof raw.complete !== "boolean") {
        return null;
    }
    const calls: NestedToolCallRecord[] = [];
    for (const entry of raw.calls) {
        const parsed = parseNestedToolCallRecord(entry);
        if (parsed !== null) {
            calls.push(parsed);
        }
    }
    return {
        calls,
        complete: raw.complete,
    };
}

function formatTruncationNotice(truncation: TruncationResult, includeMaxLinesLimit: boolean): TranscriptToolWarning {
    if (truncation.firstLineExceedsLimit) {
        return {
            kind: "notice",
            message: `First line exceeds ${Formatter.byteSize(truncation.maxBytes || DEFAULT_MAX_BYTES)} limit`,
        };
    }
    if (truncation.truncatedBy === "lines") {
        const suffix = includeMaxLinesLimit ? ` (${truncation.maxLines || DEFAULT_MAX_LINES} line limit)` : "";
        return {
            kind: "notice",
            message: `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines${suffix}`,
        };
    }
    return {
        kind: "notice",
        message: `Truncated: ${truncation.outputLines} lines shown (${Formatter.byteSize(truncation.maxBytes || DEFAULT_MAX_BYTES)} limit)`,
    };
}

function buildShellWarnings(details: BashToolDetails | null): TranscriptToolWarning[] {
    if (details === null) {
        return [];
    }
    const warnings: TranscriptToolWarning[] = [];
    if (details.fullOutputPath !== undefined) {
        warnings.push({ kind: "fullOutput", path: details.fullOutputPath });
    }
    if (details.truncation?.truncated === true) {
        warnings.push(formatTruncationNotice(details.truncation, false));
    }
    return warnings;
}

function buildLimitTruncationWarnings(
    limitMessage: string | null,
    truncation: TruncationResult | undefined,
    extraNote?: string,
): TranscriptToolWarning[] {
    const parts: string[] = [];
    if (limitMessage !== null) {
        parts.push(limitMessage);
    }
    if (truncation?.truncated === true) {
        parts.push(`${Formatter.byteSize(truncation.maxBytes || DEFAULT_MAX_BYTES)} limit`);
    }
    if (extraNote !== undefined) {
        parts.push(extraNote);
    }
    return parts.length === 0 ? [] : [{ kind: "notice", message: `Truncated: ${parts.join(", ")}` }];
}

function buildCodePreview(args: TranscriptToolArguments, code: string, startLine: number): TranscriptToolPreview {
    if (code === "") {
        return { kind: "none" };
    }
    const filePath = readToolFilePath(args);
    return {
        kind: "code",
        code,
        language: filePath === null ? undefined : inferLanguageFromPath(filePath),
        startLine,
    };
}

function buildWritePreview(input: BuildToolPresentationInput): TranscriptToolPreview {
    if (input.status === "error" || input.argumentsError !== null || typeof input.args.content !== "string") {
        return { kind: "none" };
    }
    // Trim a single trailing newline emitted at EOF so CodeBlock does not add a blank line.
    const normalized = input.args.content.replace(/\r\n/g, "\n").replace(/\n$/, "");
    return buildCodePreview(input.args, normalized, 1);
}

function buildReadPresentation(
    input: BuildToolPresentationInput,
): Pick<TranscriptToolPresentation, "preview" | "warnings" | "output"> {
    const readDetails = parseReadToolDetails(input.details);
    const truncation = readDetails?.truncation;
    const warnings = truncation?.truncated === true ? [formatTruncationNotice(truncation, true)] : [];

    // When the first line exceeds the byte limit, `output` is a bracketed diagnostic, not file code.
    if (
        input.status === "error" ||
        input.hasImages ||
        input.output === "" ||
        truncation?.firstLineExceedsLimit === true
    ) {
        return { preview: { kind: "none" }, warnings, output: input.output };
    }

    const match = READ_CONTINUATION_FOOTER.exec(input.output);
    const code = match === null ? input.output : input.output.slice(0, match.index);
    if (match !== null && match[1] !== undefined && warnings.length === 0) {
        warnings.push({ kind: "notice", message: match[1] });
    }

    return {
        preview: buildCodePreview(input.args, code, parsePositiveInteger(input.args.offset) ?? 1),
        warnings,
        output: input.output,
    };
}

function formatRecordArgs(record: NestedToolCallRecord): string {
    if (record.arguments !== undefined) {
        return JSON.stringify(record.arguments);
    }
    if (record.argumentsBytes !== undefined) {
        return `(${Formatter.byteSize(record.argumentsBytes)} args)`;
    }
    return "";
}

function normalizeCodemodeCall(call: CodemodeNestedCall): TranscriptNestedToolCall {
    return {
        id: call.id,
        name: call.name,
        args: call.args,
        status: call.status,
        durationMs: call.durationMs ?? null,
        error: readOptionalNonEmptyString(call.error) ?? null,
        cost: call.cost ?? null,
    };
}

function normalizeRecordedCall(record: NestedToolCallRecord): TranscriptNestedToolCall {
    return {
        id: record.id,
        name: record.name,
        args: formatRecordArgs(record),
        status: record.status,
        durationMs: record.durationMs ?? null,
        error: readOptionalNonEmptyString(record.error) ?? null,
        cost: null,
    };
}

function buildNestedCallsSummary(
    codemodeDetails: CodemodeToolDetails | null,
    rawNestedCalls: unknown,
): TranscriptNestedCallsSummary | null {
    const recorded = parseNestedToolCalls(rawNestedCalls);
    let calls: readonly TranscriptNestedToolCall[];
    let complete: boolean;

    // Prefer `CodemodeToolDetails.calls` when populated (it carries compact `args` and `cost`),
    // while keeping `ToolResultMessage.nestedCalls.complete` and falling back to recorded calls.
    if (codemodeDetails !== null && codemodeDetails.calls.length > 0) {
        calls = codemodeDetails.calls.map(normalizeCodemodeCall);
        complete = recorded?.complete ?? true;
    } else if (recorded !== null) {
        calls = recorded.calls.map(normalizeRecordedCall);
        complete = recorded.complete;
    } else {
        return null;
    }

    if (calls.length === 0 && complete) {
        return null;
    }

    let pricedCount = 0;
    let totalCostSum = 0;
    for (const call of calls) {
        if (call.cost !== null && call.cost > 0) {
            pricedCount += 1;
            totalCostSum += call.cost;
        }
    }

    return {
        calls,
        complete,
        totalCost: pricedCount > 1 ? totalCostSum : null,
    };
}

function buildCodemodePresentation(
    input: BuildToolPresentationInput,
    codemodeDetails: CodemodeToolDetails | null,
): Pick<TranscriptToolPresentation, "preview" | "warnings" | "output"> {
    const rawCode = input.argumentsError === null && typeof input.args.code === "string" ? input.args.code : "";
    const code = rawCode.replace(/\r\n?/g, "\n").trimEnd();
    const preview: TranscriptToolPreview =
        code === "" ? { kind: "none" } : { kind: "script", code, language: "javascript" };

    const shellDetails = parseShellToolDetails(input.details);
    const warnings = buildShellWarnings(
        codemodeDetails?.fullOutputPath !== undefined && shellDetails?.fullOutputPath === undefined
            ? { ...shellDetails, fullOutputPath: codemodeDetails.fullOutputPath }
            : shellDetails,
    );

    const output = input.output.replace(CODEMODE_SCRIPT_HEADER, "").trim();
    return { preview, warnings, output };
}

/**
 * Builds the rich preview (`diff`, `code`, or `script`), nested call summary, warnings, and
 * normalized output for one tool call step from its arguments, output, `details`, and `nestedCalls`.
 */
export function buildToolPresentation(input: BuildToolPresentationInput): TranscriptToolPresentation {
    const codemodeDetails = input.toolKind === "codemode" ? parseCodemodeToolDetails(input.details) : null;
    const nestedCalls = buildNestedCallsSummary(codemodeDetails, input.nestedCalls);

    let core: Pick<TranscriptToolPresentation, "preview" | "warnings" | "output">;
    switch (input.toolKind) {
        case "edit": {
            const editDetails = input.status === "error" ? null : parseEditToolDetails(input.details);
            // Prefer the standard unified `patch` for CodeBlock's diff parser; fall back to `diff`
            // only when reading legacy records without `patch`.
            const diffText =
                editDetails === null ? "" : editDetails.patch !== "" ? editDetails.patch : editDetails.diff;
            core = {
                preview: diffText === "" ? { kind: "none" } : { kind: "diff", diff: diffText },
                warnings: [],
                output: input.output,
            };
            break;
        }
        case "write":
            core = {
                preview: buildWritePreview(input),
                warnings: [],
                output: input.output,
            };
            break;
        case "read":
            core = buildReadPresentation(input);
            break;
        case "bash":
        case "powershell":
            core = {
                preview: { kind: "none" },
                warnings: buildShellWarnings(parseShellToolDetails(input.details)),
                output: input.output,
            };
            break;
        case "grep": {
            const grepDetails = parseGrepToolDetails(input.details);
            core = {
                preview: { kind: "none" },
                warnings:
                    grepDetails === null
                        ? []
                        : buildLimitTruncationWarnings(
                              grepDetails.matchLimitReached !== undefined
                                  ? `${grepDetails.matchLimitReached} matches limit`
                                  : null,
                              grepDetails.truncation,
                              grepDetails.linesTruncated ? "some lines truncated" : undefined,
                          ),
                output: input.output,
            };
            break;
        }
        case "find": {
            const findDetails = parseFindToolDetails(input.details);
            core = {
                preview: { kind: "none" },
                warnings:
                    findDetails === null
                        ? []
                        : buildLimitTruncationWarnings(
                              findDetails.resultLimitReached !== undefined
                                  ? `${findDetails.resultLimitReached} results limit`
                                  : null,
                              findDetails.truncation,
                          ),
                output: input.output,
            };
            break;
        }
        case "ls": {
            const lsDetails = parseLsToolDetails(input.details);
            core = {
                preview: { kind: "none" },
                warnings:
                    lsDetails === null
                        ? []
                        : buildLimitTruncationWarnings(
                              lsDetails.entryLimitReached !== undefined
                                  ? `${lsDetails.entryLimitReached} entries limit`
                                  : null,
                              lsDetails.truncation,
                          ),
                output: input.output,
            };
            break;
        }
        case "codemode":
            core = buildCodemodePresentation(input, codemodeDetails);
            break;
        case "tool_search":
        case "generic":
            core = {
                preview: { kind: "none" },
                warnings: buildShellWarnings(parseShellToolDetails(input.details)),
                output: input.output,
            };
            break;
        default:
            return assertNever(input.toolKind);
    }

    return { ...core, nestedCalls };
}
