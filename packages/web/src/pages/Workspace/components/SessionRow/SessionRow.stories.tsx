import { parseSessionId, type SessionId } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

import type { SessionRow as SessionRowModel } from "@/stores/workspace/model";

import { SessionRow } from "./SessionRow";
import styles from "./SessionRow.stories.module.css";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid story session id: ${raw}`);
    }
    return parsed;
}

const NOW = Date.parse("2026-01-03T12:00:00.000Z");

const session: SessionRowModel = {
    id: sid("session-a1"),
    title: "Fix the session list",
    named: true,
    cwd: "/home/u/pivia",
    modifiedAtMs: NOW - 2 * 60 * 60 * 1000,
    runtimeState: "idle",
    attachedClients: 0,
    pinned: false,
    selected: false,
};

const meta = {
    title: "Pages/Workspace/SessionRow",
    component: SessionRow,
    args: {
        session,
        nowMs: NOW,
        closing: false,
        onSelect: fn(),
        onTogglePinned: fn(),
        onCopySessionId: fn(),
        onCloseSession: fn(),
    },
    argTypes: {
        session: { control: false },
        onSelect: { control: false },
        onTogglePinned: { control: false },
        onCopySessionId: { control: false },
        onCloseSession: { control: false },
    },
    decorators: [
        (Story) => (
            <ul className={styles.list}>
                <Story />
            </ul>
        ),
    ],
} satisfies Meta<typeof SessionRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement, userEvent, args }) => {
        args.onSelect.mockClear();
        args.onTogglePinned.mockClear();
        const canvas = within(canvasElement);

        const rowButton = canvas.getByRole("button", { name: /Fix the session list/ });
        await expect(rowButton).toBeVisible();
        await expect(canvas.getByText("2h")).toBeVisible();

        const pinButton = canvas.getByRole("button", { name: "Pin session" });
        await expect(pinButton).toHaveAttribute("aria-pressed", "false");

        await userEvent.click(rowButton);
        await expect(args.onSelect).toHaveBeenCalledTimes(1);
        await expect(args.onSelect).toHaveBeenCalledWith(session.id);

        await userEvent.click(pinButton);
        await expect(args.onTogglePinned).toHaveBeenCalledTimes(1);
        await expect(args.onTogglePinned).toHaveBeenCalledWith(session.id);
    },
};

export const Selected: Story = {
    args: {
        session: { ...session, selected: true, pinned: true },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByRole("button", { name: /Fix the session list/ })).toHaveAttribute(
            "aria-current",
            "true",
        );
        await expect(canvas.getByRole("button", { name: "Unpin session" })).toHaveAttribute("aria-pressed", "true");
    },
};

export const StreamingRuntime: Story = {
    args: {
        session: { ...session, runtimeState: "streaming", attachedClients: 1 },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("Streaming")).toBeVisible();
        await expect(canvas.queryByText("2h")).not.toBeInTheDocument();
    },
};

export const MenuActions: Story = {
    play: async ({ canvasElement, userEvent, args }) => {
        args.onCopySessionId.mockClear();
        args.onCloseSession.mockClear();
        const canvas = within(canvasElement);

        // Synthetic pointer events do not trigger CSS :hover, so focus the row to reveal .actions.
        const rowButton = canvas.getByRole("button", { name: /Fix the session list/ });
        rowButton.focus();

        await userEvent.click(canvas.getByRole("button", { name: "Session actions" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Copy session ID" }));
        await expect(args.onCopySessionId).toHaveBeenCalledTimes(1);
        await expect(args.onCopySessionId).toHaveBeenCalledWith(session.id);

        rowButton.focus();
        await userEvent.click(canvas.getByRole("button", { name: "Session actions" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Close session" }));
        await expect(args.onCloseSession).toHaveBeenCalledTimes(1);
        await expect(args.onCloseSession).toHaveBeenCalledWith(session.id);
    },
};
