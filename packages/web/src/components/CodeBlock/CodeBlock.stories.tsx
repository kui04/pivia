import type { Meta, StoryObj } from "@storybook/react-vite";
import { Play } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
    mockClipboardFailure,
    mockClipboardSuccess,
    requireElement,
    requireViewport,
    waitForDarkTheme,
} from "@/storybook/dom";
import { DarkTheme } from "@/storybook/theme";

import { IconButton } from "../IconButton";

import { CodeBlock } from "./CodeBlock";

const greeting = `export function greet(name: string): string {
  return \`hello \${name}\`;
}`;

const longLine = `const endpoint = "https://example.com/api/v1/records?filter=status%3Dactive&sort=createdAt%3Adesc&page=1";`;

const hugeLine = `const payload = "${"abc".repeat(120)}";`;

const diff = `--- a/greet.ts
+++ b/greet.ts
@@ -1,3 +1,3 @@
 export function greet(name: string): string {
-  return "hello";
+  return \`hello \${name}\`;
 }
`;

const meta = {
    title: "Components/CodeBlock",
    component: CodeBlock,
    args: {
        code: greeting,
        language: "ts",
    },
} satisfies Meta<typeof CodeBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const code = requireElement(canvasElement.querySelector("pre code"), "the code element");
        const label = requireElement(
            canvasElement.querySelector("[data-slot='code-block-language']"),
            "the language label",
        );

        await expect(label).toHaveTextContent("ts");

        // Highlighting is async: the plain text must be replaced by Shiki spans.
        await waitFor(() => expect(code.querySelector("[style*='--shiki-dark']")).not.toBeNull(), { timeout: 5000 });
    },
};

function StreamingCodeBlock() {
    const [streaming, setStreaming] = useState(true);

    return (
        <div>
            <IconButton label="Finish stream" radius="full" onClick={() => setStreaming(false)}>
                <Play />
            </IconButton>
            {/* The control loads Shiki without a streaming gate, so its completion proves the engine is ready. */}
            <div data-testid="codeblock-shiki-control" hidden>
                <CodeBlock code={greeting} language="ts" />
            </div>
            <div data-testid="codeblock-streaming">
                <CodeBlock code={greeting} language="ts" streaming={streaming} />
            </div>
        </div>
    );
}

export const Streaming: Story = {
    render: () => <StreamingCodeBlock />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const control = requireElement(
            canvasElement.querySelector("[data-testid='codeblock-shiki-control']"),
            "the control code block",
        );
        const streamingBlock = requireElement(
            canvasElement.querySelector("[data-testid='codeblock-streaming']"),
            "the streaming code block",
        );

        const controlCode = requireElement(control.querySelector("pre code"), "the control code element");
        const streamingCode = requireElement(streamingBlock.querySelector("pre code"), "the streaming code element");

        // Wait for the ungated control to load Shiki. A gated block must still be
        // plain once the same grammar and engine are ready.
        await waitFor(() => expect(controlCode.querySelector("span[style*='--shiki']")).not.toBeNull(), {
            timeout: 5000,
        });
        await expect(streamingCode.querySelector("span[style*='--shiki']")).toBeNull();

        await userEvent.click(canvas.getByRole("button", { name: "Finish stream" }));

        // The code does not change: only the streaming flag flips, which covers
        // the effect dependency that the Markdown streaming story cannot isolate.
        await waitFor(() => expect(streamingCode.querySelector("span[style*='--shiki']")).not.toBeNull(), {
            timeout: 5000,
        });
    },
};

export const Wrapped: Story = {
    args: {
        code: longLine,
        defaultWrap: true,
    },
};

export const Dark: Story = {
    decorators: [DarkTheme],
    play: async ({ canvasElement }) => {
        await waitForDarkTheme();
        await waitFor(() => expect(canvasElement.querySelector("code span[style]")).not.toBeNull(), { timeout: 5000 });

        const token = requireElement(
            canvasElement.querySelector<HTMLElement>("code span[style]"),
            "a highlighted token",
        );

        // The computed colour must come from the dark variable, not the light one.
        const dark = token.style.getPropertyValue("--shiki-dark").trim();
        const channels = [1, 3, 5].map((start) => Number.parseInt(dark.slice(start, start + 2), 16));

        await expect(getComputedStyle(token).color).toBe(`rgb(${channels.join(", ")})`);
    },
};

