import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptTurnItem } from "@/stores/session/transcript";

import { TurnGroup } from "./TurnGroup";
import styles from "./TurnGroup.stories.module.css";

function requireElement<T extends Element>(element: T | null, name: string): T {
    if (element === null) {
        throw new Error(`The story did not render ${name}`);
    }
    return element;
}

function rowBounds(rows: readonly Element[], index: number): { readonly top: number; readonly bottom: number } {
    const row = rows[index];
    if (row === undefined) {
        throw new Error(`The story did not render row ${index}`);
    }
    const rect = row.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
}

const completedTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-completed",
    timing: { kind: "static", durationMs: 11_000 },
    streaming: false,
    outcome: { kind: "completed" },
    steps: [
        {
            kind: "thinking",
            id: "step-think-1",
            thinking: "Check the worker limit and the existing frontend docs before editing.",
            redacted: false,
            streaming: false,
        },
        {
            kind: "toolCall",
            id: "step-tool-1",
            toolKind: "bash",
            label: "Bash",
            summary: "git log --oneline -20",
            arguments: { command: "git log --oneline -20" },
            argumentsError: null,
            status: "done",
            output: "b8a713e test(storybook): cap workers\na3d6120 feat(workspace): transcript rows",
            images: [],
            preview: { kind: "none" },
            warnings: [],
            timing: { kind: "static", durationMs: 120 },
        },
        {
            kind: "thinking",
            id: "step-think-2",
            thinking: "Everything matches the planned scope; report the result.",
            redacted: false,
            streaming: false,
        },
    ],
    finalReply: [
        "Committed as `b8a713e` on `main`.",
        "",
        "- Covers three files: `TurnGroup.tsx`, `Transcript.tsx` and `WorkspacePage.tsx`.",
        "- The hooks passed: `eslint` and `prettier`.",
    ].join("\n"),
};

const intermediateReplyTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-intermediate",
    timing: { kind: "static", durationMs: 8_000 },
    streaming: false,
    outcome: { kind: "completed" },
    steps: [
        {
            kind: "thinking",
            id: "step-mid-think",
            thinking: "Inspect the store exports before choosing the component prop names.",
            redacted: false,
            streaming: false,
        },
        {
            kind: "reply",
            id: "step-mid-reply",
            text: "The transcript model exports the row types; running the unit checks before wiring the view.",
            streaming: false,
        },
        {
            kind: "toolCall",
            id: "step-mid-tool",
            toolKind: "bash",
            label: "Bash",
            summary: "pnpm test:unit",
            arguments: { command: "pnpm test:unit" },
            argumentsError: null,
            status: "done",
            output: "Test Files  4 passed (4)\nTests  42 passed (42)",
            images: [],
            preview: { kind: "none" },
            warnings: [],
            timing: { kind: "static", durationMs: 1_900 },
        },
    ],
    finalReply: "All 42 unit tests pass across 4 test files.",
};

const streamingTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-streaming",
    timing: { kind: "since", startedAtMs: Date.now() - 4_000 },
    streaming: true,
    outcome: { kind: "open" },
    steps: [
        {
            kind: "thinking",
            id: "step-stream-think",
            thinking: "Gathering metrics across the stories before summarizing.",
            redacted: false,
            streaming: false,
        },
        {
            kind: "toolCall",
            id: "step-stream-tool",
            toolKind: "bash",
            label: "Bash",
            summary: "pnpm test:storybook",
            arguments: { command: "pnpm test:storybook" },
            argumentsError: null,
            status: "running",
            output: "RUN v5.1.1 /home/kui04/Workspace/repo/pivia/packages/web",
            images: [],
            preview: { kind: "none" },
            warnings: [],
            timing: { kind: "since", startedAtMs: Date.now() - 4_000 },
        },
    ],
    finalReply: null,
};

const pendingTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-pending",
    timing: { kind: "since", startedAtMs: Date.now() },
    streaming: true,
    outcome: { kind: "open" },
    steps: [],
    finalReply: null,
};

const singleStepTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-single-step",
    timing: { kind: "static", durationMs: 2_000 },
    streaming: false,
    outcome: { kind: "completed" },
    steps: [
        {
            kind: "thinking",
            id: "step-only-think",
            thinking: "A single thinking step renders directly without a Worked group wrapper.",
            redacted: false,
            streaming: false,
        },
    ],
    finalReply: "Single-step turns skip the outer group header and show the step directly.",
};

const errorTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-error",
    timing: { kind: "static", durationMs: 3_000 },
    streaming: false,
    outcome: { kind: "error", message: "Error: The provider closed the connection unexpectedly." },
    steps: [
        {
            kind: "toolCall",
            id: "step-err-tool",
            toolKind: "read",
            label: "Read",
            summary: "src/pages/Workspace/WorkspacePage.tsx",
            arguments: { path: "src/pages/Workspace/WorkspacePage.tsx" },
            argumentsError: null,
            status: "error",
            output: "ENOENT: no such file or directory",
            images: [],
            preview: { kind: "none" },
            warnings: [],
            timing: { kind: "static", durationMs: 40 },
        },
    ],
    finalReply: null,
};

const truncatedTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-truncated",
    timing: { kind: "static", durationMs: 6_000 },
    streaming: false,
    outcome: { kind: "truncated" },
    steps: [],
    finalReply: "The first half of the answer arrives before the model runs out of output tokens.",
};

const abortedTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-aborted",
    timing: { kind: "static", durationMs: 2_000 },
    streaming: false,
    outcome: { kind: "aborted", message: "Operation aborted" },
    steps: [],
    finalReply: "Partial answer before the reader stopped the run.",
};

const streamingErrorTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-streaming-error",
    timing: { kind: "since", startedAtMs: Date.now() - 1_000 },
    streaming: true,
    outcome: { kind: "error", message: "Error: The provider closed the connection." },
    steps: [],
    finalReply: null,
};

const meta = {
    title: "Pages/Workspace/Transcript/TurnGroup",
    component: TurnGroup,
    args: {
        turn: completedTurn,
        onOpenChange: fn(),
        onOpenLink: fn(),
    },
    argTypes: {
        turn: { control: false },
        onOpenChange: { control: false },
        onOpenLink: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof TurnGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CollapsedWithFinalReply: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Worked for 11s" });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(canvas.getByText(/Covers three files/)).toBeVisible();

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
        await expect(canvas.getAllByRole("button", { name: "Thoughts" })).toHaveLength(2);
    },
};

export const ExpandedMultiStepTimeline: Story = {
    args: {
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("button", { name: "Worked for 11s" })).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getAllByRole("button", { name: "Thoughts" })).toHaveLength(2);
        await expect(canvas.getByText("0.1s")).toBeVisible();
        await expect(canvas.getByText(/Covers three files/)).toBeVisible();
    },
};

export const WithIntermediateReply: Story = {
    args: {
        turn: intermediateReplyTurn,
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText(/running the unit checks before wiring the view/)).toBeVisible();
        await expect(canvas.getByText("All 42 unit tests pass across 4 test files.")).toBeVisible();

        // Every step row keeps the same height, so the connector gaps and the guide rail line up.
        const thinkingRow = requireElement(canvas.getByRole("button", { name: "Thoughts" }), "the thinking row");
        const replyRow = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='transcript-reply-step']"),
            "the reply row",
        );
        const toolRow = requireElement(canvas.getByRole("button", { name: /Bash/ }), "the tool row");
        const rows = [thinkingRow, replyRow, toolRow];
        const gapBeforeReply = rowBounds(rows, 1).top - rowBounds(rows, 0).bottom;
        const gapBeforeTool = rowBounds(rows, 2).top - rowBounds(rows, 1).bottom;

        // The connector between two rows is one 8px segment, whatever height the row content takes.
        await expect(gapBeforeReply).toBeCloseTo(8, 0);
        await expect(gapBeforeTool).toBeCloseTo(8, 0);
        await expect(Math.abs(gapBeforeReply - gapBeforeTool)).toBeLessThanOrEqual(1);

        const connectors = [...canvasElement.querySelectorAll<HTMLElement>("[data-slot='transcript-connector']")];
        await expect(connectors.length).toBeGreaterThan(0);
        for (const connector of connectors) {
            await expect(connector.getBoundingClientRect().height).toBeCloseTo(8, 0);
        }
    },
};

export const StreamingTurn: Story = {
    args: {
        turn: streamingTurn,
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        // The first wall-clock sample arrives on the next frame, so the header gains its duration
        // asynchronously.
        const trigger = await canvas.findByRole("button", { name: /^Working for \d+s$/ });
        await expect(trigger).toBeVisible();
        const timer = await waitFor(() =>
            requireElement(canvasElement.querySelector<HTMLElement>("[data-running='true']"), "running timer"),
        );
        await expect(timer).toHaveTextContent(/^\d+\.\ds$/);
        await expect(canvas.getByText("Working...")).toBeVisible();
        await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
    },
};

export const WaitingForFirstStep: Story = {
    args: {
        turn: pendingTurn,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("status")).toHaveTextContent("Working...");
        await expect(canvas.queryByRole("button")).not.toBeInTheDocument();
        await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
    },
};

export const SingleStepDirect: Story = {
    args: {
        turn: singleStepTurn,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.queryByRole("button", { name: /^Worked/ })).not.toBeInTheDocument();
        await expect(canvas.getByRole("button", { name: "Thoughts" })).toBeVisible();
        await expect(canvas.getByText(/Single-step turns skip the outer group/)).toBeVisible();
    },
};

export const TurnError: Story = {
    args: {
        turn: errorTurn,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.queryByRole("button", { name: /^Worked/ })).not.toBeInTheDocument();
        await expect(canvas.getByRole("button", { name: /Read/ })).toBeVisible();
        const alert = canvas.getByRole("alert");
        await expect(alert).toHaveTextContent("Error: The provider closed the connection unexpectedly.");
    },
};

export const TurnTruncated: Story = {
    args: {
        turn: truncatedTurn,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("status")).toHaveTextContent("Response was truncated before completion.");
    },
};

export const TurnAborted: Story = {
    args: {
        turn: abortedTurn,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("alert")).toHaveTextContent("Operation aborted");
    },
};

export const StreamingTurnHidesNotice: Story = {
    args: {
        turn: streamingErrorTurn,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("status")).toHaveTextContent("Working...");
        // The runtime still reports activity, so a settled-looking error notice must wait.
        await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    },
};
