import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { Button } from "../Button";
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "./Popover";

const meta = {
    title: "Components/Popover",
    component: Popover,
    args: {
        children: null,
    },
} satisfies Meta<typeof Popover>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: () => (
        <Popover>
            <PopoverTrigger render={<Button type="button" variant="secondary" />}>Open popover</PopoverTrigger>
            <PopoverContent side="bottom" align="start">
                <PopoverTitle>Session options</PopoverTitle>
                <PopoverDescription>Adjust model or thinking depth.</PopoverDescription>
                <PopoverClose render={<Button type="button" variant="ghost" />}>Done</PopoverClose>
            </PopoverContent>
        </Popover>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Open popover" });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(trigger);

        const dialog = await screen.findByRole("dialog");
        await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe("1"));
        await expect(within(dialog).getByText("Session options")).toBeVisible();

        await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};
