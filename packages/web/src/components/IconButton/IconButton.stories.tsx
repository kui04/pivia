import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bookmark, Copy, Plus, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { IconButton } from "./IconButton";

function Row({ children }: { children: ReactNode }) {
    return <div style={{ display: "flex", alignItems: "center", gap: "var(--space-16)" }}>{children}</div>;
}

function ToggleIconButton() {
    const [pressed, setPressed] = useState(false);

    return (
        <IconButton
            label="Bookmark session"
            aria-pressed={pressed}
            onClick={() => {
                setPressed((current) => !current);
            }}
        >
            <Bookmark />
        </IconButton>
    );
}

const disabledColors = ["rgb(206, 206, 206)", "rgb(60, 60, 60)"];

const meta = {
    title: "Components/IconButton",
    component: IconButton,
    args: {
        label: "Copy code",
        children: <Copy />,
    },
} satisfies Meta<typeof IconButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const button = canvas.getByRole("button", { name: "Copy code" });

        await expect(button.getAttribute("aria-label")).toBe("Copy code");
        await userEvent.hover(button);

        // The tooltip is portaled to the document body, outside the story canvas.
        await waitFor(() => expect(screen.getByText("Copy code")).toBeInTheDocument(), { timeout: 3000 });

        await userEvent.unhover(button);
        await waitFor(() => expect(screen.queryByText("Copy code")).not.toBeInTheDocument(), { timeout: 3000 });
    },
};

export const Toggle: Story = {
    render: () => <ToggleIconButton />,
    play: async ({ canvasElement }) => {
        const button = within(canvasElement).getByRole("button", { name: "Bookmark session" });

        await expect(button).toHaveAttribute("aria-pressed", "false");
        await userEvent.click(button);
        await expect(button).toHaveAttribute("aria-pressed", "true");
        await userEvent.click(button);
        await expect(button).toHaveAttribute("aria-pressed", "false");
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
    play: async ({ canvasElement }) => {
        const button = within(canvasElement).getByRole("button", { name: "Copy code" });

        await expect(button).toHaveAttribute("data-disabled");
        await waitFor(() => expect(disabledColors).toContain(getComputedStyle(button).color));
    },
};

export const Sizes: Story = {
    render: () => (
        <Row>
            <IconButton size="sm" label="Small">
                <Plus />
            </IconButton>
            <IconButton size="no-container" label="No container">
                <Plus />
            </IconButton>
            <IconButton size="md" label="Medium">
                <Plus />
            </IconButton>
            <IconButton size="lg" label="Large">
                <Plus />
            </IconButton>
            <IconButton size="xl" label="Extra large">
                <Plus />
            </IconButton>
        </Row>
    ),
};

export const Radii: Story = {
    render: () => (
        <Row>
            <IconButton radius="none" label="No radius">
                <Search />
            </IconButton>
            <IconButton radius="extra-small" label="Extra small radius">
                <Search />
            </IconButton>
            <IconButton radius="small" label="Small radius">
                <Search />
            </IconButton>
            <IconButton radius="medium" label="Medium radius">
                <Search />
            </IconButton>
            <IconButton radius="full" label="Full radius">
                <Search />
            </IconButton>
        </Row>
    ),
};
