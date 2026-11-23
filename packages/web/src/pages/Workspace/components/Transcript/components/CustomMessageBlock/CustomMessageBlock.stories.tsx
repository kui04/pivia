import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { TranscriptCustomItem } from "@/stores/session/transcript";

import { CustomMessageBlock } from "./CustomMessageBlock";
import styles from "./CustomMessageBlock.stories.module.css";

const SAMPLE_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100">',
    '<rect width="160" height="100" rx="8" fill="#1f1f1f"/>',
    '<rect x="16" y="20" width="128" height="16" rx="4" fill="#6750a4"/>',
    '<rect x="16" y="48" width="96" height="12" rx="4" fill="#3c3c3c"/>',
    "</svg>",
].join("");

const SAMPLE_IMAGE_BASE64 = btoa(SAMPLE_SVG);

const SECOND_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100">',
    '<rect width="160" height="100" rx="8" fill="#1f1f1f"/>',
    '<rect x="16" y="20" width="128" height="16" rx="4" fill="#c72e0f"/>',
    '<rect x="16" y="48" width="64" height="12" rx="4" fill="#3c3c3c"/>',
    "</svg>",
].join("");

const SECOND_IMAGE_BASE64 = btoa(SECOND_SVG);

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
    timestamp: Date.parse("2026-11-17T07:00:00.000Z"),
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
    timestamp: Date.parse("2026-11-17T07:02:00.000Z"),
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
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof CustomMessageBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TaskMessage: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "[task]" });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");

        await expect(canvas.getByRole("heading", { name: "Review summary" })).toBeVisible();
        await expect(canvas.getByText(/Three files changed/)).toBeVisible();
        await expect(canvas.getByRole("region", { name: "task message details" })).toBeVisible();

        await userEvent.click(canvas.getByRole("link", { name: "the report" }));
        await expect(args.onOpenLink).toHaveBeenCalledWith("https://example.com/report");
    },
};

export const WithImages: Story = {
    args: {
        item: withImagesItem,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "[playwright]" }));
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

        await userEvent.click(canvas.getByRole("button", { name: "[screenshot]" }));
        await expect(canvas.getByRole("button", { name: "Inspect [screenshot] image 1" })).toBeVisible();
    },
};
