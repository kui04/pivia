import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Button } from "@components";
import type { TranscriptItem, TranscriptTurnItem } from "@/stores/session";
import { requireElement, requireViewport } from "@/storybook/dom";

import { Transcript } from "./Transcript";
import styles from "./Transcript.stories.module.css";

function buildLongConversation(turnCount: number): TranscriptItem[] {
    const items: TranscriptItem[] = [];

    for (let index = 1; index <= turnCount; index += 1) {
        items.push({
            kind: "user",
            id: `user-${index}`,
            text:
                index === turnCount
                    ? "Ship it."
                    : `Step ${index}: check the workspace transcript rules and report the verified output.`,
            images: [],
        });

        items.push({
            kind: "turn",
            id: `turn-${index}`,
            timing: { kind: "static", durationMs: 4_000 + index * 1_000 },
            streaming: false,
            outcome: { kind: "completed" },
            steps: [
                {
                    kind: "thinking",
                    id: `think-${index}`,
                    thinking: `Reviewing step ${index} requirements before running the verification command.`,
                    redacted: false,
                    streaming: false,
                },
                {
                    kind: "toolCall",
                    id: `tool-${index}`,
                    toolKind: "bash",
                    toolName: "bash",
                    summary: `pnpm test:unit -- --run step-${index}`,
                    arguments: { command: `pnpm test:unit -- --run step-${index}` },
                    argumentsError: null,
                    status: "done",
                    output: `PASS step-${index}.test.ts\nTests 4 passed (4)`,
                    images: [],
                    preview: { kind: "none" },
                    warnings: [],
                    nestedCalls: null,
                    timing: { kind: "static", durationMs: 120 + index * 30 },
                },
            ],
            finalReply:
                index === turnCount
                    ? "Committed as `5af089f` on `main`. Every test and static check passed."
                    : `Completed step ${index}: verified component styling, accessibility attributes and the responsive layout.`,
        });
    }

    return items;
}

const longItems = buildLongConversation(8);

const repeatedBashItems: TranscriptItem[] = [
    {
        kind: "bash",
        id: "bash-repeat-first",
        command: "pnpm test",
        output: "Test Files  28 passed (28)\n      Tests  278 passed (278)",
        excludeFromContext: false,
        status: { kind: "succeeded" },
        truncation: { kind: "none" },
    },
    {
        kind: "bash",
        id: "bash-repeat-second",
        command: "pnpm test",
        output: "FAIL src/stores/session/transcript.test.ts\nAssertionError: expected 1 to be 2",
        excludeFromContext: false,
        status: { kind: "failed", exitCode: 1 },
        truncation: { kind: "none" },
    },
];

const shortItems: TranscriptItem[] = [
    {
        kind: "user",
        id: "user-single",
        text: "Inspect the token configuration and confirm the shimmer duration.",
        images: [],
    },
    {
        kind: "turn",
        id: "turn-single",
        timing: { kind: "static", durationMs: 3_000 },
        streaming: false,
        outcome: { kind: "completed" },
        steps: [
            {
                kind: "toolCall",
                id: "tool-single",
                toolKind: "read",
                toolName: "read",
                summary: "src/styles/token.css",
                arguments: { path: "src/styles/token.css" },
                argumentsError: null,
                status: "done",
                output: "--shimmer-duration: 1.8s;",
                images: [],
                preview: { kind: "none" },
                warnings: [],
                nestedCalls: null,
                timing: { kind: "static", durationMs: 40 },
            },
        ],
        finalReply: "`--shimmer-duration` is set to `1.8s` in `src/styles/token.css`.",
    },
];

