import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, spyOn, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptBashItem } from "@/stores/session/transcript";

import { BashExecutionBlock } from "./BashExecutionBlock";
import styles from "./BashExecutionBlock.stories.module.css";

const longOutput = Array.from(
    { length: 40 },
    (_, index) => `a3d61${index.toString().padStart(2, "0")} feat(workspace): transcript step ${index + 1}`,
).join("\n");

const succeededItem: TranscriptBashItem = {
    kind: "bash",
    id: "bash-succeeded",
    command: "pnpm test",
    output: ["Test Files  28 passed (28)", "     Tests  261 passed (261)"].join("\n"),
    excludeFromContext: false,
    status: { kind: "succeeded" },
    truncation: { kind: "none" },
};

const longOutputItem: TranscriptBashItem = {
    ...succeededItem,
    id: "bash-long",
    command: "git log --oneline -40",
    output: longOutput,
};

const failedItem: TranscriptBashItem = {
    ...succeededItem,
    id: "bash-failed",
    command: "pnpm typecheck",
    output: "src/App.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    status: { kind: "failed", exitCode: 2 },
};

const cancelledItem: TranscriptBashItem = {
    ...succeededItem,
    id: "bash-cancelled",
    command: "pnpm dev",
    output: "VITE v8.3.8  ready in 240 ms",
    status: { kind: "cancelled" },
};

const truncatedItem: TranscriptBashItem = {
    ...succeededItem,
    id: "bash-truncated",
    command: "pnpm build --verbose",
    output: longOutput,
    status: { kind: "failed", exitCode: 1 },
    truncation: { kind: "truncated", fullOutputPath: "/tmp/pi-bash-a3d610.log" },
};

const excludedItem: TranscriptBashItem = {
    ...succeededItem,
    id: "bash-excluded",
    command: "git status --short",
    output: " M packages/web/src/stores/session/transcript.ts",
    excludeFromContext: true,
};

const failedExcludedItem: TranscriptBashItem = {
    ...failedItem,
    id: "bash-failed-excluded",
    excludeFromContext: true,
};

const unnamedCommandItem: TranscriptBashItem = {
    ...succeededItem,
    id: "bash-unnamed",
    command: "",
    output: "orphaned output",
};

const meta = {
    title: "Pages/Workspace/Transcript/BashExecutionBlock",
    component: BashExecutionBlock,
    args: {
        item: succeededItem,
        onCopy: fn(),
    },
    argTypes: {
        item: { control: false },
        onCopy: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof BashExecutionBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Succeeded: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("pnpm test")).toBeVisible();
        await expect(canvas.getByText(/261 passed/)).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Wrap lines" })).toHaveAttribute("aria-pressed", "false");
        await expect(canvas.getByRole("button", { name: "Copy output" })).toBeEnabled();
    },
};

export const LongOutputScrolls: Story = {
    args: {
        item: longOutputItem,
    },
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const viewport = canvas.getByRole("group", { name: "git log --oneline -40 output" });
        const output = canvasElement.querySelector("pre");

        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
            await expect(canvasElement.querySelector("[data-fade-bottom='true']")).not.toBeNull();
        });
        await expect(output).not.toHaveAttribute("data-wrapped");

        const wrapButton = canvas.getByRole("button", { name: "Wrap lines" });
        await userEvent.click(wrapButton);
        await expect(wrapButton).toHaveAttribute("aria-pressed", "true");
        await expect(output).toHaveAttribute("data-wrapped", "true");

        const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
        try {
            await userEvent.click(canvas.getByRole("button", { name: "Copy output" }));
            await waitFor(async () => {
                await expect(canvas.getByRole("status")).toHaveTextContent("Copied");
            });
            await expect(writeText).toHaveBeenCalledWith(longOutput);
            await expect(args.onCopy).toHaveBeenCalledWith(longOutput);
        } finally {
            writeText.mockRestore();
        }
    },
};

export const FailedExit: Story = {
    args: {
        item: failedItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText(/exited 2/)).toBeVisible();
        await expect(canvas.getByText(/error TS2322/)).toBeVisible();
    },
};

export const Cancelled: Story = {
    args: {
        item: cancelledItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText(/cancelled/)).toBeVisible();
    },
};

export const TruncatedOutput: Story = {
    args: {
        item: truncatedItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText(/Output truncated/)).toBeVisible();
        await expect(canvas.getByText("Output truncated. Full output: /tmp/pi-bash-a3d610.log")).toBeVisible();
    },
};

export const ExcludedFromContext: Story = {
    args: {
        item: excludedItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvasElement.querySelector("[data-context='excluded']")).not.toBeNull();
        // The suffix spells out the state, so the accent border is not the only signal.
        await expect(canvas.getByText(/not in context/)).toBeVisible();
        await expect(canvas.getByText("git status --short")).toBeVisible();
    },
};

export const FailedAndExcluded: Story = {
    args: {
        item: failedExcludedItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText(/exited 2/)).toBeVisible();
        await expect(canvas.getByText(/not in context/)).toBeVisible();
    },
};

export const UnnamedCommand: Story = {
    args: {
        item: unnamedCommandItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("group", { name: "Command output" })).toBeVisible();
        await expect(canvas.getByText("orphaned output")).toBeVisible();
    },
};
