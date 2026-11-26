import type { Meta, StoryObj } from "@storybook/react-vite";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { expect, spyOn, userEvent, waitFor, within } from "storybook/test";

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

function DarkTheme({ children }: { children: ReactNode }) {
    useEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = "dark";

        return () => {
            delete root.dataset.theme;
        };
    }, []);

    return <>{children}</>;
}

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const code = canvasElement.querySelector("pre code");
        const label = canvasElement.querySelector("[data-slot='code-block-language']");

        if (code === null || label === null) {
            throw new Error("The story did not render the code and the language label");
        }

        // Highlighting is async: the plain text must be replaced by Shiki spans.
        await waitFor(() => expect(code.querySelector("[style*='--shiki-dark']")).not.toBeNull(), { timeout: 5000 });

        const token = code.querySelector("span[style]");

        if (token === null) {
            throw new Error("The story did not render a highlighted token");
        }

        // A token must take the Shiki color, not the inherited text color.
        await expect(getComputedStyle(token).color).not.toBe(getComputedStyle(code).color);

        // The code must start on the same x as the language label in the header.
        await expect(Math.round(token.getBoundingClientRect().left)).toBe(
            Math.round(label.getBoundingClientRect().left),
        );
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
        const control = canvasElement.querySelector("[data-testid='codeblock-shiki-control']");
        const streamingBlock = canvasElement.querySelector("[data-testid='codeblock-streaming']");

        if (control === null || streamingBlock === null) {
            throw new Error("The story did not render both code blocks");
        }

        const controlCode = control.querySelector("pre code");
        const streamingCode = streamingBlock.querySelector("pre code");

        if (controlCode === null || streamingCode === null) {
            throw new Error("The story did not render the code elements");
        }

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
    decorators: [
        (Story) => (
            <DarkTheme>
                <Story />
            </DarkTheme>
        ),
    ],
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));
        await waitFor(() => expect(canvasElement.querySelector("code span[style]")).not.toBeNull(), { timeout: 5000 });

        const token = canvasElement.querySelector<HTMLElement>("code span[style]");

        if (token === null) {
            throw new Error("The story did not render a highlighted token");
        }

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
        const pre = canvasElement.querySelector("pre");
        const labels = [...canvasElement.querySelectorAll("[data-slot='code-block-line-number']")].map(
            (node) => node.textContent,
        );

        if (pre === null) {
            throw new Error("The story did not render a pre element");
        }

        await expect(pre.hasAttribute("data-numbered")).toBe(true);
        await expect(labels).toEqual(["12", "13", "14"]);
    },
};

export const CustomLineNumbers: Story = {
    args: {
        lineNumbers: true,
        formatLineNumber: (line) => `L${line}`,
    },
    play: async ({ canvasElement }) => {
        const labels = [...canvasElement.querySelectorAll("[data-slot='code-block-line-number']")].map(
            (node) => node.textContent,
        );

        await expect(labels).toEqual(["L1", "L2", "L3"]);
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

export const DiffWithLineNumbers: Story = {
    args: {
        code: diff,
        language: "diff",
        lineNumbers: true,
        startLine: 41,
    },
    play: async ({ canvasElement }) => {
        const pre = canvasElement.querySelector("pre");
        const numbers = canvasElement.querySelectorAll("[data-slot='code-block-line-number']");
        const markers = canvasElement.querySelectorAll("[data-slot='code-block-marker']");
        const added = canvasElement.querySelectorAll("[data-slot='code-block-line'][data-variant='added']");
        const removed = canvasElement.querySelectorAll("[data-slot='code-block-line'][data-variant='removed']");

        if (pre === null) {
            throw new Error("The story did not render a pre element");
        }

        await expect(pre.hasAttribute("data-numbered")).toBe(true);
        await expect(numbers.length).toBe(diff.split("\n").length);
        await expect(markers.length).toBe(diff.split("\n").length);
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
        const pre = canvasElement.querySelector("pre");
        const gutter = canvasElement.querySelector("[data-slot='code-block-line-number']");
        const viewport = canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
        const bar = canvasElement.querySelector<HTMLElement>(
            "[data-slot='scroll-area-scrollbar'][data-orientation='horizontal']",
        );

        if (pre === null || gutter === null || viewport === null || bar === null) {
            throw new Error("The story did not render the code scroller");
        }

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

        // Headless Chromium denies the real clipboard write (the page is not
        // focused and has no permission), so the story checks the wiring and
        // leaves the actual write to the app and to a manual check.
        const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

        try {
            await userEvent.click(canvas.getByRole("button", { name: "Copy code" }));

            await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Copied"));
            await expect(writeText).toHaveBeenCalledWith(greeting);
        } finally {
            writeText.mockRestore();
        }
    },
};

export const CopyFailure: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        // Both clipboard paths must fail before the button reports the error.
        const writeText = spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
        const execCommand = spyOn(document, "execCommand").mockReturnValue(false);

        try {
            await userEvent.click(canvas.getByRole("button", { name: "Copy code" }));

            await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Copy failed"));
        } finally {
            writeText.mockRestore();
            execCommand.mockRestore();
        }
    },
};

export const ToggleWrap: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const toggle = canvas.getByRole("button", { name: "Wrap lines" });
        const pre = canvasElement.querySelector("pre");

        if (pre === null) {
            throw new Error("The story did not render a pre element");
        }

        await expect(getComputedStyle(pre).whiteSpace).toBe("pre");

        await userEvent.click(toggle);

        await expect(toggle.getAttribute("aria-pressed")).toBe("true");
        await expect(getComputedStyle(pre).whiteSpace).toBe("pre-wrap");
    },
};
