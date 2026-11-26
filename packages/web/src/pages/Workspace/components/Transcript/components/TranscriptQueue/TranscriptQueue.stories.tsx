import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import storyFrame from "@/storybook/storyFrame.module.css";

import { TranscriptQueue } from "./TranscriptQueue";
import { collectQueuedEntries } from "./queue";

const meta = {
    title: "Pages/Workspace/Transcript/TranscriptQueue",
    component: TranscriptQueue,
    args: {
        entries: collectQueuedEntries({
            steeringMessages: [
                "Focus only on packages/web tests first.",
                "Then run the protocol suite before the summary.",
            ],
            followUpMessages: [
                "Once the suite passes, summarize the diff:\n1. Protocol changes\n2. Web component updates across packages.",
            ],
        }),
    },
    decorators: [
        (Story) => (
            <div className={storyFrame.frame}>
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
        const group = canvas.getByRole("group", { name: "Queued messages" });
        const steeringList = within(group).getByRole("list", { name: "Steering" });
        const followUpList = within(group).getByRole("list", { name: "Follow-up" });
        await expect(within(steeringList).getAllByRole("listitem")).toHaveLength(2);
        await expect(within(followUpList).getAllByRole("listitem")).toHaveLength(1);
        await expect(within(steeringList).getAllByText("Steering")).toHaveLength(1);
        await expect(within(group).getByText("Steering")).toBeVisible();
        await expect(within(group).getByText("Follow-up")).toBeVisible();

        const steeringBubble = canvas.getByText("Focus only on packages/web tests first.");
        await expect(steeringBubble).toBeVisible();

        const steeringItem = within(steeringList).getAllByRole("listitem")[0];
        if (!steeringItem) {
            throw new Error("The story did not render the steering list item");
        }
        const itemRect = steeringItem.getBoundingClientRect();
        const bubbleRect = steeringBubble.getBoundingClientRect();
        // Queued prompt bubbles share UserMessage's right-aligned placement.
        await expect(bubbleRect.left - itemRect.left).toBeGreaterThan(itemRect.right - bubbleRect.right);

        const lastSteeringItem = within(steeringList).getAllByRole("listitem").at(-1);
        if (lastSteeringItem === undefined) {
            throw new Error("The story did not render the last steering list item");
        }
        const lastItemRect = lastSteeringItem.getBoundingClientRect();
        const steeringBadge = within(lastSteeringItem).getByText("Steering");
        const badgeRect = steeringBadge.getBoundingClientRect();
        // The badge straddles the bottom border of the group's last bubble.
        await expect(badgeRect.top + badgeRect.height / 2).toBeCloseTo(lastItemRect.bottom, 0);

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
        await expect(canvas.queryByRole("group", { name: "Queued messages" })).not.toBeInTheDocument();
    },
};
