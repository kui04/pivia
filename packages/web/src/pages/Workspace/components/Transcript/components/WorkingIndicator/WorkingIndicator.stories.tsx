import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import storyFrame from "@/storybook/storyFrame.module.css";

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
    decorators: [
        (Story) => (
            <div className={storyFrame.frame}>
                <Story />
            </div>
        ),
    ],
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
        const spinner = canvasElement.querySelector<HTMLElement>("[data-slot='loading-indicator']");
        if (spinner === null) {
            throw new Error("The working indicator did not render a spinner");
        }

        await expect(spinner).toHaveAttribute("aria-hidden", "true");
        await expect(spinner).toHaveAttribute("data-size", "no-container");

        const label = canvas.getByText("Working...");
        const shimmer = getComputedStyle(label);
        await expect(shimmer.animationName).toBe("shimmer");
        await expect(shimmer.backgroundImage).toContain("linear-gradient");
    },
};
