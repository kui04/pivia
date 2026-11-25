import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactElement } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Button } from "@components";
import type { TranscriptThinkingStep } from "@/stores/session/transcript";
import { requireElement } from "@/storybook/dom";
import storyFrame from "@/storybook/storyFrame.module.css";

import { ThinkingBlock } from "./ThinkingBlock";
import styles from "./ThinkingBlock.stories.module.css";

const shortThinking: TranscriptThinkingStep = {
    kind: "thinking",
    id: "thinking-short",
    thinking: [
        "Inspect the existing hooks before extracting a shared module.",
        "",
        "- Verify `ScrollArea` forwards `viewportRef` to Base UI.",
        "- Keep edge fades conditional on real overflow.",
    ].join("\n"),
    redacted: false,
    streaming: false,
};

const longThinking: TranscriptThinkingStep = {
    kind: "thinking",
    id: "thinking-long",
    thinking: Array.from(
        { length: 28 },
        (_, index) => `Step ${index + 1}: verify the boundary calculation for \`scrollTop\` and the mask transitions.`,
    ).join("\n\n"),
    redacted: false,
    streaming: false,
};

const meta = {
    title: "Pages/Workspace/Transcript/ThinkingBlock",
    component: ThinkingBlock,
    args: {
        step: shortThinking,
        onOpenChange: fn(),
        onOpenLink: fn(),
    },
    argTypes: {
        step: { control: false },
        onOpenChange: { control: false },
        onOpenLink: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={storyFrame.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof ThinkingBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Thoughts" });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(trigger);

        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
        await expect(canvas.getByText(/Inspect the existing hooks/)).toBeVisible();

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(args.onOpenChange).toHaveBeenCalledWith(false);
    },
};

export const Expanded: Story = {
    args: {
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("button", { name: "Thoughts" })).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByText(/Keep edge fades conditional on real overflow/)).toBeVisible();

        // Markdown declares --md-text on its own root, so the muted override must land on that
        // element; an ancestor value would be shadowed and the secondary text would read as body.
        const markdown = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='markdown']"),
            "the thinking Markdown",
        );
        const expected = getComputedStyle(document.documentElement)
            .getPropertyValue("--color-on-surface-variant")
            .trim();
        await expect(getComputedStyle(markdown).getPropertyValue("--md-text").trim()).toBe(expected);
    },
};

export const ScrollableWithEdgeFade: Story = {
    args: {
        step: longThinking,
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const viewport = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']"),
            "the thinking viewport",
        );

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
            const body = requireElement(canvasElement.querySelector<HTMLElement>("[data-fade-bottom]"), "body");
            await expect(body).toHaveAttribute("data-fade-bottom", "true");
        });

        const body = requireElement(canvasElement.querySelector<HTMLElement>("[data-fade-bottom]"), "body");
        await expect(body).not.toHaveAttribute("data-fade-top");

        viewport.scrollTop = 80;
        viewport.dispatchEvent(new Event("scroll"));

        await waitFor(async () => {
            await expect(body).toHaveAttribute("data-fade-top", "true");
            await expect(body).toHaveAttribute("data-fade-bottom", "true");
        });

        viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
        viewport.dispatchEvent(new Event("scroll"));

        await waitFor(async () => {
            await expect(body).toHaveAttribute("data-fade-top", "true");
            await expect(body).not.toHaveAttribute("data-fade-bottom");
        });
    },
};

function StreamingHarness(): ReactElement {
    const [count, setCount] = useState(14);
    const [streaming, setStreaming] = useState(true);

    const step: TranscriptThinkingStep = {
        kind: "thinking",
        id: "thinking-streaming",
        thinking: Array.from(
            { length: count },
            (_, index) => `Chunk ${index + 1}: checking the scroll anchor and the resize observer.`,
        ).join("\n\n"),
        redacted: false,
        streaming,
    };

    return (
        <>
            <div className={styles.meta}>
                <Button type="button" onClick={() => setCount((prev) => prev + 1)}>
                    Append chunk
                </Button>
                <Button type="button" variant="secondary" onClick={() => setStreaming((prev) => !prev)}>
                    {streaming ? "Finish" : "Resume"}
                </Button>
            </div>
            <ThinkingBlock step={step} defaultOpen />
        </>
    );
}

export const StreamingAutoScroll: Story = {
    render: () => <StreamingHarness />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const viewport = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']"),
            "the streaming viewport",
        );

        const trigger = canvas.getByRole("button", { name: "Thinking..." });
        const streamLabel = requireElement(
            trigger.querySelector<HTMLElement>("[data-streaming='true']"),
            "the streaming label",
        );
        await expect(getComputedStyle(streamLabel).animationName).toBe("shimmer");

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
            await expect(viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight)).toBeLessThanOrEqual(4);
        });

        await userEvent.click(canvas.getByRole("button", { name: "Append chunk" }));
        await waitFor(async () => {
            await expect(canvas.getByText(/Chunk 15:/)).toBeInTheDocument();
            await expect(viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight)).toBeLessThanOrEqual(4);
        });

        // Scrolling upward unpins the follow, so later chunks do not move the reader's position.
        viewport.scrollTop = 20;
        viewport.dispatchEvent(new Event("scroll"));
        await waitFor(async () => {
            await expect(viewport.scrollTop).toBeLessThanOrEqual(24);
        });

        await userEvent.click(canvas.getByRole("button", { name: "Append chunk" }));
        await waitFor(async () => {
            await expect(canvas.getByText(/Chunk 16:/)).toBeInTheDocument();
        });
        await expect(viewport.scrollTop).toBeLessThanOrEqual(24);

        await userEvent.click(canvas.getByRole("button", { name: "Finish" }));
        await expect(canvas.getByRole("button", { name: "Thoughts" })).toBeVisible();
    },
};

export const Redacted: Story = {
    args: {
        step: { kind: "thinking", id: "thinking-redacted", thinking: "", redacted: true, streaming: false },
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("Reasoning was redacted by the provider.")).toBeVisible();
    },
};
