import type { ImageContent } from "@earendil-works/pi-ai";

import { Fuzzy } from "@/lib";

import type { ComposerSubmission, LocalSlashCommandName, SlashCommandRow } from "../../types";

/** Definition of one local slash command executable through `@pivia/protocol`. */
export interface LocalSlashCommandSpec {
    readonly name: LocalSlashCommandName;
    readonly description: string;
    readonly argHint?: string | undefined;
}

/** Built-in local slash commands mapped to existing Pivia protocol commands. */
export const LOCAL_SLASH_COMMANDS: readonly LocalSlashCommandSpec[] = [
    { name: "compact", description: "Compact conversation context", argHint: "[instructions]" },
    { name: "name", description: "Set session display name", argHint: "<name>" },
    { name: "clear-queue", description: "Clear queued steering and follow-up messages" },
];

const LOCAL_COMMAND_NAMES: Readonly<Record<string, LocalSlashCommandName>> = {
    compact: "compact",
    name: "name",
    "clear-queue": "clear-queue",
};

const BLOCKED_HINTS: Readonly<Record<string, string>> = {
    model: "Choose the model from the picker at the bottom of the composer.",
    thinking: "Choose the thinking level from the picker at the bottom of the composer.",
    session: "Manage sessions from the sidebar or top bar.",
    resume: "Switch sessions from the workspace sidebar.",
};

const SKILL_PREFIX = "skill:";

function bareCommandName(name: string): string {
    return name.startsWith(SKILL_PREFIX) ? name.slice(SKILL_PREFIX.length) : name;
}

/**
 * Extract the leading slash command token (without `/`) when the input begins with `/`.
 *
 * Returns `""` for a bare `/` and `null` when the text does not start with `/`.
 */
export function slashName(text: string): string | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/")) {
        return null;
    }
    return trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
}

/**
 * Filter and rank slash command autocomplete rows for the current query token.
 *
 * Accepts optional remote/extension commands so the UI is ready once `get_commands` lands.
 */
export function commandRows(
    query: string,
    remoteCommands: readonly SlashCommandRow[] = [],
): readonly SlashCommandRow[] {
    const localRows: SlashCommandRow[] = LOCAL_SLASH_COMMANDS.map((spec) => ({
        id: `local-${spec.name}`,
        name: spec.name,
        description: spec.description,
        ...(spec.argHint === undefined ? {} : { argHint: spec.argHint }),
    }));
    const rows = [...localRows, ...remoteCommands];

    const bare = Fuzzy.filter(rows, query, (row) => bareCommandName(row.name));
    const found = new Set(bare.map((row) => row.id));
    const full = Fuzzy.filter(
        rows.filter((row) => row.name.startsWith(SKILL_PREFIX) && !found.has(row.id)),
        query,
        (row) => row.name,
    );
    return [...bare, ...full];
}

/**
 * Parse the composer text and staged images into a total {@link ComposerSubmission} sum type.
 *
 * Prevents unknown or terminal-only slash commands (`/model`, `/thinking`, `/foo`) from leaking
 * to the model as plain text prompts.
 */
export function parseComposerSubmission(
    text: string,
    images: readonly ImageContent[],
    behavior: "prompt" | "steer" | "followUp",
    remoteCommandNames: readonly string[] = [],
): ComposerSubmission {
    const trimmed = text.trim();
    if (trimmed.length === 0 && images.length === 0) {
        return { kind: "empty" };
    }

    const name = slashName(trimmed);
    if (name !== null) {
        if (name.length === 0) {
            return {
                kind: "blocked_command",
                name: "",
                hint: "Type a command after the slash.",
            };
        }

        const localCommand = LOCAL_COMMAND_NAMES[name];
        if (localCommand !== undefined && Object.hasOwn(LOCAL_COMMAND_NAMES, name)) {
            const args = trimmed.slice(1 + name.length).trim();
            return {
                kind: "local_command",
                command: localCommand,
                args,
            };
        }

        if (remoteCommandNames.includes(name)) {
            return {
                kind: "prompt",
                message: trimmed,
                images,
                behavior,
            };
        }

        return {
            kind: "blocked_command",
            name,
            hint: BLOCKED_HINTS[name] ?? `/${name} is not an available command.`,
        };
    }

    return {
        kind: "prompt",
        message: trimmed,
        images,
        behavior,
    };
}
