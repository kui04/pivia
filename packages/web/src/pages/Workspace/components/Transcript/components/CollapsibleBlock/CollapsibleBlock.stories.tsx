import type { Meta, StoryObj } from "@storybook/react-vite";
import { Brain } from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";

import storyFrame from "@/storybook/storyFrame.module.css";

import { CollapsibleBlock } from "./CollapsibleBlock";
import styles from "./CollapsibleBlock.stories.module.css";

const meta = {
    title: "Pages/Workspace/Transcript/CollapsibleBlock",
    component: CollapsibleBlock,
    args: {
        label: "Thoughts",
        icon: Brain,
        scrollLabel: "Thoughts details",
        onOpenChange: fn(),
        children: <p className={styles.paragraph}>The body stays collapsed until the reader opens it.</p>,
    },
    argTypes: {
        children: { control: false },
        icon: { control: false },
        onOpenChange: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={storyFrame.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof CollapsibleBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Thoughts" });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(args.onOpenChange).toHaveBeenCalledWith(true);
        await expect(canvas.getByText("The body stays collapsed until the reader opens it.")).toBeVisible();
    },
};

export const StreamingLabel: Story = {
    args: {
        label: "Thinking...",
        streaming: true,
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const label = canvas.getByText("Thinking...");
        await expect(getComputedStyle(label).animationName).toBe("shimmer");
        await expect(canvas.getByText("The body stays collapsed until the reader opens it.")).toBeVisible();
    },
};