const meta = {
    title: "Pages/Workspace/Transcript",
    component: Transcript,
    parameters: {
        layout: "fullscreen",
    },
    args: {
        items: longItems,
        onOpenLink: fn(),
    },
    argTypes: {
        items: { control: false },
        onOpenLink: { control: false },
    },
} satisfies Meta<typeof Transcript>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LongConversationInitialBottom: Story = {
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const viewport = requireViewport(canvasElement, "the transcript scroll viewport");
        const content = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-content']"),
            "the scroll content container",
        );

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
            await expect(viewport.scrollTop).toBeGreaterThan(0);
            await expect(
                Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
            ).toBeLessThanOrEqual(3);
            await expect(Number.parseFloat(getComputedStyle(content).paddingBottom)).toBeGreaterThanOrEqual(60);
        });

        await expect(canvas.getByText(/Committed as/)).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "To bottom" })).not.toBeInTheDocument();
    },
};

export const ScrollUpAndToBottom: Story = {
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const viewport = requireViewport(canvasElement, "the transcript scroll viewport");

        await waitFor(async () => {
            await expect(viewport.scrollTop).toBeGreaterThan(100);
        });

        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true, cancelable: true }));
        viewport.scrollTop = 40;
        viewport.dispatchEvent(new Event("scroll"));

        const jumpButton = await canvas.findByRole("button", { name: "To bottom" });
        await waitFor(async () => {
            await expect(jumpButton).toBeVisible();
        });

        await userEvent.click(jumpButton);

        await waitFor(
            async () => {
                await expect(
                    Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
                ).toBeLessThanOrEqual(3);
                await expect(canvas.queryByRole("button", { name: "To bottom" })).not.toBeInTheDocument();
            },
            { timeout: 3000 },
        );

        await expect(document.activeElement).toBe(viewport);
    },
};

const STREAM_CHUNKS = [
    "Streaming chunk 1: starting the container layout verification.",
    "Streaming chunk 2: checking the container-level edge fade.",
    "Streaming chunk 3: keeping a long code block inside the column.",
    "Streaming chunk 4: testing the wheel scroll-up pause.",
    "Streaming chunk 5: testing the smooth To bottom recovery.",
    "Streaming chunk 6: resuming auto-scroll after returning to the bottom.",
] as const;

// Module scope keeps the wall-clock read out of render; the story only needs a plausible start.
const STREAM_STARTED_AT_MS = Date.now() - 4_000;

function StreamingTranscriptDemo() {
    const [chunkCount, setChunkCount] = useState(2);
    const [streaming, setStreaming] = useState(true);

    const activeTurn: TranscriptTurnItem = {
        kind: "turn",
        id: "turn-streaming",
        timing: streaming
            ? { kind: "since", startedAtMs: STREAM_STARTED_AT_MS }
            : { kind: "static", durationMs: 4_000 },
        streaming,
        outcome: streaming ? { kind: "open" } : { kind: "completed" },
        steps: [
            {
                kind: "thinking",
                id: "think-stream",
                thinking: "Streaming reasoning output while monitoring the auto-follow behaviour.",
                redacted: false,
                streaming: false,
            },
        ],
        finalReply: STREAM_CHUNKS.slice(0, chunkCount)
            .map((line) => `${line}\n\n${"Detail ".repeat(18).trim()}`)
            .join("\n\n"),
    };

    const items: TranscriptItem[] = [...longItems.slice(0, 6), activeTurn];

    return (
        <div className={styles.streamingShell}>
            <div className={styles.controls}>
                <Button type="button" onClick={() => setChunkCount((prev) => prev + 1)}>
                    Append chunk
                </Button>
                <Button type="button" variant="secondary" onClick={() => setStreaming((prev) => !prev)}>
                    {streaming ? "Finish stream" : "Resume stream"}
                </Button>
            </div>
            <Transcript items={items} />
        </div>
    );
}

