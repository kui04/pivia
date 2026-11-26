import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionModelInfo, SessionRpcCommand, SessionStateSnapshot } from "@pivia/protocol";

import type { SessionRpcResponseMessage } from "@/lib/transport";

/** Unique client-side identifier for one staged image attachment. */
declare const AttachmentIdBrand: unique symbol;
export type AttachmentId = string & { readonly [AttachmentIdBrand]: "AttachmentId" };

/** Validated image attachment staged for the next composer submission. */
export interface StagedImageAttachment {
    readonly id: AttachmentId;
    readonly name: string;
    readonly byteLength: number;
    readonly image: ImageContent;
}

/** Typed failure returned when reading or validating user-supplied image files fails. */
export type AttachmentReadError =
    | { readonly kind: "unsupported_type"; readonly name: string; readonly mimeType: string }
    | { readonly kind: "too_large"; readonly name: string; readonly byteLength: number; readonly maxBytes: number }
    | { readonly kind: "read_failed"; readonly name: string; readonly message: string };

/** Boundary result for reading image attachments from file pickers or clipboard pastes. */
export interface AttachmentReadResult {
    readonly attachments: readonly StagedImageAttachment[];
    readonly errors: readonly AttachmentReadError[];
}

/**
 * Mutually exclusive upward popover panels owned by the composer footer.
 *
 * At most one picker panel is open at a time; the slash command list opens only when `kind === "none"`.
 */
export type ComposerPanel = "none" | "model" | "thinking";

/** Discriminated state for lazy-loaded picker catalogs (models and thinking levels). */
export type PickerCatalogState<T> =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly items: readonly T[] }
    | { readonly kind: "error"; readonly message: string };

/** Local slash commands implemented on top of existing `@pivia/protocol` RPC commands. */
export type LocalSlashCommandName = "compact" | "clear-queue" | "name";

/** One row displayed in the slash command autocomplete popup. */
export interface SlashCommandRow {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    /** Optional argument hint shown beside the command name (for example `<title>`). */
    readonly argHint?: string | undefined;
}

/** Parsed outcome of submitting the composer text and staged attachments. */
export type ComposerSubmission =
    | { readonly kind: "empty" }
    | {
          readonly kind: "prompt";
          readonly message: string;
          readonly images: readonly ImageContent[];
          readonly behavior: "prompt" | "steer" | "followUp";
      }
    | { readonly kind: "local_command"; readonly command: LocalSlashCommandName; readonly args: string }
    | { readonly kind: "blocked_command"; readonly name: string; readonly hint: string };

/** Runtime phase derived from session connection status and `SessionStateSnapshot`. */
export type ComposerRuntimePhase =
    | { readonly kind: "unavailable"; readonly reason: string }
    | {
          readonly kind: "ready";
          readonly isStreaming: boolean;
          readonly isCompacting: boolean;
          readonly model: SessionModelInfo | null;
          readonly thinkingLevel: ThinkingLevel | null;
          readonly queuedCount: number;
          readonly sessionName: string | null;
      };

/** Narrow RPC dispatcher contract consumed by the composer and its child pickers. */
export type ComposerCommandSender = (command: SessionRpcCommand) => Promise<SessionRpcResponseMessage>;

/** Derive {@link ComposerRuntimePhase} from connection readiness and runtime state snapshot. */
export function toComposerRuntimePhase(
    connected: boolean,
    state: SessionStateSnapshot | null,
    unavailableReason: string,
): ComposerRuntimePhase {
    if (!connected || state === null) {
        return { kind: "unavailable", reason: unavailableReason };
    }
    return {
        kind: "ready",
        isStreaming: state.isStreaming,
        isCompacting: state.isCompacting,
        model: state.model,
        thinkingLevel: state.thinkingLevel,
        queuedCount: state.steeringMessages.length + state.followUpMessages.length,
        sessionName: state.name,
    };
}
