import type {
    ImageContent,
    RpcExtensionUIResponse,
    SessionPrefixAnchor,
    ThinkingLevel,
    WsClientCommand,
} from "@pivia/protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageContent(value: unknown): value is ImageContent {
    return (
        isRecord(value) &&
        value.type === "image" &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string"
    );
}

function isValidImages(value: unknown): value is ImageContent[] {
    return Array.isArray(value) && value.every(isImageContent);
}

/**
 * Complete lookup table: adding or removing a member of the SDK `ThinkingLevel` union makes the
 * annotation fail to compile, so this guard cannot silently drift from the SDK.
 */
const THINKING_LEVELS: Readonly<Record<ThinkingLevel, true>> = {
    off: true,
    minimal: true,
    low: true,
    medium: true,
    high: true,
    xhigh: true,
    max: true,
};

function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === "string" && Object.hasOwn(THINKING_LEVELS, value);
}

function withId(fields: Record<string, unknown>): { readonly id?: string } {
    return typeof fields.id === "string" ? { id: fields.id } : {};
}

/** Read a command id from unvalidated input so protocol errors can still be correlated. */
export function commandIdOf(value: unknown): string | undefined {
    return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

/** Parse one `extension_ui_response` payload, or return null when the shape is invalid. */
export function parseExtensionUiResponse(value: unknown): RpcExtensionUIResponse | null {
    if (!isRecord(value) || value.type !== "extension_ui_response" || typeof value.id !== "string") {
        return null;
    }
    if (value.cancelled === true) {
        return { type: "extension_ui_response", id: value.id, cancelled: true };
    }
    if (typeof value.confirmed === "boolean") {
        return { type: "extension_ui_response", id: value.id, confirmed: value.confirmed };
    }
    if (typeof value.value === "string") {
        return { type: "extension_ui_response", id: value.id, value: value.value };
    }
    return null;
}

/**
 * Validate and normalize one client command from parsed JSON.
 *
 * Returns null for unknown types, missing fields, and values that do not match the protocol. Extra
 * fields are ignored so older clients keep working after the server adds optional fields.
 */
export function parseWsClientCommand(value: unknown): WsClientCommand | null {
    if (!isRecord(value) || typeof value.type !== "string") {
        return null;
    }
    if (value.type === "extension_ui_response") {
        return parseExtensionUiResponse(value);
    }
    if (value.id !== undefined && typeof value.id !== "string") {
        return null;
    }
    const id = withId(value);

    switch (value.type) {
        case "prompt": {
            if (typeof value.message !== "string" || (value.images !== undefined && !isValidImages(value.images))) {
                return null;
            }
            if (
                value.streamingBehavior !== undefined &&
                value.streamingBehavior !== "steer" &&
                value.streamingBehavior !== "followUp"
            ) {
                return null;
            }
            return {
                type: "prompt",
                ...id,
                message: value.message,
                ...(value.images === undefined ? {} : { images: value.images }),
                ...(value.streamingBehavior === undefined ? {} : { streamingBehavior: value.streamingBehavior }),
            };
        }
        case "steer":
        case "follow_up": {
            if (typeof value.message !== "string" || (value.images !== undefined && !isValidImages(value.images))) {
                return null;
            }
            const base = {
                ...id,
                message: value.message,
                ...(value.images === undefined ? {} : { images: value.images }),
            };
            return value.type === "steer" ? { type: "steer", ...base } : { type: "follow_up", ...base };
        }
        case "abort":
            return { type: "abort", ...id };
        case "clear_queue":
            return { type: "clear_queue", ...id };
        case "get_state":
            return { type: "get_state", ...id };
        case "get_available_models":
            return { type: "get_available_models", ...id };
        case "get_available_thinking_levels":
            return { type: "get_available_thinking_levels", ...id };
        case "set_model": {
            if (typeof value.provider !== "string" || typeof value.modelId !== "string") {
                return null;
            }
            return { type: "set_model", ...id, provider: value.provider, modelId: value.modelId };
        }
        case "set_thinking_level": {
            if (!isThinkingLevel(value.level)) {
                return null;
            }
            return { type: "set_thinking_level", ...id, level: value.level };
        }
        case "set_session_name": {
            if (typeof value.name !== "string") {
                return null;
            }
            return { type: "set_session_name", ...id, name: value.name };
        }
        case "compact": {
            if (value.customInstructions !== undefined && typeof value.customInstructions !== "string") {
                return null;
            }
            return {
                type: "compact",
                ...id,
                ...(value.customInstructions === undefined ? {} : { customInstructions: value.customInstructions }),
            };
        }
        default:
            return null;
    }
}

/**
 * Parse the optional `afterSeq` query parameter.
 *
 * Returns `undefined` when absent, the non-negative safe integer when valid, and `null` when the
 * value cannot be used for incremental replay.
 */
export function parseAfterSeq(value: unknown): number | undefined | null {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Validated WebSocket handshake anchors parsed at the upgrade boundary. */
export interface ParsedWsHandshakeQuery {
    readonly afterSeq?: number | undefined;
    readonly runtimeId?: string | undefined;
    readonly prefixAnchor?: SessionPrefixAnchor | undefined;
}

/**
 * Parse `/ws/sessions/:id` handshake query parameters.
 *
 * Rejects malformed `afterSeq` with an explicit error (preserving HTTP 400 upgrade checks),
 * while malformed or partial cache hints (`runtimeId`, `entriesVersion`, `entryCount`,
 * `afterEntryId`) gracefully degrade to `undefined` so stale clients fall back to Tier 3.
 */
export function parseWsHandshakeQuery(
    query: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly value: ParsedWsHandshakeQuery } | { readonly ok: false; readonly message: string } {
    const afterSeq = parseAfterSeq(query.afterSeq);
    if (afterSeq === null) {
        return { ok: false, message: "Invalid afterSeq parameter." };
    }

    const runtimeId = typeof query.runtimeId === "string" && query.runtimeId.length > 0 ? query.runtimeId : undefined;

    let prefixAnchor: SessionPrefixAnchor | undefined;
    const { entriesVersion, entryCount, afterEntryId } = query;
    if (
        typeof entriesVersion === "string" &&
        entriesVersion.length > 0 &&
        typeof afterEntryId === "string" &&
        afterEntryId.length > 0 &&
        typeof entryCount === "string" &&
        /^[1-9]\d*$/.test(entryCount)
    ) {
        const parsedCount = Number(entryCount);
        if (Number.isSafeInteger(parsedCount) && parsedCount >= 1) {
            prefixAnchor = {
                entriesVersion,
                afterCount: parsedCount,
                afterEntryId,
            };
        }
    }

    return {
        ok: true,
        value: {
            ...(afterSeq === undefined ? {} : { afterSeq }),
            ...(runtimeId === undefined ? {} : { runtimeId }),
            ...(prefixAnchor === undefined ? {} : { prefixAnchor }),
        },
    };
}
