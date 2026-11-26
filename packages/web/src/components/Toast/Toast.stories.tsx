import type { Meta, StoryObj } from "@storybook/react-vite";

import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { DarkTheme } from "@/storybook/theme";

import { ToastProvider } from "./Toast";
import { createToastManager, useToast } from "./useToast";

const meta = {
    title: "Components/Toast",
    component: ToastProvider,
    args: {
        timeout: 0,
        limit: 3,
        position: "bottom-right",
    },
    argTypes: {
        position: {
            control: "select",
            options: ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"],
        },
    },
} satisfies Meta<typeof ToastProvider>;

export default meta;

type Story = StoryObj<typeof meta>;

function ShowToast({ title, description }: { title: string; description: string }) {
    const toast = useToast();

    return (
        <button type="button" onClick={() => toast.add({ title, description })}>
            Show toast
        </button>
    );
}

export const Default: Story = {
    render: (args) => (
        <ToastProvider {...args}>
            <ShowToast title="Changes saved" description="Your edits are now available on this device." />
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Show toast" }));

        const toast = await screen.findByRole("dialog", { name: "Changes saved" });

        await expect(within(toast).getByText("Your edits are now available on this device.")).toBeInTheDocument();

        const close = within(toast).getByRole("button", { name: "Dismiss toast" });

        await userEvent.click(close);

        await waitFor(() => expect(document.querySelectorAll("[data-slot='toast']")).toHaveLength(0));
    },
};

function StackDemo() {
    const toast = useToast();

    return (
        <button
            type="button"
            onClick={() => {
                ["Saved", "Copied", "Uploaded", "Queued"].forEach((title) => {
                    toast.add({
                        title,
                        description: "This toast is part of the stack.",
                    });
                });
            }}
        >
            Show stack
        </button>
    );
}

export const Stacked: Story = {
    render: (args) => (
        <ToastProvider {...args}>
            <StackDemo />
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Show stack" }));

        await waitFor(() => expect(document.querySelectorAll("[data-slot='toast']")).toHaveLength(4));

        const toasts = [...document.querySelectorAll<HTMLElement>("[data-slot='toast']")];
        const visible = toasts.filter((toast) => !toast.hasAttribute("data-limited"));
        const viewport = screen.getByRole("region", { name: "Toasts" });

        await expect(visible).toHaveLength(3);
        await userEvent.hover(visible[0] as HTMLElement);

        await waitFor(() => expect(visible[0]).toHaveAttribute("data-expanded"));
        await userEvent.unhover(visible[0] as HTMLElement);
        await waitFor(() => expect(viewport).not.toHaveAttribute("data-expanded"));

        const front = visible[0] as HTMLElement;
        const behind = visible[1] as HTMLElement;
        const frontClose = within(front).getByRole("button", { name: "Dismiss toast" });
        const behindClose = behind.querySelector<HTMLElement>("[data-slot='toast-close']");

        if (behindClose === null) {
            throw new Error("The behind toast close button is missing");
        }

        await expect(getComputedStyle(frontClose).visibility).toBe("visible");
        await expect(getComputedStyle(behindClose).visibility).toBe("hidden");
    },
};

function ActionDemo() {
    const toast = useToast();

    return (
        <button
            type="button"
            onClick={() => {
                toast.add({
                    title: "Message deleted",
                    description: "The message can still be restored.",
                    actionProps: {
                        children: "Undo",
                        onClick: () => {
                            toast.add({ title: "Message restored" });
                        },
                    },
                });
            }}
        >
            Show action toast
        </button>
    );
}

export const WithAction: Story = {
    render: (args) => (
        <ToastProvider {...args}>
            <ActionDemo />
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Show action toast" }));

        const toast = await screen.findByRole("dialog", { name: "Message deleted" });

        await userEvent.click(within(toast).getByRole("button", { name: "Undo" }));

        await expect(await screen.findByRole("dialog", { name: "Message restored" })).toBeInTheDocument();
    },
};

function TypesDemo() {
    const toast = useToast();

    return (
        <button
            type="button"
            onClick={() => {
                const types = [
                    ["info", "Update available", "A new version is available."],
                    ["success", "File saved", "The file was saved."],
                    ["warning", "Slow connection", "The connection is slow."],
                    ["error", "Save failed", "The file could not be saved."],
                ] as const;

                types.forEach(([type, title, description]) => {
                    toast.add({
                        type,
                        title,
                        description,
                    });
                });
            }}
        >
            Show all types
        </button>
    );
}

export const Types: Story = {
    args: {
        limit: 4,
    },
    render: (args) => (
        <ToastProvider {...args}>
            <TypesDemo />
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Show all types" }));
        await waitFor(() => expect(document.querySelectorAll("[data-slot='toast']")).toHaveLength(4));

        const icons = [...document.querySelectorAll<HTMLElement>("[data-slot='toast-icon']")];
        const borders = [...document.querySelectorAll<HTMLElement>("[data-slot='toast']")];

        await expect(icons).toHaveLength(4);
        await expect(new Set(icons.map((icon) => getComputedStyle(icon).color)).size).toBe(4);
        await expect(new Set(borders.map((toast) => getComputedStyle(toast).borderColor)).size).toBe(1);
    },
};

