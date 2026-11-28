import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type { ExtensionDialogRequest } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

import { ExtensionUiDialog } from "./ExtensionUiDialog";

const onReply = fn<(reply: RpcExtensionUIResponse) => void>();
const onMinimize = fn();

const selectRequest: ExtensionDialogRequest = {
    type: "extension_ui_request",
    id: "req-select",
    method: "select",
    title: "Choose a branch",
    options: ["main", "dev"],
};

const confirmRequest: ExtensionDialogRequest = {
    type: "extension_ui_request",
    id: "req-confirm",
    method: "confirm",
    title: "Continue?",
    message: "This resumes the turn.",
};

const inputRequest: ExtensionDialogRequest = {
    type: "extension_ui_request",
    id: "req-input",
    method: "input",
    title: "Name this session",
    placeholder: "a short name",
};

const editorRequest: ExtensionDialogRequest = {
    type: "extension_ui_request",
    id: "req-editor",
    method: "editor",
    title: "Edit the summary",
    prefill: "first",
};

const meta = {
    title: "Pages/Workspace/ExtensionUiDialog",
    component: ExtensionUiDialog,
    args: {
        request: selectRequest,
        pending: false,
        error: null,
        remainingSeconds: null,
        onReply,
        onMinimize,
    },
} satisfies Meta<typeof ExtensionUiDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Select: Story = {
    args: { request: selectRequest, remainingSeconds: 5 },
    play: async ({ userEvent }) => {
        onReply.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Choose a branch" });
        const confirm = within(dialog).getByRole("button", { name: "Confirm" });

        await expect(within(dialog).getByText("Closes in 5s.")).toBeVisible();
        await expect(confirm).toBeDisabled();

        await userEvent.click(within(dialog).getByRole("radio", { name: "dev" }));
        await userEvent.click(confirm);

        await expect(onReply).toHaveBeenCalledWith({
            type: "extension_ui_response",
            id: "req-select",
            value: "dev",
        });
    },
};

export const SelectWithoutOptions: Story = {
    args: { request: { ...selectRequest, id: "req-empty", options: [] } },
    play: async ({ userEvent }) => {
        onReply.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Choose a branch" });

        await expect(within(dialog).getByText("This extension provided no options.")).toBeVisible();
        await expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await expect(onReply).toHaveBeenCalledWith({
            type: "extension_ui_response",
            id: "req-empty",
            cancelled: true,
        });
    },
};

export const Confirm: Story = {
    args: { request: confirmRequest },
    play: async ({ userEvent }) => {
        onReply.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Continue?" });

        await expect(within(dialog).getByText("This resumes the turn.")).toBeVisible();
        await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
        await expect(onReply).toHaveBeenCalledWith({
            type: "extension_ui_response",
            id: "req-confirm",
            confirmed: true,
        });
    },
};

export const ConfirmCancel: Story = {
    args: { request: { ...confirmRequest, id: "req-confirm-cancel" } },
    play: async ({ userEvent }) => {
        onReply.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Continue?" });

        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await expect(onReply).toHaveBeenCalledWith({
            type: "extension_ui_response",
            id: "req-confirm-cancel",
            cancelled: true,
        });
    },
};

export const Input: Story = {
    args: { request: inputRequest },
    play: async ({ userEvent }) => {
        onReply.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Name this session" });
        const field = within(dialog).getByRole("textbox", { name: "Your answer" });

        await userEvent.type(field, "weekly review");
        await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
        await expect(onReply).toHaveBeenCalledWith({
            type: "extension_ui_response",
            id: "req-input",
            value: "weekly review",
        });
    },
};

export const InputEmpty: Story = {
    args: { request: { ...inputRequest, id: "req-input-empty" } },
    play: async ({ userEvent }) => {
        onReply.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Name this session" });

        await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
        await expect(onReply).toHaveBeenCalledWith({
            type: "extension_ui_response",
            id: "req-input-empty",
            value: "",
        });
    },
};

export const Editor: Story = {
    args: { request: editorRequest },
    play: async ({ userEvent }) => {
        onReply.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Edit the summary" });
        const editor = within(dialog).getByRole("textbox", { name: "Editor content" });

        await expect(editor).toHaveValue("first");
        await userEvent.click(editor);
        await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
        await expect(editor).toHaveValue("first\n");

        await userEvent.keyboard("{Enter}");
        await expect(onReply).toHaveBeenCalledWith({
            type: "extension_ui_response",
            id: "req-editor",
            value: "first\n",
        });
    },
};

export const Pending: Story = {
    args: { request: { ...selectRequest, id: "req-pending" }, pending: true, error: "The connection closed." },
    play: async ({ userEvent }) => {
        onReply.mockClear();
        onMinimize.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Choose a branch" });

        await expect(within(dialog).getByRole("alert")).toHaveTextContent("The connection closed.");
        await expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
        await expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
        await expect(within(dialog).getByRole("button", { name: "Minimize prompt" })).toBeEnabled();

        await userEvent.keyboard("{Escape}");
        await expect(within(document.body).getByRole("dialog", { name: "Choose a branch" })).toBeInTheDocument();
        await expect(onReply).not.toHaveBeenCalled();

        await userEvent.click(within(dialog).getByRole("button", { name: "Minimize prompt" }));
        await expect(onMinimize).toHaveBeenCalledTimes(1);
    },
};

export const Minimize: Story = {
    args: { request: { ...confirmRequest, id: "req-minimize" } },
    play: async ({ userEvent }) => {
        onMinimize.mockClear();
        const dialog = await within(document.body).findByRole("dialog", { name: "Continue?" });

        await userEvent.click(within(dialog).getByRole("button", { name: "Minimize prompt" }));
        await expect(onMinimize).toHaveBeenCalledTimes(1);
    },
};
