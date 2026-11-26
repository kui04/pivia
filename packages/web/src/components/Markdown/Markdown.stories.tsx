import type { Meta, StoryObj } from "@storybook/react-vite";
import { Play } from "lucide-react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { DarkTheme } from "@/storybook/theme";

import { IconButton } from "../IconButton";
import { imageAlt, imageCaption, imageSrc } from "../Image/imageFixture";

import { Markdown } from "./Markdown";

const answer = [
    "# Markdown in chat",
    "",
    "The renderer handles **bold**, *italic*, ~~struck~~, `inline code` and [links](https://example.com/docs).",
    "",
    "## Lists",
    "",
    "- A tight item",
    "- An item with `code`",
    "",
    "1. First",
    "2. Second",
    "",
    "- [x] Done",
    "- [ ] Open",
    "",
    "> A quote that spans",
    "> two lines.",
    "",
    "## Table",
    "",
    "| Name | Count | Note |",
    "| :--- | ---: | :---: |",
    "| alpha | 1 | first |",
    "| beta | 22 | second |",
    "",
    "## Code",
    "",
    "```ts",
    "export function greet(name: string): string {",
    '    return "hello " + name;',
    "}",
    "```",
    "",
    "## Math",
    "",
    "Inline math such as $E = mc^2$ sits in the line.",
    "",
    "$$",
    "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
    "$$",
    "",
    "---",
    "",
    "A claim with a footnote.[^1]",
    "",
    "[^1]: The note the claim points to.",
].join("\n");

const wideTableAnswer = [
    `| ${Array.from({ length: 24 }, (_, index) => `Column ${index + 1}`).join(" | ")} |`,
    `| ${Array.from({ length: 24 }, () => "---").join(" | ")} |`,
    `| ${Array.from({ length: 24 }, (_, index) => `Value ${index + 1}`).join(" | ")} |`,
].join("\n");

const streamingPartial = [
    "Here is the implementation:",
    "",
    "```ts",
    "export function greet(name: string): string {",
    '    return "hello " + name;',
    "}",
].join("\n");

const streamingComplete = `${streamingPartial}\n\`\`\`\n\nThe function returns a greeting.`;

const linkAnswer = [
    "Read [the docs](https://example.com/docs) or the [unsafe](javascript:alert) link.",
    "",
    "A [mail](mailto:dev@example.com) link and a [note](#note) fragment.",
].join("\n");

const mathAnswer = [
    "Inline $a^2 + b^2 = c^2$ math.",
    "",
    "$$",
    "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}",
    "$$",
    "",
    "A broken formula $\\notacommand$ stays visible.",
].join("\n");

const currencyAnswer = [
    "It costs $5 and $10 today.",
    "",
    "Sub-dollar prices are $.50 and $.75.",
    "",
    "A range of $.50-$.75.",
    "",
    "The value $x$5 stays a formula.",
    "",
    "A range of $10-$20, or $5 today and $ 10 tomorrow.",
    "",
    "Inline math $x^2$ still renders.",
    "",
    "$$",
    "E = mc^2",
    "$$",
].join("\n");

const imageAnswer = [
    `![${imageAlt}](${imageSrc} "${imageCaption}")`,
    "",
    "Text after the image.",
    "",
    `[![Linked image](${imageSrc})](https://example.com/image)`,
].join("\n");

const mediaAnswer = ["![unsafe](javascript:alert)", "", "Text after the image."].join("\n");

const darkAnswer = [
    "# Dark mode",
    "",
    "A [link](https://example.com) and `inline code`.",
    "",
    "```ts",
    "const value = 1;",
    "```",
].join("\n");

