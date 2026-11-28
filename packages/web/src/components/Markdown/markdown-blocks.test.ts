import { describe, expect, it } from "vitest";

import { createMarkdownBlockPlanner, type MarkdownBlockPlan } from "./markdown-blocks";

/**
 * The plan is a partition, so no character may be lost or duplicated across the pieces.
 *
 * Every case below goes through this check; a boundary rule that drops or repeats text fails even
 * when the expected pieces match.
 */
function expectPartition(source: string, plan: MarkdownBlockPlan): void {
    expect(plan.blocks.join("") + plan.tail).toBe(source);
    for (const block of plan.blocks) {
        expect(block).not.toBe("");
    }
}

/** Plans a source once, the way a freshly mounted message does. */
function planOnce(source: string): MarkdownBlockPlan {
    return createMarkdownBlockPlanner().plan(source);
}

describe("createMarkdownBlockPlanner", () => {
    it("keeps an empty source in the tail", () => {
        const plan = planOnce("");

        expect(plan).toEqual({ blocks: [], tail: "", requiresWholeDocument: false });
    });

    it("keeps a single incomplete paragraph in the tail", () => {
        const source = "The answer is still growing";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual([]);
        expect(plan.tail).toBe(source);
        expectPartition(source, plan);
    });

    it("closes all but the last top-level block", () => {
        const source = "First paragraph.\n\nSecond paragraph.";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual(["First paragraph.\n\n"]);
        expect(plan.tail).toBe("Second paragraph.");
        expectPartition(source, plan);
    });

    it("keeps a loose list in one block", () => {
        const source = "- one\n\n- two\n\nAfter.";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual(["- one\n\n- two\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("keeps an ordered list whose items repeat the same marker in one block", () => {
        const source = "1. one\n\n1. two\n\nAfter.";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual(["1. one\n\n1. two\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("keeps a nested list and its continuation in one block", () => {
        const source = "- one\n\n    continued\n\n    - nested\n\nAfter.";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual(["- one\n\n    continued\n\n    - nested\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("keeps an indented code block across its blank line", () => {
        const source = "Before.\n\n    a\n\n    b\n\nAfter.";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual(["Before.\n\n", "    a\n\n    b\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("cuts between two blockquotes the whole document also keeps separate", () => {
        const source = "> one\n\n> two\n\nAfter.";
        const plan = planOnce(source);

        // A plain blank line ends a blockquote, so the whole document renders two of them and the
        // split agrees; a `>` continuation line is not blank, so it never cuts there.
        expect(plan.blocks).toEqual(["> one\n\n", "> two\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("keeps a fenced code block across its blank line", () => {
        const source = "Before.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual(["Before.\n\n", "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("keeps a display math block across its blank line", () => {
        const source = "Before.\n\n$$\na = b\n\nc = d\n$$\n\nAfter.";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual(["Before.\n\n", "$$\na = b\n\nc = d\n$$\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("keeps a table in one block", () => {
        const source = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.";
        const plan = planOnce(source);

        expect(plan.blocks).toEqual(["| a | b |\n| --- | --- |\n| 1 | 2 |\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("requires one document when a reference definition appears", () => {
        const source = "See [docs][1].\n\n[1]: https://example.com";
        const plan = planOnce(source);

        expect(plan.requiresWholeDocument).toBe(true);
        expect(plan.blocks).toEqual([]);
        expect(plan.tail).toBe(source);
    });

    it("requires one document when a footnote definition appears", () => {
        const source = "Text[^1].\n\n[^1]: The note.";
        const plan = planOnce(source);

        expect(plan.requiresWholeDocument).toBe(true);
        expectPartition(source, plan);
    });

    it("keeps inline links in blocks", () => {
        const source = "See [docs](https://example.com).\n\nAfter.";
        const plan = planOnce(source);

        expect(plan.requiresWholeDocument).toBe(false);
        expect(plan.blocks).toEqual(["See [docs](https://example.com).\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("returns the cached plan when the same source arrives twice", () => {
        const planner = createMarkdownBlockPlanner();
        const source = "First.\n\nSecond.";

        expect(planner.plan(source)).toBe(planner.plan(source));
    });

    it("matches a fresh plan at every prefix", () => {
        const source = [
            "# Title",
            "",
            "- one",
            "",
            "- two",
            "",
            "```ts",
            "const a = 1;",
            "",
            "const b = 2;",
            "```",
            "",
            "| a | b |",
            "| --- | --- |",
            "| 1 | 2 |",
            "",
            "> quoted",
            "",
            "Last paragraph.",
        ].join("\n");

        const incremental = createMarkdownBlockPlanner();
        for (let length = 0; length <= source.length; length += 1) {
            const prefix = source.slice(0, length);
            const plan = incremental.plan(prefix);
            const fresh = planOnce(prefix);

            expect(plan.blocks).toEqual(fresh.blocks);
            expect(plan.tail).toBe(fresh.tail);
            expect(plan.requiresWholeDocument).toBe(fresh.requiresWholeDocument);
            expectPartition(prefix, plan);
        }
    });

    it("never changes a closed block when the source grows", () => {
        const source = "First.\n\nSecond.\n\n```\ncode\n```\n\nLast.";
        const planner = createMarkdownBlockPlanner();
        let previous: MarkdownBlockPlan | null = null;

        for (let length = 0; length <= source.length; length += 1) {
            const plan = planner.plan(source.slice(0, length));
            if (previous !== null) {
                const stable = Math.min(previous.blocks.length, plan.blocks.length);
                expect(plan.blocks.slice(0, stable)).toEqual(previous.blocks.slice(0, stable));
            }
            previous = plan;
        }
    });

    it("starts from scratch when the source is replaced", () => {
        const planner = createMarkdownBlockPlanner();
        planner.plan("First message.\n\nStill here.");

        const replaced = "A different message.\n\nWith two blocks.";
        expect(planner.plan(replaced)).toEqual(planOnce(replaced));
    });

    it("reuses the block array while no block closes", () => {
        const planner = createMarkdownBlockPlanner();
        const first = planner.plan("First.\n\nSecond");
        const second = planner.plan("First.\n\nSecond line");

        expect(second.blocks).toBe(first.blocks);
        expect(second.tail).toBe("Second line");
    });

    it("requires one document when a definition precedes its use", () => {
        const source = "[1]: https://example.com\n\nSee [docs][1].";
        const plan = planOnce(source);

        expect(plan.requiresWholeDocument).toBe(true);
        expectPartition(source, plan);
    });

    it("does not require one document when the only definition sits in a fence", () => {
        const source = "See [docs][1].\n\n```\n[1]: https://example.com\n```\n\nAfter.";
        const plan = planOnce(source);

        // A reference without a definition stays literal text in the same parse, so the blocks
        // render exactly what the whole document would.
        expect(plan.requiresWholeDocument).toBe(false);
        expect(plan.blocks).toEqual(["See [docs][1].\n\n", "```\n[1]: https://example.com\n```\n\n"]);
        expect(plan.tail).toBe("After.");
        expectPartition(source, plan);
    });

    it("keeps coupling after a footnote definition appears and the source grows", () => {
        const planner = createMarkdownBlockPlanner();
        expect(planner.plan("Text[^1].").requiresWholeDocument).toBe(false);

        const source = "Text[^1].\n\n[^1]: The note.\n\nAfter.";
        const plan = planner.plan(source);

        expect(plan.requiresWholeDocument).toBe(true);
        expectPartition(source, plan);
    });

    it("keeps coupling after a reference appears and the source grows", () => {
        const planner = createMarkdownBlockPlanner();
        const first = "See [docs][1].";
        expect(planner.plan(first).requiresWholeDocument).toBe(false);

        const second = `${first}\n\n[1]: https://example.com\n\nAfter.`;
        const plan = planner.plan(second);
        expect(plan.requiresWholeDocument).toBe(true);
        expect(plan.blocks).toEqual([]);
        expectPartition(second, plan);
    });
});
