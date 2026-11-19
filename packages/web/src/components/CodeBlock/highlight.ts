import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import type { ThemedToken } from "shiki";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguagesInfo } from "shiki/langs";

type Grammar = (typeof bundledLanguagesInfo)[number];

/**
 * Every grammar Shiki ships is listed here, with its aliases (`ts`, `sh`, `yml`
 * and friends). Each one is a dynamic import, so a conversation only parses the
 * grammars it renders; the chunks ship inside the app bundle either way, and
 * loading one from local assets is cheap.
 */
const grammars = new Map<string, Grammar>();
for (const grammar of bundledLanguagesInfo) {
    grammars.set(grammar.id, grammar);
    for (const alias of grammar.aliases ?? []) {
        grammars.set(alias, grammar);
    }
}

let highlighter: Promise<HighlighterCore> | undefined;
const grammarLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
    highlighter ??= createHighlighterCore({
        themes: [lightPlus, darkPlus],
        langs: [],
        // The inlined wasm keeps the engine exact without a separate asset request.
        engine: createOnigurumaEngine(import("shiki/wasm")),
    }).catch((error: unknown) => {
        // Retry on the next call instead of caching the failure.
        highlighter = undefined;
        throw error;
    });
    return highlighter;
}

async function loadGrammar(core: HighlighterCore, grammar: Grammar): Promise<void> {
    let load = grammarLoads.get(grammar.id);

    if (load === undefined) {
        load = core
            .loadLanguage(grammar.import())
            .then(() => undefined)
            .catch((error: unknown) => {
                // Retry on the next call instead of caching the failure.
                grammarLoads.delete(grammar.id);
                throw error;
            });
        grammarLoads.set(grammar.id, load);
    }

    await load;
}

/** Resolves a fence name or alias to a Shiki grammar. */
export function resolveLanguage(language: string): Grammar | undefined {
    return grammars.get(language.toLowerCase());
}

/**
 * Tokenizes `code` for the light and dark themes at once. Every token carries
 * `--shiki-light` and `--shiki-dark`, so the caller paints it with the same
 * `color-scheme` and `data-theme` rules as the design tokens.
 *
 * Returns undefined for a language Shiki does not ship, and rejects when the
 * grammar or the engine fails; the caller keeps rendering plain text.
 */
export async function highlight(code: string, language: string): Promise<ThemedToken[][] | undefined> {
    const grammar = resolveLanguage(language);
    if (grammar === undefined) {
        return undefined;
    }

    const core = await getHighlighter();
    await loadGrammar(core, grammar);

    return core.codeToTokens(code, {
        lang: grammar.id,
        themes: { light: "light-plus", dark: "dark-plus" },
        defaultColor: false,
    }).tokens;
}
