import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { Button } from "@components/Button";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./Collapsible";
import styles from "./Collapsible.stories.module.css";

const meta = {
    title: "Components/Collapsible",
    component: Collapsible,
    args: {
        onOpenChange: fn(),
        children: (
            <>
                <CollapsibleTrigger render={<Button type="button" variant="secondary" />}>Details</CollapsibleTrigger>
                <CollapsiblePanel>
                    <p className={styles.body}>Collapsible content mounts on open and unmounts on close.</p>
                </CollapsiblePanel>
            </>
        ),
    },
    argTypes: {
        children: { control: false },
        onOpenChange: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof Collapsible>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement, args }) => {
        args.onOpenChange?.mockClear();
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Details" });

        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(trigger).not.toHaveAttribute("aria-controls");
        await expect(
            canvas.queryByText("Collapsible content mounts on open and unmounts on close."),
        ).not.toBeInTheDocument();

        await userEvent.click(trigger);

        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(trigger).toHaveAttribute("data-panel-open");
        await expect(args.onOpenChange).toHaveBeenCalledWith(true, expect.anything());
        await waitFor(async () => {
            await expect(canvas.getByText("Collapsible content mounts on open and unmounts on close.")).toBeVisible();
        });

        const panelId = trigger.getAttribute("aria-controls");
        await expect(panelId).toBeTruthy();
        if (panelId !== null) {
            await expect(document.getElementById(panelId)).toBeInTheDocument();
        }

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.anything());
        await waitFor(async () => {
            await expect(
                canvas.queryByText("Collapsible content mounts on open and unmounts on close."),
            ).not.toBeInTheDocument();
        });
    },
};

export const DefaultOpen: Story = {
    args: {
        defaultOpen: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Details" });

        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByText("Collapsible content mounts on open and unmounts on close.")).toBeVisible();
    },
};

export const Controlled: Story = {
    args: {
        open: true,
    },
    play: async ({ canvasElement, args }) => {
        args.onOpenChange?.mockClear();
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Details" });

        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await userEvent.click(trigger);

        await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.anything());
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
    play: async ({ canvasElement, args }) => {
        args.onOpenChange?.mockClear();
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Details" });

        await expect(trigger).toBeDisabled();
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(trigger);
        await expect(args.onOpenChange).not.toHaveBeenCalled();
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
    },
};