const meta = {
    title: "Components/Markdown",
    component: Markdown,
    args: {
        children: answer,
    },
} satisfies Meta<typeof Markdown>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("heading", { level: 1, name: "Markdown in chat" })).toBeInTheDocument();
        await expect(canvas.getByRole("link", { name: "links" })).toHaveAttribute("href", "https://example.com/docs");

        const table = canvas.getByRole("group", { name: "Table" });
        await expect(table).toHaveAttribute("data-slot", "scroll-area-viewport");
        await expect(table.querySelector("table")).not.toBeNull();
        await expect(canvas.getByRole("table")).toBeInTheDocument();

        await expect(canvas.getByRole("checkbox", { name: "Done" })).toBeChecked();
        await expect(canvas.getByRole("checkbox", { name: "Open" })).not.toBeChecked();
        await expect(canvasElement.querySelector("[data-footnotes]"), "footnotes").not.toBeNull();

        // A footnote reference scrolls and focuses its note without writing the
        // fragment into the URL, which the hash router would read as a route.
        const note = canvasElement.querySelector<HTMLElement>("[data-footnotes] li[id]");
        if (note === null) {
            throw new Error("The story did not render a footnote note");
        }

        const reference = canvasElement.querySelector<HTMLAnchorElement>(`a[href="#${note.id}"]`);
        if (reference === null) {
            throw new Error("The story did not render the footnote reference");
        }

        // The renderer passes the rest of remark-gfm's attributes through.
        await expect(reference).toHaveAttribute("aria-describedby", "footnote-label");

        const hash = window.location.hash;
        await userEvent.click(reference);
        await expect(window.location.hash).toBe(hash);
        await waitFor(() => expect(note).toHaveFocus(), { timeout: 3000 });

        const backReference = note.querySelector<HTMLAnchorElement>("a[data-footnote-backref]");
        if (backReference === null) {
            throw new Error("The story did not render the footnote back-reference");
        }

        await userEvent.click(backReference);
        await expect(window.location.hash).toBe(hash);
        await waitFor(() => expect(reference).toHaveFocus(), { timeout: 3000 });
        await expect(reference).not.toHaveAttribute("tabindex", "-1");

        await expect(canvasElement.querySelector(".katex-display"), "display math").not.toBeNull();

        const label = canvasElement.querySelector("[data-slot='code-block-language']");
        const code = canvasElement.querySelector("[data-slot='code-block'] code");

        if (label === null || code === null) {
            throw new Error("The story did not render the fenced code block");
        }

        await expect(label).toHaveTextContent("ts");

        // Highlighting is async: the plain text must be replaced by Shiki spans.
        await waitFor(() => expect(code.querySelector("span[style*='--shiki']"), "shiki tokens").not.toBeNull(), {
            timeout: 5000,
        });
    },
};

export const WideTable: Story = {
    args: {
        children: wideTableAnswer,
    },
    render: (args) => (
        <div style={{ width: "30rem" }}>
            <Markdown {...args} />
        </div>
    ),
    play: async ({ canvasElement }) => {
        const region = canvasElement.querySelector<HTMLElement>(
            "[data-slot='scroll-area-viewport'][aria-label='Table']",
        );

        if (region === null) {
            throw new Error("The story did not render the table scroller");
        }

        await waitFor(() => expect(region.scrollWidth).toBeGreaterThan(region.clientWidth));

        const bar =
            region.parentElement?.querySelector<HTMLElement>(
                "[data-slot='scroll-area-scrollbar'][data-orientation='horizontal']",
            ) ?? null;

        if (bar === null) {
            throw new Error("The story did not render the table scrollbar");
        }

        await expect(getComputedStyle(bar).opacity).toBe("1");

        region.scrollLeft = region.scrollWidth - region.clientWidth;
        await waitFor(() => expect(region.scrollLeft).toBeGreaterThan(0));
    },
};

function StreamingAnswer() {
    const [streaming, setStreaming] = useState(true);

    return (
        <div>
            <IconButton label="Finish stream" radius="full" onClick={() => setStreaming(false)}>
                <Play />
            </IconButton>
            {/* The control loads Shiki without a streaming gate, so its completion proves the engine is ready. */}
            <div data-testid="markdown-shiki-control" hidden>
                <Markdown>{streamingComplete}</Markdown>
            </div>
            <div data-testid="markdown-streaming">
                <Markdown streaming={streaming}>{streaming ? streamingPartial : streamingComplete}</Markdown>
            </div>
        </div>
    );
}

export const Streaming: Story = {
    args: {
        children: streamingPartial,
    },
    render: () => <StreamingAnswer />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const control = canvasElement.querySelector("[data-testid='markdown-shiki-control']");
        const streamingRoot = canvasElement.querySelector("[data-testid='markdown-streaming']");

        if (control === null || streamingRoot === null) {
            throw new Error("The story did not render both Markdown instances");
        }

        const root = streamingRoot.querySelector("[data-slot='markdown']");
        const block = streamingRoot.querySelector("[data-slot='code-block']");
        const controlBlock = control.querySelector("[data-slot='code-block']");

        if (root === null || block === null || controlBlock === null) {
            throw new Error("The streaming answer did not render its code block");
        }

        // The fence is still open: plain text, no Shiki spans, and the host can
        // style the row while it grows. Wait for the ungated control first.
        await expect(root).toHaveAttribute("data-streaming", "true");
        await waitFor(() => expect(controlBlock.querySelector("span[style*='--shiki']")).not.toBeNull(), {
            timeout: 5000,
        });
        await expect(block.querySelector("span[style*='--shiki']")).toBeNull();

        await userEvent.click(canvas.getByRole("button", { name: "Finish stream" }));

        await expect(root).not.toHaveAttribute("data-streaming");
        await waitFor(() => expect(canvasElement).toHaveTextContent("The function returns a greeting."));
        await waitFor(
            () => expect(streamingRoot.querySelector("[data-slot='code-block'] span[style*='--shiki']")).not.toBeNull(),
            {
                timeout: 5000,
            },
        );
    },
};

const opened: string[] = [];

