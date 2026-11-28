import { bundledLanguagesInfo } from "shiki/langs";

export type Grammar = (typeof bundledLanguagesInfo)[number];

/**
 * Every grammar Shiki ships is listed here, with its aliases (`ts`, `sh`, `yml`
 * and friends). Keeping language metadata separate from the WASM highlighter lets
 * the main thread resolve fences and diff blocks synchronously without importing
 * the Shiki engine.
 */
const grammars = new Map<string, Grammar>();
for (const grammar of bundledLanguagesInfo) {
    grammars.set(grammar.id, grammar);
    for (const alias of grammar.aliases ?? []) {
        grammars.set(alias, grammar);
    }
}

/** Resolves a fence name or alias to a Shiki grammar. */
export function resolveLanguage(language: string): Grammar | undefined {
    return grammars.get(language.toLowerCase());
}

/** Minimal token payload transferred from the highlight worker to the main thread. */
export interface HighlightToken {
    readonly offset: number;
    readonly content: string;
    readonly htmlStyle?: Record<string, string> | undefined;
}

/** Messages sent from the main thread to the Shiki highlight worker. */
export type HighlightWorkerRequest =
    | {
          readonly kind: "highlight";
          readonly id: number;
          readonly code: string;
          readonly grammarId: string;
      }
    | {
          readonly kind: "cancel";
          readonly id: number;
      };

/** Messages sent back from the Shiki highlight worker to the main thread. */
export type HighlightWorkerResponse =
    | {
          readonly kind: "result";
          readonly id: number;
          readonly tokens: readonly (readonly HighlightToken[])[];
      }
    | {
          readonly kind: "cancelled";
          readonly id: number;
      }
    | {
          readonly kind: "error";
          readonly id: number;
          readonly message: string;
      };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!isRecord(value)) {
        return false;
    }
    for (const entry of Object.values(value)) {
        if (typeof entry !== "string") {
            return false;
        }
    }
    return true;
}

function isHighlightToken(value: unknown): value is HighlightToken {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.offset !== "number" || typeof value.content !== "string") {
        return false;
    }
    return value.htmlStyle === undefined || isStringRecord(value.htmlStyle);
}

function isTokenMatrix(value: unknown): value is readonly (readonly HighlightToken[])[] {
    if (!Array.isArray(value)) {
        return false;
    }
    for (const line of value) {
        if (!Array.isArray(line)) {
            return false;
        }
        for (const token of line) {
            if (!isHighlightToken(token)) {
                return false;
            }
        }
    }
    return true;
}

/** Validates incoming messages in `highlight.worker.ts`. */
export function parseHighlightWorkerRequest(value: unknown): HighlightWorkerRequest | undefined {
    if (!isRecord(value) || typeof value.id !== "number") {
        return undefined;
    }
    if (value.kind === "cancel") {
        return { kind: "cancel", id: value.id };
    }
    if (value.kind === "highlight" && typeof value.code === "string" && typeof value.grammarId === "string") {
        return { kind: "highlight", id: value.id, code: value.code, grammarId: value.grammarId };
    }
    return undefined;
}

/** Validates worker replies received on the main thread. */
export function parseHighlightWorkerResponse(value: unknown): HighlightWorkerResponse | undefined {
    if (!isRecord(value) || typeof value.id !== "number") {
        return undefined;
    }
    if (value.kind === "cancelled") {
        return { kind: "cancelled", id: value.id };
    }
    if (value.kind === "error" && typeof value.message === "string") {
        return { kind: "error", id: value.id, message: value.message };
    }
    if (value.kind === "result" && isTokenMatrix(value.tokens)) {
        return { kind: "result", id: value.id, tokens: value.tokens };
    }
    return undefined;
}