export const LineNumbers: Story = {
    args: {
        lineNumbers: true,
        startLine: 12,
    },
    play: async ({ canvasElement }) => {
        const pre = requireElement(canvasElement.querySelector("pre"), "the pre element");
        const labels = [...canvasElement.querySelectorAll("[data-slot='code-block-line-number']")].map(
            (node) => node.textContent,
        );

        await expect(pre.hasAttribute("data-numbered")).toBe(true);
        await expect(labels).toEqual(["12", "13", "14"]);
    },
};

export const Diff: Story = {
    args: {
        code: diff,
        language: "diff",
    },
    play: async ({ canvasElement }) => {
        const markers = [...canvasElement.querySelectorAll("[data-slot='code-block-marker']")].map(
            (node) => node.textContent,
        );
        const contentLefts = [...canvasElement.querySelectorAll("[data-slot='code-block-line-content']")].map((node) =>
            Math.round(node.getBoundingClientRect().left),
        );
        const added = canvasElement.querySelectorAll("[data-slot='code-block-line'][data-variant='added']");
        const removed = canvasElement.querySelectorAll("[data-slot='code-block-line'][data-variant='removed']");

        // The sign sits in its own column: file headers and context lines have an
        // empty marker, so the code starts on one x for every row.
        await expect(markers).toEqual(["", "", "", "", "-", "+", "", ""]);
        await expect(new Set(contentLefts).size).toBe(1);
        await expect(added.length).toBe(1);
        await expect(removed.length).toBe(1);
    },
};

export const StickyLineNumbers: Story = {
    args: {
        code: hugeLine,
        lineNumbers: true,
    },
    play: async ({ canvasElement }) => {
        const gutter = requireElement(
            canvasElement.querySelector("[data-slot='code-block-line-number']"),
            "the gutter",
        );
        const viewport = requireViewport(canvasElement, "the code scroller");
        const bar = requireElement(
            canvasElement.querySelector<HTMLElement>(
                "[data-slot='scroll-area-scrollbar'][data-orientation='horizontal']",
            ),
            "the horizontal scrollbar",
        );

        await expect(viewport).toHaveAttribute("aria-label", "ts code");
        await expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        await expect(getComputedStyle(bar).opacity).toBe("1");

        const before = Math.round(gutter.getBoundingClientRect().left);

        viewport.scrollLeft = 240;
        await waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));

        // A sticky gutter keeps its x while the code scrolls underneath it.
        await expect(Math.round(gutter.getBoundingClientRect().left)).toBe(before);
    },
};

export const WithoutCopy: Story = {
    args: {
        copyable: false,
    },
};

export const Copy: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        const clipboard = mockClipboardSuccess();

        try {
            await userEvent.click(canvas.getByRole("button", { name: "Copy code" }));

            await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Copied"));
            await expect(clipboard.writeText).toHaveBeenCalledWith(greeting);
        } finally {
            clipboard.restore();
        }
    },
};

export const CopyFailure: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        const clipboard = mockClipboardFailure();

        try {
            await userEvent.click(canvas.getByRole("button", { name: "Copy code" }));

            await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Copy failed"));
        } finally {
            clipboard.restore();
        }
    },
};

export const ToggleWrap: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const toggle = canvas.getByRole("button", { name: "Wrap lines" });
        const pre = requireElement(canvasElement.querySelector("pre"), "the pre element");

        await expect(getComputedStyle(pre).whiteSpace).toBe("pre");

        await userEvent.click(toggle);

        await expect(toggle.getAttribute("aria-pressed")).toBe("true");
        await expect(getComputedStyle(pre).whiteSpace).toBe("pre-wrap");
    },
};
