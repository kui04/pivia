import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy, Ellipsis, Pencil, Trash } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

import { IconButton } from "../IconButton/IconButton";

import { Menu, MenuItem, MenuSeparator } from "./Menu";

const onCopy = fn();

const defaultItems = (
    <>
        <MenuItem icon={<Copy />} shortcut="Ctrl+C" onClick={onCopy}>
            Copy
        </MenuItem>
        <MenuItem icon={<Pencil />} shortcut="Ctrl+E">
            Rename
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash />} destructive>
            Delete
        </MenuItem>
    </>
);

const meta = {
    title: "Components/Menu",
    component: Menu,
    args: {
        trigger: (
            <IconButton label="Message actions">
                <Ellipsis />
            </IconButton>
        ),
        children: null,
    },
} satisfies Meta<typeof Menu>;

export default meta;

type Story = StoryObj<typeof meta>;

function DarkTheme({ children }: { children: ReactNode }) {
    useEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = "dark";

        return () => {
            delete root.dataset.theme;
        };
    }, []);

    return <>{children}</>;
}

export const Default: Story = {
    args: {
        children: defaultItems,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Message actions" });

        onCopy.mockClear();

        await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
        await expect(trigger).toHaveAttribute("aria-expanded", "false");

        await userEvent.click(trigger);

        const menu = await screen.findByRole("menu");

        await waitFor(() => expect(getComputedStyle(menu).opacity).toBe("1"));

        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
        await expect(within(menu).getByRole("separator")).toBeInTheDocument();

        // The popup uses the token duration and the Base UI transform origin.
        const style = getComputedStyle(menu);
        await expect(style.transitionProperty).toContain("opacity");
        await expect(style.transitionProperty).toContain("scale");
        await expect(style.transitionDuration).toContain("0.15s");
        await expect(style.transformOrigin).not.toBe("50% 50%");

        await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));

        await expect(onCopy).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const Keyboard: Story = {
    args: {
        children: defaultItems,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Message actions" });

        trigger.focus();
        await userEvent.keyboard("{Enter}");

        const menu = await screen.findByRole("menu");

        await userEvent.keyboard("{ArrowDown}");
        await waitFor(() => expect(menu.querySelector("[data-highlighted]")).not.toBeNull());

        const highlighted = menu.querySelector<HTMLElement>("[data-highlighted]");
        if (highlighted === null) {
            throw new Error("The keyboard highlight is missing");
        }
        await waitFor(() => expect(highlighted).toHaveFocus());

        await userEvent.keyboard("{Escape}");

        await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const ManyItems: Story = {
    args: {
        children: Array.from({ length: 20 }, (_, index) => <MenuItem key={index}>Action {index + 1}</MenuItem>),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Message actions" }));

        const menu = await screen.findByRole("menu");
        await waitFor(() => expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight));
        await expect(within(menu).getByRole("menuitem", { name: "Action 20" })).toBeInTheDocument();
    },
};

export const Sections: Story = {
    args: {
        children: (
            <>
                <MenuItem icon={<Pencil />}>Rename</MenuItem>
                <MenuItem icon={<Copy />}>Duplicate</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash />} destructive>
                    Delete
                </MenuItem>
            </>
        ),
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Message actions" }));

        const menu = await screen.findByRole("menu");
        const normal = within(menu).getByRole("menuitem", { name: "Rename" });
        const destructive = within(menu).getByRole("menuitem", { name: "Delete" });

        await expect(within(menu).getByRole("separator")).toBeInTheDocument();
        await expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
        await expect(getComputedStyle(destructive).color).not.toBe(getComputedStyle(normal).color);
    },
};

export const Dark: Story = {
    decorators: [
        (Story) => (
            <DarkTheme>
                <Story />
            </DarkTheme>
        ),
    ],
    args: {
        children: defaultItems,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));
        await userEvent.click(canvas.getByRole("button", { name: "Message actions" }));

        const menu = await screen.findByRole("menu");

        // The popup must take the dark surface role, not the light one.
        await expect(getComputedStyle(menu).backgroundColor).toBe("rgb(32, 32, 32)");
    },
};
