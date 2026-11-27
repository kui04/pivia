import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

import { sid } from "@/storybook/ids";
import type { SelectedSession } from "@/stores/workspace";

import { Topbar } from "./Topbar";
import styles from "./Topbar.stories.module.css";

const session: SelectedSession = {
    id: sid("session-a1"),
    title: "Fix the session list",
    named: true,
    cwd: "/home/u/pivia",
    runtimeState: "idle",
    attachedClients: 0,
};

const meta = {
    title: "Pages/Workspace/Topbar",
    component: Topbar,
    args: {
        session,
        sidebarOpen: true,
        closing: false,
        runtimeReady: true,
        onToggleSidebar: fn(),
        onCopySessionId: fn(),
        onDetachSession: fn(),
        onRenameSession: fn(),
        onCompactSession: fn(),
        onClosePane: fn(),
    },
    argTypes: {
        session: { control: false },
        onToggleSidebar: { control: false },
        onCopySessionId: { control: false },
        onDetachSession: { control: false },
        onRenameSession: { control: false },
        onCompactSession: { control: false },
        onClosePane: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof Topbar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    args: {
        session: null,
        sidebarOpen: false,
    },
    play: async ({ canvasElement, userEvent, args }) => {
        args.onToggleSidebar.mockClear();
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("heading", { level: 1, name: "No session selected" })).toBeVisible();
        await expect(canvas.queryByRole("button", { name: "Session actions" })).not.toBeInTheDocument();

        const toggle = canvas.getByRole("button", { name: "Show sessions" });
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await userEvent.click(toggle);
        await expect(args.onToggleSidebar).toHaveBeenCalledTimes(1);
    },
};

export const SelectedSessionStory: Story = {
    name: "Selected Session",
    play: async ({ canvasElement, userEvent, args }) => {
        args.onToggleSidebar.mockClear();
        args.onCopySessionId.mockClear();
        args.onDetachSession.mockClear();
        args.onRenameSession?.mockClear();
        args.onCompactSession?.mockClear();
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("button", { name: "Hide sessions" })).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByRole("heading", { level: 1, name: "Fix the session list" })).toBeVisible();
        await expect(canvas.queryByRole("button", { name: /Close pane/ })).not.toBeInTheDocument();

        await userEvent.click(canvas.getByRole("button", { name: "Session actions" }));
        await expect(within(document.body).queryByRole("menuitem", { name: "Split right" })).not.toBeInTheDocument();
        await expect(within(document.body).queryByRole("menuitem", { name: "Close session" })).not.toBeInTheDocument();
        await expect(within(document.body).queryByRole("menuitem", { name: "Close pane" })).not.toBeInTheDocument();
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Copy session ID" }));
        await expect(args.onCopySessionId).toHaveBeenCalledWith(session.id);

        await userEvent.click(canvas.getByRole("button", { name: "Session actions" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Rename session" }));
        await expect(args.onRenameSession).toHaveBeenCalledWith(session);

        await userEvent.click(canvas.getByRole("button", { name: "Session actions" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Compact context" }));
        await expect(args.onCompactSession).toHaveBeenCalledWith(session.id);

        await userEvent.click(canvas.getByRole("button", { name: "Session actions" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Detach session" }));
        await expect(args.onDetachSession).toHaveBeenCalledWith(session.id);
    },
};

export const MultiPane: Story = {
    args: {
        paneCount: 2,
    },
    play: async ({ canvasElement, userEvent, args }) => {
        args.onClosePane?.mockClear();
        const canvas = within(canvasElement);

        await userEvent.click(canvas.getByRole("button", { name: "Session actions (Fix the session list)" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Close pane" }));
        await expect(args.onClosePane).toHaveBeenCalledTimes(1);
    },
};
