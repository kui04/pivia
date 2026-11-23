import type { ParsedSkillBlock } from "@earendil-works/pi-coding-agent";

/**
 * Skill invocation as the Pi terminal client writes it into a user message.
 *
 * The pattern matches the SDK parser in `pi-coding-agent` (`core/agent-session.ts`) so both views
 * split the same text: the block starts the message, holds the skill body, and may end with the
 * prompt the reader typed after the command.
 */
const SKILL_BLOCK_PATTERN = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * Split a skill block from the prompt that follows it.
 *
 * Returns null for any text that is not exactly one block, so a prompt that merely mentions
 * `<skill>` keeps rendering as a user bubble.
 *
 * @param rawText - Trimmed text of one user message.
 * @returns The block fields, or null when the text is not a skill invocation.
 */
export function parseSkillBlock(rawText: string): ParsedSkillBlock | null {
    const match = SKILL_BLOCK_PATTERN.exec(rawText);
    if (match === null) {
        return null;
    }
    const [, name, location, content, userMessage] = match;
    if (name === undefined || location === undefined || content === undefined) {
        return null;
    }
    return { name, location, content, userMessage: userMessage?.trim() || undefined };
}
