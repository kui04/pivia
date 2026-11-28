import { afterEach, describe, expect, it } from "vitest";

import {
    createWorkerHighlightExecutor,
    highlight,
    type HighlightWorkerPort,
    resolveLanguage,
    setHighlightExecutorForTests,
} from "./highlight";
import type { HighlightWorkerRequest, HighlightWorkerResponse } from "./highlight-protocol";

describe("resolveLanguage", () => {
    it("resolves grammar ids and aliases without case sensitivity", () => {
        expect(resolveLanguage("typescript")?.id).toBe("typescript");
        expect(resolveLanguage("TS")?.id).toBe("typescript");
        expect(resolveLanguage("tsx")?.id).toBe("tsx");
    });

    it("returns undefined for a grammar that Shiki does not ship", () => {
        expect(resolveLanguage("not-a-language")).toBeUndefined();
    });
});

describe("highlight", () => {
    it("returns undefined for an unknown grammar without loading the engine", async () => {
        await expect(highlight("const answer = 42;", "not-a-language")).resolves.toBeUndefined();
    });

    it("tokenizes code for both themes and preserves the source text", async () => {
        const code = "const answer: number = 42;\nconsole.log(answer);";
        const tokens = await highlight(code, "ts");

        expect(tokens).toBeDefined();

        const reconstructed = (tokens ?? []).map((line) => line.map((token) => token.content).join("")).join("\n");

        expect(reconstructed).toBe(code);
        expect(
            (tokens ?? []).flat().some((token) => {
                const style = token.htmlStyle ?? {};
                return "--shiki-light" in style && "--shiki-dark" in style;
            }),
        ).toBe(true);
    }, 15_000);

    it("returns undefined immediately when aborted before start", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(highlight("const x = 1;", "ts", { signal: controller.signal })).resolves.toBeUndefined();
    });
});

function createFakeWorkerPort(): {
    port: HighlightWorkerPort;
    sent: HighlightWorkerRequest[];
    emitMessage: (payload: HighlightWorkerResponse) => void;
    emitError: () => void;
    isTerminated: () => boolean;
} {
    const messageListeners = new Set<(event: { readonly data: unknown }) => void>();
    const errorListeners = new Set<(event: { readonly data: unknown }) => void>();
    const sent: HighlightWorkerRequest[] = [];
    let terminated = false;

    const port: HighlightWorkerPort = {
        postMessage(message) {
            sent.push(message);
        },
        addEventListener(
            type: "message" | "error" | "messageerror",
            listener: (event: { readonly data: unknown }) => void,
        ) {
            if (type === "message") {
                messageListeners.add(listener);
            } else {
                errorListeners.add(listener);
            }
        },
        removeEventListener(
            type: "message" | "error" | "messageerror",
            listener: (event: { readonly data: unknown }) => void,
        ) {
            if (type === "message") {
                messageListeners.delete(listener);
            } else {
                errorListeners.delete(listener);
            }
        },
        terminate() {
            terminated = true;
        },
    };

    return {
        port,
        sent,
        emitMessage(payload) {
            for (const listener of messageListeners) {
                listener({ data: payload });
            }
        },
        emitError() {
            for (const listener of errorListeners) {
                listener({ data: undefined });
            }
        },
        isTerminated() {
            return terminated;
        },
    };
}

describe("createWorkerHighlightExecutor", () => {
    afterEach(() => {
        setHighlightExecutorForTests(undefined);
    });

    it("resolves tokens returned by the worker and cancels aborted in-flight jobs", async () => {
        const fake = createFakeWorkerPort();
        const executor = createWorkerHighlightExecutor(() => fake.port);
        setHighlightExecutorForTests(executor);

        const job1 = highlight("const a = 1;", "ts");
        const controller = new AbortController();
        const job2 = highlight("const b = 2;", "ts", { signal: controller.signal });

        expect(fake.sent).toEqual([
            { kind: "highlight", id: 1, code: "const a = 1;", grammarId: "typescript" },
            { kind: "highlight", id: 2, code: "const b = 2;", grammarId: "typescript" },
        ]);

        controller.abort();
        await expect(job2).resolves.toBeUndefined();
        expect(fake.sent.at(-1)).toEqual({ kind: "cancel", id: 2 });

        fake.emitMessage({
            kind: "result",
            id: 1,
            tokens: [[{ offset: 0, content: "const a = 1;", htmlStyle: { "--shiki-light": "#000" } }]],
        });

        await expect(job1).resolves.toEqual([
            [{ offset: 0, content: "const a = 1;", htmlStyle: { "--shiki-light": "#000" } }],
        ]);
        executor.dispose?.();
    });

    it("fails over in-flight jobs to the fallback executor when the worker errors", async () => {
        const fake = createFakeWorkerPort();
        const fallbackCalls: Array<{ code: string; grammarId: string }> = [];
        const executor = createWorkerHighlightExecutor(
            () => fake.port,
            () => ({
                execute(code, grammarId) {
                    fallbackCalls.push({ code, grammarId });
                    return Promise.resolve([[{ offset: 0, content: code }]]);
                },
            }),
        );

        const promise = executor.execute("let x = 1;", "typescript");
        fake.emitError();

        await expect(promise).resolves.toEqual([[{ offset: 0, content: "let x = 1;" }]]);
        expect(fake.isTerminated()).toBe(true);
        expect(fallbackCalls).toEqual([{ code: "let x = 1;", grammarId: "typescript" }]);
        executor.dispose?.();
    });
});
