import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { expect, fn, waitFor, within } from "storybook/test";

import { Button, Input, Menu, MenuItem } from "@components";

import { Drawer, type DrawerProps } from "./Drawer";
import styles from "./Drawer.stories.module.css";

/** Sample panel content with the state that has to survive a close. */
function PanelContent() {
    const [filter, setFilter] = useState("");
    const [copied, setCopied] = useState(false);

    return (
        <div className={styles.panel}>
            <p className={styles.title}>Sessions</p>
            <Input
                aria-label="Filter sessions"
                placeholder="Filter sessions"
                value={filter}
                onChange={(event) => {
                    setFilter(event.currentTarget.value);
                }}
            />
            <Menu
                align="end"
                trigger={
                    <Button type="button" variant="secondary">
                        Row actions
                    </Button>
                }
            >
                <MenuItem
                    onClick={() => {
                        setCopied(true);
                    }}
                >
                    Copy path
                </MenuItem>
            </Menu>
            {copied ? <p role="status">Path copied</p> : null}
            <p className={styles.text}>
                The panel is modal: focus stays inside it, the page behind it does not scroll, and Escape closes it. The
                content stays mounted while it is closed.
            </p>
        </div>
    );
}

/**
 * The story opens the drawer from a trigger outside it, so the `open` arg only seeds the local
 * state and the play functions drive the rest through that trigger.
 */
function DrawerDemo({ open: initialOpen, onOpenChange, side, label, children }: DrawerProps) {
    const [open, setOpen] = useState(initialOpen);

    return (
        <>
            <Button
                type="button"
                variant="secondary"
                onClick={() => {
                    setOpen(true);
                }}
            >
                Open drawer
            </Button>
            <Drawer
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    onOpenChange(next);
                }}
                side={side ?? "left"}
                label={label}
            >
                {children}
            </Drawer>
        </>
    );
}

/** A computed z-index, or NaN when the element does not exist. */
function zIndexOf(element: Element | null): number {
    return element === null ? Number.NaN : Number(getComputedStyle(element).zIndex);
}

const meta = {
    title: "Components/Drawer",
    component: Drawer,
    args: {
        open: false,
        onOpenChange: fn(),
        side: "left",
        label: "Sessions",
        children: <PanelContent />,
    },
    argTypes: {
        open: { control: false },
        onOpenChange: { control: false },
        children: { control: false },
    },
    render: (args) => <DrawerDemo {...args} />,
} satisfies Meta<typeof Drawer>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Left: Story = {
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Open drawer" }));

        const panel = await within(document.body).findByRole("dialog", { name: "Sessions" });
        await expect(panel).toBeVisible();
        await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));

        await userEvent.keyboard("{Escape}");

        // The portal stays mounted, so the closed panel hides instead of leaving the DOM.
        await waitFor(async () => {
            await expect(panel).not.toBeVisible();
        });
        await expect(canvas.getByRole("button", { name: "Open drawer" })).toHaveFocus();
    },
};

export const Right: Story = {
    args: {
        side: "right",
    },
    play: async ({ canvasElement, userEvent }) => {
        await userEvent.click(within(canvasElement).getByRole("button", { name: "Open drawer" }));

        const panel = await within(document.body).findByRole("dialog", { name: "Sessions" });
        await expect(panel).toBeVisible();
        await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
        await expect(panel).toHaveAttribute("data-side", "right");
    },
};

export const Bottom: Story = {
    args: {
        side: "bottom",
        label: "New session",
    },
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        await userEvent.click(canvas.getByRole("button", { name: "Open drawer" }));

        const panel = await within(document.body).findByRole("dialog", { name: "New session" });
        await expect(panel).toBeVisible();
        await expect(panel).toHaveAttribute("data-side", "bottom");
        await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));

        await userEvent.keyboard("{Escape}");
        await waitFor(async () => {
            await expect(panel).not.toBeVisible();
        });
    },
};

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

export const Dark: Story = {
    decorators: [
        (Story) => (
            <DarkTheme>
                <Story />
            </DarkTheme>
        ),
    ],
    play: async ({ canvasElement, userEvent }) => {
        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));
        await userEvent.click(within(canvasElement).getByRole("button", { name: "Open drawer" }));

        const panel = await within(document.body).findByRole("dialog", { name: "Sessions" });

        // Surface container in the dark theme.
        await expect(getComputedStyle(panel).backgroundColor).toBe("rgb(31, 31, 31)");
    },
};

/**
 * The menu opens inside the panel's portal. Base UI mounts it after the drawer viewport, so the
 * shared modal layer keeps it above the panel and the scrim instead of painting it underneath,
 * where a tap would dismiss the drawer.
 */
export const MenuInsidePanel: Story = {
    play: async ({ canvasElement, userEvent }) => {
        await userEvent.click(within(canvasElement).getByRole("button", { name: "Open drawer" }));

        const panel = await within(document.body).findByRole("dialog", { name: "Sessions" });
        await userEvent.click(within(panel).getByRole("button", { name: "Row actions" }));

        const menu = await within(document.body).findByRole("menu");
        const viewport = document.querySelector("[data-slot='drawer-viewport']");
        await expect(zIndexOf(menu.parentElement)).toBeGreaterThanOrEqual(zIndexOf(viewport));

        // The item is also the topmost paint at its own centre, so a real tap reaches it.
        const item = within(menu).getByRole("menuitem", { name: "Copy path" });
        const box = item.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        await expect(hit instanceof Node && item.contains(hit)).toBe(true);

        await userEvent.click(item);
        await waitFor(() => expect(within(document.body).queryByRole("menu")).not.toBeInTheDocument());
        await expect(within(panel).getByRole("status")).toHaveTextContent("Path copied");
    },
};

/** The panel keeps its content mounted, so a filter survives a close and a reopen. */
export const KeepsContentState: Story = {
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        const openButton = canvas.getByRole("button", { name: "Open drawer" });

        await userEvent.click(openButton);
        const field = await within(document.body).findByRole("textbox", { name: "Filter sessions" });
        await userEvent.type(field, "parser");

        await userEvent.keyboard("{Escape}");
        await waitFor(async () => {
            await expect(field).not.toBeVisible();
        });

        await userEvent.click(openButton);
        await expect(field).toBeVisible();
        await expect(field).toHaveValue("parser");
    },
};

function ScrollablePanel() {
    return (
        <div className={styles.panel}>
            <p className={styles.title}>Scrolling content</p>
            <div className={styles.scroller} data-testid="drawer-scroller" tabIndex={0} aria-label="Scrolling rows">
                {Array.from({ length: 30 }, (_, index) => (
                    <p key={index} className={styles.row}>
                        Row {index + 1}
                    </p>
                ))}
            </div>
        </div>
    );
}

/** The kept-mounted panel also keeps its inner scroll position. */
export const KeepsScrollPosition: Story = {
    args: {
        children: <ScrollablePanel />,
    },
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        const openButton = canvas.getByRole("button", { name: "Open drawer" });

        await userEvent.click(openButton);
        const panel = await within(document.body).findByRole("dialog", { name: "Sessions" });
        const scroller = panel.querySelector<HTMLElement>("[data-testid='drawer-scroller']");

        if (scroller === null) {
            throw new Error("The drawer did not render its scroll container");
        }

        scroller.scrollTop = 120;
        await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));

        await userEvent.keyboard("{Escape}");
        await waitFor(async () => {
            await expect(panel).not.toBeVisible();
        });

        await userEvent.click(openButton);
        await expect(panel).toBeVisible();
        await expect(scroller.scrollTop).toBeGreaterThan(0);
    },
};