export const Links: Story = {
    args: {
        children: linkAnswer,
        onOpenLink: (href) => opened.push(href),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        opened.length = 0;

        // A fragment stays inside the message; only the two absolute schemes
        // reach the host.
        await expect(canvas.getByRole("link", { name: "mail" })).toHaveAttribute("href", "mailto:dev@example.com");
        await expect(canvas.getByRole("link", { name: "note" })).toHaveAttribute("href", "#note");

        // A fragment without a target still must not reach the URL.
        const hash = window.location.hash;
        await userEvent.click(canvas.getByRole("link", { name: "note" }));
        await expect(window.location.hash).toBe(hash);

        await userEvent.click(canvas.getByRole("link", { name: "the docs" }));

        await expect(opened).toEqual(["https://example.com/docs"]);
        // react-markdown clears an unsafe scheme, so the text stays and the
        // link around it does not exist.
        await expect(canvas.queryByRole("link", { name: "unsafe" })).toBeNull();
    },
};

export const Math: Story = {
    args: {
        children: mathAnswer,
    },
    play: async ({ canvasElement }) => {
        await expect(canvasElement.querySelector(".katex"), "katex").not.toBeNull();
        await expect(canvasElement.querySelector(".katex-display"), "display math").not.toBeNull();
        // A formula KaTeX cannot parse stays visible in the error colour.
        await expect(canvasElement.querySelector("[style*='var(--md-error)']")).not.toBeNull();

        const display = canvasElement.querySelector(".katex-display");

        if (display === null) {
            throw new Error("The story did not render display math");
        }

        await expect(display.closest("[data-slot='scroll-area-viewport']")).not.toBeNull();
    },
};

export const Currency: Story = {
    args: {
        children: currencyAnswer,
    },
    play: async ({ canvasElement }) => {
        const paragraphs = Array.from(canvasElement.querySelectorAll("p"));

        const paragraph = (index: number): Element => {
            const found = paragraphs[index];

            if (found === undefined) {
                throw new Error(`The currency story is missing paragraph ${index}`);
            }

            return found;
        };

        await expect(paragraph(0)).toHaveTextContent("It costs $5 and $10 today.");
        await expect(paragraph(1)).toHaveTextContent("Sub-dollar prices are $.50 and $.75.");
        await expect(paragraph(2)).toHaveTextContent("A range of $.50-$.75.");
        await expect(paragraph(3).querySelector(".katex")).not.toBeNull();

        for (const index of [0, 1, 2]) {
            await expect(paragraph(index).querySelector(".katex")).toBeNull();
        }

        await expect(paragraph(4)).toHaveTextContent("A range of $10-$20, or $5 today and $ 10 tomorrow.");
        // x$5, x^2 and the display formula still render.
        await expect(canvasElement.querySelectorAll(".katex")).toHaveLength(3);
        await expect(canvasElement.querySelector(".katex-display")).not.toBeNull();
    },
};

export const Images: Story = {
    args: {
        children: imageAnswer,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: `View image: ${imageAlt}` });

        await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
        await expect(trigger.querySelector("img")).toHaveAttribute("src", imageSrc);

        // An image inside a link keeps the link valid: the image is not a
        // nested button and does not open a second dialog.
        const linked = canvas.getByRole("link", { name: "Linked image" });

        await expect(linked.querySelector("button")).toBeNull();
        await expect(linked.querySelector("img")).not.toBeNull();

        await userEvent.click(trigger);

        const dialog = await screen.findByRole("dialog", { name: "Image viewer" });
        const viewerImage = within(dialog).getByRole("img", { name: imageAlt });

        await waitFor(() => expect(viewerImage).toHaveAttribute("data-status", "loaded"), { timeout: 5000 });

        const caption = dialog.querySelector("[data-slot='image-viewer-caption']");
        if (caption === null) {
            throw new Error("The Markdown viewer did not render the image title");
        }

        await expect(caption).toHaveTextContent(imageCaption);

        await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const Media: Story = {
    args: {
        children: mediaAnswer,
    },
    play: async ({ canvasElement }) => {
        // react-markdown empties the unsafe scheme; the alt text stays and no
        // image with an empty src reaches the page.
        await expect(canvasElement.querySelector("img")).toBeNull();
        await expect(canvasElement).toHaveTextContent("unsafe");
    },
};

export const Dark: Story = {
    args: {
        children: darkAnswer,
    },
    decorators: [DarkTheme],
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));
        await waitFor(
            () => expect(canvasElement.querySelector("[data-slot='code-block'] span[style*='--shiki']")).not.toBeNull(),
            {
                timeout: 5000,
            },
        );

        const root = canvasElement.querySelector<HTMLElement>("[data-slot='markdown']");
        const link = root?.querySelector<HTMLElement>("a");
        const inline = root?.querySelector<HTMLElement>("code");

        if (root === null || link === null || link === undefined || inline === null || inline === undefined) {
            throw new Error("The dark Markdown story did not render its text and link");
        }

        await expect(getComputedStyle(root).color).toBe("rgb(204, 204, 204)");
        await expect(getComputedStyle(link).color).toBe("rgb(77, 170, 252)");
        await expect(getComputedStyle(inline).color).toBe("rgb(204, 204, 204)");
    },
};
