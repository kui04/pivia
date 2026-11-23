import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptUserItem } from "@/stores/session/transcript";

import { UserMessage } from "./UserMessage";
import styles from "./UserMessage.stories.module.css";

const SAMPLE_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100">',
    '<rect width="160" height="100" rx="8" fill="#1f1f1f"/>',
    '<rect x="16" y="20" width="128" height="16" rx="4" fill="#0078d4"/>',
    '<rect x="16" y="48" width="96" height="12" rx="4" fill="#3c3c3c"/>',
    "</svg>",
].join("");

const SAMPLE_IMAGE_BASE64 = btoa(SAMPLE_SVG);

const shortPromptItem: TranscriptUserItem = {
    kind: "user",
    id: "user-short",
    text: "Ship the transcript view.",
    images: [],
    timestamp: Date.parse("2026-11-17T06:00:00.000Z"),
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
    timestamp: Date.parse("2026-11-17T06:01:00.000Z"),
};

const withImagesItem: TranscriptUserItem = {
    kind: "user",
    id: "user-images",
    text: "Look at this screenshot and match the button radius.",
    images: [{ type: "image", mimeType: "image/svg+xml", data: SAMPLE_IMAGE_BASE64 }],
    timestamp: Date.parse("2026-11-17T06:02:00.000Z"),
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
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof UserMessage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ShortPrompt: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const bubble = canvas.getByText("Ship the transcript view.");
        await expect(bubble).toBeVisible();

        const root = bubble.parentElement;
        if (root === null) {
            throw new Error("The story did not render the user message container");
        }
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