export const StreamingAutoFollow: Story = {
    render: () => <StreamingTranscriptDemo />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const viewport = requireViewport(canvasElement, "the transcript scroll viewport");
        const appendButton = canvas.getByRole("button", { name: "Append chunk" });

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
            await expect(
                Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
            ).toBeLessThanOrEqual(3);
        });

        await userEvent.click(appendButton);
        await waitFor(async () => {
            await expect(canvas.getByText(/Streaming chunk 3/)).toBeVisible();
            await expect(
                Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
            ).toBeLessThanOrEqual(3);
        });

        // Scrolling up pauses the automatic bottom pin and reveals To bottom.
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true, cancelable: true }));
        viewport.scrollTop = 20;
        viewport.dispatchEvent(new Event("scroll"));

        const jumpButton = await canvas.findByRole("button", { name: "To bottom" });
        await waitFor(async () => {
            await expect(jumpButton).toBeVisible();
        });

        const pausedScrollTop = viewport.scrollTop;
        await userEvent.click(appendButton);
        await waitFor(async () => {
            await expect(canvas.getByText(/Streaming chunk 4/)).toBeVisible();
        });
        await expect(viewport.scrollTop).toBeLessThanOrEqual(pausedScrollTop + 4);

        await userEvent.click(jumpButton);
        await waitFor(
            async () => {
                await expect(
                    Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
                ).toBeLessThanOrEqual(3);
                await expect(canvas.queryByRole("button", { name: "To bottom" })).not.toBeInTheDocument();
            },
            { timeout: 3000 },
        );

        await userEvent.click(appendButton);
        await waitFor(async () => {
            await expect(canvas.getByText(/Streaming chunk 5/)).toBeVisible();
            await expect(
                Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
            ).toBeLessThanOrEqual(3);
        });
    },
};

export const StreamEndKeepsReleasedPosition: Story = {
    render: () => <StreamingTranscriptDemo />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const viewport = requireViewport(canvasElement, "the transcript scroll viewport");

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        });

        // The reader leaves the bottom while the answer still streams.
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true, cancelable: true }));
        viewport.scrollTop = 20;
        viewport.dispatchEvent(new Event("scroll"));

        const jumpButton = await canvas.findByRole("button", { name: "To bottom" });
        await waitFor(async () => {
            await expect(jumpButton).toBeVisible();
        });
        const releasedScrollTop = viewport.scrollTop;

        // The run ends. The hook re-runs with `streaming` false and must not replay the one-time
        // attach jump, otherwise a reader parked above the bottom would be pulled down.
        await userEvent.click(canvas.getByRole("button", { name: "Finish stream" }));
        await canvas.findByRole("button", { name: "Resume stream" });
        await new Promise((resolve) => setTimeout(resolve, 150));

        await expect(viewport.scrollTop).toBeLessThanOrEqual(releasedScrollTop + 4);
        await expect(canvas.getByRole("button", { name: "To bottom" })).toBeVisible();
    },
};

export const FitsWithoutScroll: Story = {
    args: {
        items: shortItems,
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const viewport = requireViewport(canvasElement, "the transcript scroll viewport");

        await expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight);
        await expect(canvas.getByText(/is set to/)).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "To bottom" })).not.toBeInTheDocument();
    },
};

/**
 * Two `!` records of the same command.
 *
 * The blocks name their scroll regions after the command. Those scrollers stay groups rather than
 * landmarks, so repeated commands cannot duplicate a landmark name.
 */
export const RepeatedBashCommands: Story = {
    args: {
        items: repeatedBashItems,
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getAllByText("pnpm test")).toHaveLength(2);
        await expect(canvas.getByText(/exited 1/)).toBeVisible();
        await expect(canvas.getAllByRole("group", { name: "pnpm test output" })).toHaveLength(2);
    },
};

export const RetryCountdownAndNotice: Story = {
    args: {
        items: shortItems,
        liveActivity: {
            kind: "retrying",
            scope: "turn",
            attempt: 2,
            maxAttempts: 3,
            delayMs: 30_000,
            errorMessage: "429 Rate limit exceeded",
        },
        activityNotice: {
            tone: "error",
            message: "Auto-compaction failed: context overflow",
        },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("status")).toHaveTextContent(/Retrying \(2\/3\) in \d+s\.\.\./);
        await expect(canvas.getByRole("alert")).toHaveTextContent("Auto-compaction failed: context overflow");
    },
};