function TimeoutProbe() {
    const toast = useToast();

    return (
        <>
            <button
                type="button"
                onClick={() => {
                    ["info", "success", "warning", "error"].forEach((type) => {
                        toast.add({ type, title: type });
                    });
                }}
            >
                Show typed toasts
            </button>
            <ul>
                {toast.toasts.map((toast) => (
                    <li key={toast.id} data-slot="toast-timeout">
                        {`${toast.type}:${toast.timeout === undefined ? "provider" : toast.timeout}`}
                    </li>
                ))}
            </ul>
        </>
    );
}

/**
 * A warning and an error must reach the store with `timeout: 0`, which is how
 * Base UI spells "no auto-dismiss". The other types stay on the provider
 * timeout, so the story reads the resolved value off the manager instead of
 * waiting on a real timer.
 */
export const PersistentSeverities: Story = {
    args: {
        limit: 4,
        timeout: 5000,
    },
    render: (args) => (
        <ToastProvider {...args}>
            <TimeoutProbe />
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Show typed toasts" }));
        await waitFor(() => expect(canvas.getAllByRole("listitem")).toHaveLength(4));

        const timeouts = [...canvas.getAllByRole("listitem")]
            .map((item) => item.textContent ?? "")
            .sort((left, right) => left.localeCompare(right));

        await expect(timeouts).toEqual(["error:0", "info:provider", "success:provider", "warning:0"]);
    },
};

function BodyOnlyDemo() {
    const toast = useToast();

    return (
        <button
            type="button"
            onClick={() => {
                toast.add({ description: "This toast has no icon and no title." });
            }}
        >
            Show body-only toast
        </button>
    );
}

export const BodyOnly: Story = {
    render: (args) => (
        <ToastProvider {...args}>
            <BodyOnlyDemo />
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Show body-only toast" }));

        const body = await screen.findByText("This toast has no icon and no title.");
        const toast = body.closest<HTMLElement>("[data-slot='toast']");

        if (toast === null) {
            throw new Error("The toast root is missing");
        }

        await expect(toast.querySelector("[data-slot='toast-icon']")).toBeNull();
        await expect(toast.querySelector("h2")).toBeNull();
        await expect(toast).toHaveAttribute("aria-label", "Toast");

        const close = within(toast).getByRole("button", { name: "Dismiss toast" });

        await expect(getComputedStyle(close).position).toBe("absolute");
        await expect(Math.round(close.getBoundingClientRect().width)).toBe(24);
        await expect(Math.round(close.getBoundingClientRect().top)).toBe(Math.round(body.getBoundingClientRect().top));
        await expect(close.getBoundingClientRect().left).toBeGreaterThan(body.getBoundingClientRect().right);
    },
};

function SameIdDemo() {
    const toast = useToast();

    return (
        <button
            type="button"
            onClick={() => {
                toast.add({ id: "same", title: "First message" });
                toast.add({ id: "same", title: "Second message" });
            }}
        >
            Show same id
        </button>
    );
}

/**
 * Base UI replaces a toast with an existing id instead of stacking a second
 * card. The wrapper forwards the id unchanged, so this story pins the real
 * provider behavior rather than only the option object.
 */
export const SameId: Story = {
    render: (args) => (
        <ToastProvider {...args}>
            <SameIdDemo />
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Show same id" }));

        await expect(await screen.findByRole("dialog", { name: "Second message" })).toBeInTheDocument();
        await expect(screen.queryByRole("dialog", { name: "First message" })).not.toBeInTheDocument();
    },
};

/**
 * The app reports from outside the React tree, through the manager it creates
 * once in `src/lib/toast.ts`. This story drives the same shape, so a
 * provider that fails to adopt an external manager shows up here.
 */
const externalManager = createToastManager();

export const ExternalManager: Story = {
    render: (args) => (
        <ToastProvider {...args} toastManager={externalManager}>
            <button
                type="button"
                onClick={() => {
                    externalManager.add({ id: "external", type: "warning", title: "From outside React" });
                }}
            >
                Show external toast
            </button>
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Show external toast" }));

        await expect(await screen.findByRole("dialog", { name: "From outside React" })).toBeInTheDocument();
    },
};

export const Dark: Story = {
    decorators: [DarkTheme],
    render: (args) => (
        <ToastProvider {...args}>
            <ShowToast title="Changes saved" description="Your edits are now available on this device." />
        </ToastProvider>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));
        await userEvent.click(canvas.getByRole("button", { name: "Show toast" }));

        const toast = await screen.findByRole("dialog", { name: "Changes saved" });

        // Surface container high in the dark theme.
        await expect(getComputedStyle(toast).backgroundColor).toBe("rgb(32, 32, 32)");
    },
};
