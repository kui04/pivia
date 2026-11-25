import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { TranscriptQueue } from "./TranscriptQueue";
import { collectQueuedEntries } from "./queue";
import styles from "./TranscriptQueue.stories.module.css";

const meta = {
    title: "Pages/Workspace/Transcript/TranscriptQueue",
    component: TranscriptQueue,
    args: {
        entries: collectQueuedEntries({
            steeringMessages: ["Focus only on packages/web tests first."],
            followUpMessages: [
                "Once the suite passes, summarize the diff:\n1. Protocol changes\n2. Web component updates across packages.",
            ],
        }),
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof TranscriptQueue>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SteeringAndFollowUp: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const list = canvas.getByRole("list", { name: "Queued messages" });
        const items = within(list).getAllByRole("listitem");
        await expect(items).toHaveLength(2);
        await expect(canvas.getByText("Queued · Steering")).toBeVisible();
        await expect(canvas.getByText("Queued · Follow-up")).toBeVisible();

        const steeringBubble = canvas.getByText("Focus only on packages/web tests first.");
        await expect(steeringBubble).toBeVisible();

        const steeringItem = items[0];
        if (!steeringItem) {
            throw new Error("The story did not render the steering list item");
        }
        const itemRect = steeringItem.getBoundingClientRect();
        const bubbleRect = steeringBubble.getBoundingClientRect();
        // Queued prompt bubbles share UserMessage's right-aligned placement.
        await expect(bubbleRect.left - itemRect.left).toBeGreaterThan(itemRect.right - bubbleRect.right);

        await expect(canvas.getByText(/Once the suite passes, summarize the diff:/)).toBeVisible();
        await expect(canvas.getByText(/2\. Web component updates across packages\./)).toBeVisible();
    },
};

export const EmptyQueues: Story = {
    args: {
        entries: [],
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.queryByRole("list", { name: "Queued messages" })).not.toBeInTheDocument();
    },
};
