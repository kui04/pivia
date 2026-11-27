import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptCustomItem } from "@/stores/session";

import { storyImageData } from "@/storybook/fixtures";
import { TranscriptFrame } from "@/storybook/frames";
import { CustomMessageBlock } from "./CustomMessageBlock";

const SAMPLE_IMAGE_BASE64 = storyImageData("#6750a4");
const SECOND_IMAGE_BASE64 = storyImageData("#c72e0f");

const taskMessageItem: TranscriptCustomItem = {
    kind: "custom",
    id: "custom-task",
    customType: "task",
    text: [
        "### Review summary",
        "",
        "The task extension finished its run:",
        "",
        "- Three files changed.",
        "- `pnpm test` passed.",
        "",
        "See [the report](https://example.com/report) for the full log.",
    ].join("\n"),
    images: [],
};

const withImagesItem: TranscriptCustomItem = {
    ...taskMessageItem,
    id: "custom-images",
    customType: "playwright",
    text: "Captured the failing layout before the fix.",
    images: [
        { type: "image", mimeType: "image/svg+xml", data: SAMPLE_IMAGE_BASE64 },
        { type: "image", mimeType: "image/svg+xml", data: SECOND_IMAGE_BASE64 },
    ],
};

const imageOnlyItem: TranscriptCustomItem = {
    kind: "custom",
    id: "custom-image-only",
    customType: "screenshot",
    text: "",
    images: [{ type: "image", mimeType: "image/svg+xml", data: SAMPLE_IMAGE_BASE64 }],
};

const meta = {
    title: "Pages/Workspace/Transcript/CustomMessageBlock",
    component: CustomMessageBlock,
    args: {
        item: taskMessageItem,
        onOpenLink: fn(),
    },
    argTypes: {
        item: { control: false },
        onOpenLink: { control: false },
    },
    decorators: [TranscriptFrame],
} satisfies Meta<typeof CustomMessageBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TaskMessage: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "[task]" });

        // An extension message sent to the reader arrives open, like the terminal client.
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByRole("heading", { name: "Review summary" })).toBeVisible();
        await expect(canvas.getByText(/Three files changed/)).toBeVisible();
        await expect(canvas.getByRole("group", { name: "task message details" })).toBeVisible();

        await userEvent.click(canvas.getByRole("link", { name: "the report" }));
        await expect(args.onOpenLink).toHaveBeenCalledWith("https://example.com/report");

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
    },
};

export const WithImages: Story = {
    args: {
        item: withImagesItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Inspect [playwright] image 2" }));

        const body = within(document.body);
        const dialog = await body.findByRole("dialog");
        await waitFor(async () => {
            await expect(dialog).toBeVisible();
        });
        // Picking the second trigger must open the second attachment, not the first.
        await expect(within(dialog).getByRole("img", { name: "[playwright] image 2" })).toHaveAttribute(
            "src",
            `data:image/svg+xml;base64,${SECOND_IMAGE_BASE64}`,
        );

        await userEvent.click(body.getByRole("button", { name: "Close" }));
        await waitFor(async () => {
            await expect(body.queryByRole("dialog")).not.toBeInTheDocument();
        });
    },
};

export const ImageOnly: Story = {
    args: {
        item: imageOnlyItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("button", { name: "Inspect [screenshot] image 1" })).toBeVisible();
    },
};

export const EmptyMessage: Story = {
    args: {
        item: { ...taskMessageItem, id: "custom-empty", text: "", images: [] },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        // An empty record still explains itself instead of opening on a blank panel.
        await expect(canvas.getByRole("button", { name: "[task]" })).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByText("Empty message")).toBeVisible();
    },
};
