import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { Button } from "./Button";

const onClick = fn();

const meta = {
    title: "Components/Button",
    component: Button,
    args: {
        children: "Connect",
        onClick,
    },
    argTypes: {
        variant: { control: "select", options: ["primary", "secondary", "ghost"] },
        size: { control: "select", options: ["md", "lg"] },
        radius: { control: "select", options: ["none", "extra-small", "small", "medium", "large", "full"] },
        disabled: { control: "boolean" },
        onClick: { control: false },
    },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = {
    play: async ({ canvasElement }) => {
        onClick.mockClear();
        const canvas = within(canvasElement);
        const button = canvas.getByRole("button", { name: "Connect" });

        await expect(button).toHaveAttribute("data-variant", "primary");
        await userEvent.click(button);

        await expect(onClick).toHaveBeenCalledOnce();
    },
};

export const Variants: Story = {
    render: () => (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-12)" }}>
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
        </div>
    ),
};

export const Sizes: Story = {
    render: () => (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-12)" }}>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
        </div>
    ),
};

export const Radii: Story = {
    render: () => (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-12)" }}>
            <Button radius="none">None</Button>
            <Button radius="extra-small">Extra small</Button>
            <Button radius="small">Small</Button>
            <Button radius="medium">Medium</Button>
            <Button radius="large">Large</Button>
            <Button radius="full">Full</Button>
        </div>
    ),
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
    play: async ({ canvasElement }) => {
        onClick.mockClear();
        const button = within(canvasElement).getByRole("button", { name: "Connect" });

        await expect(button).toBeDisabled();
        await userEvent.click(button);

        await expect(onClick).not.toHaveBeenCalled();
    },
};
