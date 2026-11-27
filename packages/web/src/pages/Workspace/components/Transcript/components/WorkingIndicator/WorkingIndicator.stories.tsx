import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { requireElement } from "@/storybook/dom";
import { TranscriptFrame } from "@/storybook/frames";
import { WorkingIndicator } from "./WorkingIndicator";

const meta = {
    title: "Pages/Workspace/Transcript/WorkingIndicator",
    component: WorkingIndicator,
    args: {
        label: "Working...",
    },
    argTypes: {
        label: { control: "text" },
    },
    decorators: [TranscriptFrame],
} satisfies Meta<typeof WorkingIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const status = canvas.getByRole("status");

        await expect(status).toHaveTextContent("Working...");

        // The spinner is decorative, so the status text is the only announcement.
        await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
        const spinner = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='loading-indicator']"),
            "spinner",
        );

        await expect(spinner).toHaveAttribute("aria-hidden", "true");
        await expect(spinner).toHaveAttribute("data-size", "no-container");

        const label = canvas.getByText("Working...");
        const shimmer = getComputedStyle(label);
        await expect(shimmer.animationName).toBe("shimmer");
        await expect(shimmer.backgroundImage).toContain("linear-gradient");
    },
};
