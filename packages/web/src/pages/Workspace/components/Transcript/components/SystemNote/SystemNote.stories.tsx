import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptNoteItem } from "@/stores/session";
import storyFrame from "@/storybook/storyFrame.module.css";

import { SystemNote } from "./SystemNote";

const compactionNote: TranscriptNoteItem = {
    kind: "note",
    id: "note-compaction",
    title: "Compaction",
    text: [
        "**Earlier context:** the reader asked for a read-only transcript view.",
        "",
        "- The projection lives in `@pivia/protocol`.",
        "- The view composes `ScrollArea` with user bubbles and turn groups.",
    ].join("\n"),
};

const longNote: TranscriptNoteItem = {
    kind: "note",
    id: "note-long",
    title: "Branch summary",
    text: Array.from(
        { length: 24 },
        (_, index) => `Paragraph ${index + 1}: the abandoned branch explored layout variant ${index + 1}.`,
    ).join("\n\n"),
};

const meta = {
    title: "Pages/Workspace/Transcript/SystemNote",
    component: SystemNote,
    args: {
        item: compactionNote,
        onOpenLink: fn(),
    },
    argTypes: {
        item: { control: false },
        onOpenLink: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={storyFrame.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof SystemNote>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CompactionCheckpoint: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Compaction" });

        // A note shares the thinking block shell: collapsed until the reader opens it.
        await expect(trigger).toHaveAttribute("aria-expanded", "false");

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByText(/the reader asked for a read-only transcript view/)).toBeVisible();
        await expect(canvas.getByRole("group", { name: "Compaction details" })).toBeVisible();
    },
};

export const LongSummaryScrolls: Story = {
    args: {
        item: longNote,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Branch summary" });
        await userEvent.click(trigger);

        const viewport = await waitFor(() => canvas.getByRole("group", { name: "Branch summary details" }));
        await waitFor(async () => {
            await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        });
    },
};

export const WithTokensAndBilling: Story = {
    args: {
        item: {
            ...compactionNote,
            id: "note-compaction-meta",
            tokensBefore: 42_100,
            billing: { billedTokens: 3_200, approxCostUsd: 0.024 },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("button", { name: "Compaction" })).toBeVisible();
        await expect(canvas.getByText("Compacted from 42,100 tokens · 3.2k tokens billed (~$0.02)")).toBeVisible();
    },
};
