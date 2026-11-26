import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptTurnItem } from "@/stores/session/transcript";
import { requireElement, requireViewport } from "@/storybook/dom";
import storyFrame from "@/storybook/storyFrame.module.css";

import { TurnGroup } from "./TurnGroup";

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
            toolName: "bash",
            summary: "git log --oneline -20",
            arguments: { command: "git log --oneline -20" },
            argumentsError: null,
            status: "done",
            output: "b8a713e test(storybook): cap workers\na3d6120 feat(workspace): transcript rows",
            images: [],
            preview: { kind: "none" },
            warnings: [],
            nestedCalls: null,
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
            toolName: "bash",
            summary: "pnpm test:unit",
            arguments: { command: "pnpm test:unit" },
            argumentsError: null,
            status: "done",
            output: "Test Files  4 passed (4)\nTests  42 passed (42)",
            images: [],
            preview: { kind: "none" },
            warnings: [],
            nestedCalls: null,
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
            toolName: "bash",
            summary: "pnpm test:storybook",
            arguments: { command: "pnpm test:storybook" },
            argumentsError: null,
            status: "running",
            output: "RUN v5.1.1 /home/kui04/Workspace/repo/pivia/packages/web",
            images: [],
            preview: { kind: "none" },
            warnings: [],
            nestedCalls: null,
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
            toolName: "read",
            summary: "src/pages/Workspace/WorkspacePage.tsx",
            arguments: { path: "src/pages/Workspace/WorkspacePage.tsx" },
            argumentsError: null,
            status: "error",
            output: "ENOENT: no such file or directory",
            images: [],
            preview: { kind: "none" },
            warnings: [],
            nestedCalls: null,
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
    diagnosticsNotice: "Anthropic dropped 2 thinking blocks",
};

const longTurn: TranscriptTurnItem = {
    kind: "turn",
    id: "turn-long",
    timing: { kind: "static", durationMs: 28_400 },
    streaming: false,
    outcome: { kind: "completed" },
    steps: Array.from({ length: 16 }, (_, index) => {
        if (index % 3 === 0) {
            return {
                kind: "thinking" as const,
                id: `long-think-${index}`,
                thinking: `Evaluating batch step ${index + 1} before editing.`,
                redacted: false,
                streaming: false,
            };
        }
        return {
            kind: "toolCall" as const,
            id: `long-tool-${index}`,
            toolKind: "read" as const,
            toolName: "read",
            summary: `packages/web/src/components/Item${index + 1}.tsx`,
            arguments: { path: `packages/web/src/components/Item${index + 1}.tsx` },
            argumentsError: null,
            status: "done" as const,
            output: `export const item = ${index + 1};`,
            images: [],
            preview: { kind: "none" as const },
            warnings: [],
            nestedCalls: null,
            timing: { kind: "static" as const, durationMs: 35 + index * 5 },
        };
    }),
    finalReply: "Reviewed all 16 steps while keeping the turn timeline bounded.",
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
            <div className={storyFrame.frame}>
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
        const trigger = canvas.getByRole("button", { name: "Worked for 11.0s" });

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
        await expect(canvas.getByRole("button", { name: "Worked for 11.0s" })).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getAllByRole("button", { name: "Thoughts" })).toHaveLength(2);
        await expect(canvas.getByText("120ms")).toBeVisible();
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

        // Steps stack with a consistent 4px vertical gap beside the shared left rail.
        const thinkingRow = requireElement(canvas.getByRole("button", { name: "Thoughts" }), "the thinking row");
        const replyRow = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='transcript-reply-step']"),
            "the reply row",
        );
        const toolRow = requireElement(canvas.getByRole("button", { name: /Bash/ }), "the tool row");
        const rows = [thinkingRow, replyRow, toolRow];
        const gapBeforeReply = rowBounds(rows, 1).top - rowBounds(rows, 0).bottom;
        const gapBeforeTool = rowBounds(rows, 2).top - rowBounds(rows, 1).bottom;

        await expect(gapBeforeReply).toBeCloseTo(4, 0);
        await expect(gapBeforeTool).toBeCloseTo(4, 0);
        await expect(Math.abs(gapBeforeReply - gapBeforeTool)).toBeLessThanOrEqual(1);

        await userEvent.hover(toolRow);
        await expect(getComputedStyle(toolRow).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    },
};

export const LongTurnBoundedTimeline: Story = {
    args: {
        turn: longTurn,
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const viewport = requireViewport(canvasElement, "the turn steps viewport");
        const headerRow = canvas.getByRole("button", { name: "Worked for 28.4s" });
        const innerRow = canvas.getAllByRole("button", { name: "Thoughts" })[0];
        if (innerRow === undefined) {
            throw new Error("The story did not render an inner Thoughts row");
        }
        const scrollbar = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='rail-scrollbar']"),
            "the left-rail vertical scrollbar",
        );
        const thumb = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='rail-thumb']"),
            "the fixed-length rail thumb",
        );

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
            await expect(thumb).toBeVisible();
        });
        await expect(viewport.clientHeight).toBeLessThanOrEqual(322);
        await expect(innerRow.getBoundingClientRect().right).toBeCloseTo(headerRow.getBoundingClientRect().right, 0);

        await expect(scrollbar.getBoundingClientRect().right).toBeLessThanOrEqual(
            innerRow.getBoundingClientRect().left + 1,
        );
        await expect(thumb.getBoundingClientRect().height).toBeCloseTo(24, 0);
        await expect(canvas.getByText("Reviewed all 16 steps while keeping the turn timeline bounded.")).toBeVisible();

        viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
        viewport.dispatchEvent(new Event("scroll"));
        await waitFor(async () => {
            const mask = getComputedStyle(viewport).maskImage || getComputedStyle(viewport).webkitMaskImage;
            await expect(mask).toContain("rgba(0, 0, 0, 0)");
            await expect(thumb.getBoundingClientRect().bottom).toBeCloseTo(scrollbar.getBoundingClientRect().bottom, 1);
        });
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
        const trigger = await canvas.findByRole("button", { name: /^Working for \d+ms$|^Working for \d+\.\ds$/ });
        await expect(trigger).toBeVisible();
        const timer = await waitFor(() =>
            requireElement(canvasElement.querySelector<HTMLElement>("[data-running='true']"), "running timer"),
        );
        await expect(timer).toHaveTextContent(/^\d+ms$|^\d+\.\ds$/);
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
        // The runtime still reports activity, so settled error and diagnostics notices must wait.
        await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
        await expect(canvas.queryByText(/Anthropic dropped/)).not.toBeInTheDocument();
    },
};

export const CompactingTurn: Story = {
    args: {
        turn: streamingTurn,
        activityLabel: "Auto-compacting context...",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("status")).toHaveTextContent("Auto-compacting context...");
    },
};

export const DiagnosticsWarning: Story = {
    args: {
        turn: {
            ...completedTurn,
            id: "turn-diagnostics",
            diagnosticsNotice: "Anthropic dropped 2 thinking blocks",
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("status")).toHaveTextContent("Anthropic dropped 2 thinking blocks");
    },
};
