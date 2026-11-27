import { describe, expect, it } from "vitest";

import { remarkCurrency } from "./remark-currency";

type TestNode = {
    type: string;
    value?: string | undefined;
    children?: TestNode[] | undefined;
    position?:
        | {
              start?: { offset?: number | undefined } | undefined;
              end?: { offset?: number | undefined } | undefined;
          }
        | undefined;
};

function inlineMath(value: string, start: number, end: number): TestNode {
    return {
        type: "inlineMath",
        value,
        position: { start: { offset: start }, end: { offset: end } },
    };
}

function run(tree: TestNode, source: string): TestNode {
    remarkCurrency()(tree, { value: source });
    return tree;
}

/** Runs the plugin over a root node with `children` and returns the transformed root. */
function runRoot(children: TestNode[], source: string): TestNode {
    return run({ type: "root", children }, source);
}

describe("remarkCurrency", () => {
    it("restores the first amount in a pair of prices", () => {
        const source = "It costs $5 and $10.";
        const tree = runRoot(
            [{ type: "text", value: "It costs " }, inlineMath("5 and ", 9, 17), { type: "text", value: "10." }],
            source,
        );

        expect(tree.children?.[0]).toEqual({ type: "text", value: "It costs " });
        expect(tree.children?.[1]).toEqual({ type: "text", value: "$5 and $" });
        expect(tree.children?.[2]).toEqual({ type: "text", value: "10." });
        expect((tree.children ?? []).map((child) => child.value ?? "").join("")).toBe(source);
    });

    it("keeps a single-letter formula", () => {
        const tree = runRoot([inlineMath("x", 0, 3)], "$x$");

        expect(tree.children?.[0]).toEqual(inlineMath("x", 0, 3));
    });

    it("keeps a formula followed by a digit", () => {
        const tree = runRoot([inlineMath("x", 0, 3), { type: "text", value: "5" }], "$x$5");

        expect(tree.children?.[0]?.type).toBe("inlineMath");
    });

    it("keeps a mathematical expression with an operator", () => {
        const tree = runRoot([inlineMath("5 + 5", 0, 7)], "$5 + 5$");

        expect(tree.children?.[0]?.type).toBe("inlineMath");
    });

    it("restores an amount followed by a unit", () => {
        const tree = runRoot([inlineMath("5 km", 0, 6)], "$5 km$");

        expect(tree.children?.[0]).toEqual({ type: "text", value: "$5 km$" });
    });

    it("restores a pair of decimal prices", () => {
        const source = "$.50 and $.75";
        const tree = runRoot([inlineMath(".50 and ", 0, 10), { type: "text", value: ".75" }], source);

        expect(tree.children?.[0]).toEqual({ type: "text", value: "$.50 and $" });
        expect(tree.children?.[1]).toEqual({ type: "text", value: ".75" });
    });

    it("leaves display math alone", () => {
        const tree = runRoot([{ type: "math", value: "5 + 5" }], "$$\n5 + 5\n$$");

        expect(tree.children?.[0]?.type).toBe("math");
    });

    it("walks nested content", () => {
        const source = "$5 and $10";
        const tree = runRoot(
            [
                {
                    type: "paragraph",
                    children: [inlineMath("5 and ", 0, 8), { type: "text", value: "10" }],
                },
            ],
            source,
        );

        expect(tree.children?.[0]?.children?.[0]).toEqual({ type: "text", value: "$5 and $" });
    });
});
