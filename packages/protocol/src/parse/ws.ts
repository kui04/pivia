import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

import type { SessionPrefixAnchor } from "../http.ts";
import type { SessionRpcCommand, SessionWsClientMessage } from "../session-ws.ts";
import { parseSyncHandshakeQuery, type SyncHandshake } from "../sync/index.ts";
import { isRecord } from "./primitives.ts";
import { parseSessionPrefixAnchor } from "./session.ts";

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

/** Returns true when `value` is one of the known SDK {@link ThinkingLevel} literals. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === "string" && Object.hasOwn(THINKING_LEVELS, value);
}

function withId(fields: Record<string, unknown>): { readonly id?: string } {
    return typeof fields.id === "string" ? { id: fields.id } : {};
}

/** Read a command or UI request id from unvalidated input so protocol errors can still be correlated. */
export function commandIdOf(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (value.type === "rpc:command" && isRecord(value.command) && typeof value.command.id === "string") {
        return value.command.id;
    }
    if (value.type === "rpc:ui_response" && isRecord(value.response) && typeof value.response.id === "string") {
        return value.response.id;
    }
    return typeof value.id === "string" ? value.id : undefined;
}

/** Parse one `extension_ui_response` payload, or return `null` when the shape is invalid. */
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

/** Parse one control command payload for `rpc:command`, or return `null` when invalid. */
export function parseSessionRpcCommand(value: unknown): SessionRpcCommand | null {
    if (!isRecord(value) || typeof value.type !== "string") {
        return null;
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
 * Validate and normalize one client RPC frame (`rpc:command` or `rpc:ui_response`) from parsed JSON.
 *
 * Returns `null` for unknown types, missing fields, and invalid payloads.
 */
export function parseSessionWsClientMessage(value: unknown): SessionWsClientMessage | null {
    if (!isRecord(value) || typeof value.type !== "string") {
        return null;
    }
    if (value.type === "rpc:command") {
        const command = parseSessionRpcCommand(value.command);
        return command === null ? null : { type: "rpc:command", command };
    }
    if (value.type === "rpc:ui_response") {
        const response = parseExtensionUiResponse(value.response);
        return response === null ? null : { type: "rpc:ui_response", response };
    }
    return null;
}

/**
 * Parse `/ws/sessions/:id` handshake query parameters (`epoch`, `afterSeq`, and optional
 * `SessionPrefixAnchor`). Missing or malformed fields degrade cleanly so the server falls back to
 * a full snapshot.
 */
export function parseSessionWsHandshakeQuery(query: unknown): SyncHandshake<"session", SessionPrefixAnchor> {
    return parseSyncHandshakeQuery<"session", SessionPrefixAnchor>(query, parseSessionPrefixAnchor);
}
