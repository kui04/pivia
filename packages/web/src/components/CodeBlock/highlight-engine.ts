import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import type { ThemedToken } from "shiki";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

import { type Grammar, type HighlightToken, resolveLanguage } from "./highlight-protocol";

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

function projectToken(token: ThemedToken): HighlightToken {
    if (token.htmlStyle === undefined) {
        return { offset: token.offset, content: token.content };
    }
    return {
        offset: token.offset,
        content: token.content,
        htmlStyle: token.htmlStyle,
    };
}

/** Ensures the Shiki core engine and requested grammar are ready before synchronous tokenization. */
export async function prepareHighlightGrammar(grammarId: string): Promise<Grammar | undefined> {
    const grammar = resolveLanguage(grammarId);
    if (grammar === undefined) {
        return undefined;
    }

    const core = await getHighlighter();
    await loadGrammar(core, grammar);
    return grammar;
}

/** Tokenizes `code` synchronously with an already-loaded grammar and strips tokens to render fields. */
export async function tokenizePreparedGrammar(
    code: string,
    grammarId: string,
): Promise<readonly (readonly HighlightToken[])[]> {
    const core = await getHighlighter();
    const result = core.codeToTokens(code, {
        lang: grammarId,
        themes: { light: "light-plus", dark: "dark-plus" },
        defaultColor: false,
    });
    return result.tokens.map((line) => line.map(projectToken));
}
