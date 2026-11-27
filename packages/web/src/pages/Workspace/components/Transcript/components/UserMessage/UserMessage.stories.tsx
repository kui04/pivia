import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptUserItem } from "@/stores/session";

import { requireElement } from "@/storybook/dom";
import { storyImageData } from "@/storybook/fixtures";
import { TranscriptFrame } from "@/storybook/frames";
import { UserMessage } from "./UserMessage";

const SAMPLE_IMAGE_BASE64 = storyImageData("#0078d4");

const shortPromptItem: TranscriptUserItem = {
    kind: "user",
    id: "user-short",
    text: "Ship the transcript view.",
    images: [],
};

const multilinePromptItem: TranscriptUserItem = {
    kind: "user",
    id: "user-multiline",
    text: [
        "Finish the transcript view:",
        "1. Show the turn header as Worked for Xs.",
        "2. Connect the steps with the vertical guide rail.",
        "3. Render intermediate replies as Markdown.",
    ].join("\n"),
    images: [],
};

const withImagesItem: TranscriptUserItem = {
    kind: "user",
    id: "user-images",
    text: "Look at this screenshot and match the button radius.",
    images: [{ type: "image", mimeType: "image/svg+xml", data: SAMPLE_IMAGE_BASE64 }],
};

const meta = {
    title: "Pages/Workspace/Transcript/UserMessage",
    component: UserMessage,
    args: {
        item: shortPromptItem,
    },
    argTypes: {
        item: { control: false },
    },
    decorators: [TranscriptFrame],
} satisfies Meta<typeof UserMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ShortPrompt: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const bubble = canvas.getByText("Ship the transcript view.");
        await expect(bubble).toBeVisible();

        const root = requireElement(bubble.parentElement, "root");
        const rootRect = root.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        // A right-aligned prompt sits closer to the end edge than to the start edge.
        await expect(bubbleRect.left - rootRect.left).toBeGreaterThan(rootRect.right - bubbleRect.right);
    },
};

export const MultilinePrompt: Story = {
    args: {
        item: multilinePromptItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText(/Finish the transcript view/)).toBeVisible();
        await expect(canvas.getByText(/Render intermediate replies as Markdown/)).toBeVisible();
    },
};

export const WithImages: Story = {
    args: {
        item: withImagesItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText(/Look at this screenshot/)).toBeVisible();

        await userEvent.click(canvas.getByRole("button", { name: "Inspect Attachment 1" }));

        const body = within(document.body);
        const dialog = await body.findByRole("dialog");
        await waitFor(async () => {
            await expect(dialog).toBeVisible();
        });

        await userEvent.click(body.getByRole("button", { name: "Close" }));
        await waitFor(async () => {
            await expect(body.queryByRole("dialog")).not.toBeInTheDocument();
        });
    },
};
