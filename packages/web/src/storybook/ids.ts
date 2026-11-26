import { parseSessionId, type SessionId } from "@pivia/protocol";

/**
 * Parses a story session id. A bad literal is a story bug, so it fails at module load instead of
 * rendering a row with an invalid id.
 */
export function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid story session id: ${raw}`);
    }
    return parsed;
}
