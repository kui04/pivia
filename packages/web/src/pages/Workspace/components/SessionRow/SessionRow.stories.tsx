import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

import { makeStorySessionRow, STORY_NOW } from "@/storybook/fixtures";
import { sid } from "@/storybook/ids";
import type { SessionRow as SessionRowModel } from "@/stores/workspace";

import { requireElement } from "@/storybook/dom";
import { SessionRow } from "./SessionRow";
import styles from "./SessionRow.stories.module.css";

const session: SessionRowModel = makeStorySessionRow("session-a1", "Fix the session list");

const meta = {
    title: "Pages/Workspace/SessionRow",
    component: SessionRow,
    args: {
        session,
        nowMs: STORY_NOW,
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

export const RuntimeStates: Story = {
    render: (args) => (
        <>
            <SessionRow
                {...args}
                session={{
                    ...args.session,
                    id: sid("session-stream"),
                    runtimeState: "streaming",
                    attachedClients: 1,
                }}
            />
            <SessionRow {...args} session={{ ...args.session, id: sid("session-attached"), attachedClients: 1 }} />
            <SessionRow {...args} session={{ ...args.session, id: sid("session-closing"), runtimeState: "closing" }} />
        </>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        for (const label of ["Streaming", "Attached", "Closing"]) {
            const dot = canvas.getByRole("img", { name: label });
            await expect(dot).toBeVisible();
            const row = requireElement(dot.closest("li"), "row");
            const menu = within(row).getByRole("button", { name: "Session actions" });
            const dotBox = dot.getBoundingClientRect();
            const menuBox = menu.getBoundingClientRect();
            const dotCenter = dotBox.left + dotBox.width / 2;
            const menuCenter = menuBox.left + menuBox.width / 2;
            await expect(Math.abs(dotCenter - menuCenter)).toBeLessThan(1);
        }
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
