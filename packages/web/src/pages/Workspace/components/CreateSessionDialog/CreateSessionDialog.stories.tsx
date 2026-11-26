import type { DirectoryListResponse, SessionSummary } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";

import { sid } from "@/storybook/ids";
import { Button } from "@components";

import {
    CreateSessionDialog,
    type CreateSessionDialogProps,
    type CreateSessionResult,
    type CreateSessionSubmitOptions,
} from "./CreateSessionDialog";

const createdSession: SessionSummary = {
    id: sid("session-created"),
    cwd: "/home/u/docs",
    name: null,
    firstMessage: "(no messages)",
    messageCount: 0,
    createdAtMs: 10_000,
    modifiedAtMs: 10_000,
    hasParent: false,
    runtimeState: "idle",
    attachedClients: 0,
};

const directoryTree: Readonly<Record<string, DirectoryListResponse>> = {
    "/home/u": {
        path: "/home/u",
        parent: "/home",
        directories: [".config", "docs", "notes", "pivia"],
        truncated: false,
    },
    "/home/u/pivia": {
        path: "/home/u/pivia",
        parent: "/home/u",
        directories: ["docs", "packages"],
        truncated: false,
    },
    "/home/u/pivia/packages": {
        path: "/home/u/pivia/packages",
        parent: "/home/u/pivia",
        directories: ["protocol", "server", "web"],
        truncated: false,
    },
    "/home/u/docs": {
        path: "/home/u/docs",
        parent: "/home/u",
        directories: [],
        truncated: false,
    },
};

const mockListDirectories = fn<(path?: string) => Promise<DirectoryListResponse>>((path) => {
    const key = path ?? "/home/u/pivia";
    return Promise.resolve(
        directoryTree[key] ?? {
            path: key,
            parent: "/home/u",
            directories: [],
            truncated: false,
        },
    );
});

function CreateSessionDemo(props: Omit<CreateSessionDialogProps, "open" | "onOpenChange">) {
    const [open, setOpen] = useState(true);

    return (
        <>
            <Button
                type="button"
                variant="secondary"
                onClick={() => {
                    setOpen(true);
                }}
            >
                New session
            </Button>
            <CreateSessionDialog {...props} open={open} onOpenChange={setOpen} />
        </>
    );
}

let pushCatalogUpdate: (() => void) | undefined;

function UpdatingCatalogDemo(props: CreateSessionDialogProps) {
    const [knownCwds, setKnownCwds] = useState(props.knownCwds);

    useEffect(() => {
        pushCatalogUpdate = () => {
            setKnownCwds((current) => ["/home/u/docs", ...current.filter((cwd) => cwd !== "/home/u/docs")]);
        };
        return () => {
            pushCatalogUpdate = undefined;
        };
    }, []);

    return <CreateSessionDemo {...props} knownCwds={knownCwds} />;
}

const truncatedListDirectories = fn<(path?: string) => Promise<DirectoryListResponse>>((path) => {
    const key = path ?? "/home/u/pivia";
    return Promise.resolve({
        path: key,
        parent: "/home/u",
        directories: ["docs", "packages"],
        truncated: true,
    });
});

const onCreateSuccess = fn<(cwd: string, options?: CreateSessionSubmitOptions) => Promise<CreateSessionResult>>(() =>
    Promise.resolve({ ok: true, session: createdSession }),
);

const onCreateFailure = fn<(cwd: string, options?: CreateSessionSubmitOptions) => Promise<CreateSessionResult>>(() =>
    Promise.resolve({ ok: false, code: "error", message: "Permission denied." }),
);

const onCreateMissingThenConfirm = fn<
    (cwd: string, options?: CreateSessionSubmitOptions) => Promise<CreateSessionResult>
>((_cwd, options) => {
    if (options?.createDirectory === true) {
        return Promise.resolve({ ok: true, session: createdSession });
    }
    return Promise.resolve({
        ok: false,
        code: "directory_not_found",
        message: "Directory does not exist.",
    });
});

const meta = {
    title: "Pages/Workspace/CreateSessionDialog",
    component: CreateSessionDialog,
    args: {
        open: true,
        onOpenChange: () => undefined,
        knownCwds: ["/home/u/pivia", "/home/u/docs", "/home/u/notes", "/home/u/ignored-fourth"],
        narrow: false,
        onListDirectories: mockListDirectories,
        onCreate: onCreateSuccess,
    },
    argTypes: {
        open: { control: false },
        onOpenChange: { control: false },
        onListDirectories: { control: false },
        onCreate: { control: false },
    },
    render: (args) => (
        <CreateSessionDemo
            knownCwds={args.knownCwds}
            narrow={args.narrow}
            onListDirectories={args.onListDirectories}
            onCreate={args.onCreate}
        />
    ),
} satisfies Meta<typeof CreateSessionDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ userEvent }) => {
        onCreateSuccess.mockClear();
        mockListDirectories.mockClear();

        const dialog = await within(document.body).findByRole("dialog", { name: "New session" });
        const input = within(dialog).getByLabelText("Working directory");
        await expect(input).toHaveValue("/home/u/pivia");

        // The directory browser is a page-level scroller, so it keeps the landmark.
        await expect(within(dialog).getByRole("region", { name: "Directories on server" })).toHaveAttribute(
            "data-slot",
            "scroll-area-viewport",
        );

        // At most 3 recent directories are shown even when more exist in the catalog.
        await expect(within(dialog).getByRole("button", { name: "/home/u/pivia" })).toBeVisible();
        await expect(within(dialog).getByRole("button", { name: "/home/u/docs" })).toBeVisible();
        await expect(within(dialog).getByRole("button", { name: "/home/u/notes" })).toBeVisible();
        await expect(within(dialog).queryByRole("button", { name: "/home/u/ignored-fourth" })).not.toBeInTheDocument();

        // Browse into a child directory, then step back up with `..`.
        const packagesButton = await within(dialog).findByRole("button", { name: "packages" });
        await userEvent.click(packagesButton);
        await expect(input).toHaveValue("/home/u/pivia/packages");
        await expect(await within(dialog).findByRole("button", { name: "web" })).toBeVisible();

        await userEvent.click(within(dialog).getByRole("button", { name: ".." }));
        await expect(input).toHaveValue("/home/u/pivia");

        // Clearing the input triggers client-side required validation without hitting the server.
        await userEvent.clear(input);
        await userEvent.click(within(dialog).getByRole("button", { name: "Create session" }));
        await expect(within(dialog).getByText("Enter a working directory path.")).toBeVisible();
        await expect(onCreateSuccess).not.toHaveBeenCalled();

        // Picking a recent directory fills the input and clears the previous error.
        await userEvent.click(within(dialog).getByRole("button", { name: "/home/u/docs" }));
        await expect(input).toHaveValue("/home/u/docs");

        await userEvent.click(within(dialog).getByRole("button", { name: "Create session" }));
        await expect(onCreateSuccess).toHaveBeenCalledWith("/home/u/docs", undefined);
        await waitFor(() => expect(within(document.body).queryByRole("dialog")).not.toBeInTheDocument());
    },
};

export const MissingDirectoryConfirm: Story = {
    args: {
        knownCwds: [],
        onCreate: onCreateMissingThenConfirm,
    },
    play: async ({ userEvent }) => {
        onCreateMissingThenConfirm.mockClear();

        const dialog = await within(document.body).findByRole("dialog", { name: "New session" });
        const input = within(dialog).getByLabelText("Working directory");
        await waitFor(() => expect(input).toHaveValue("/home/u/pivia"));

        await userEvent.clear(input);
        await userEvent.type(input, "/home/u/new-project");
        await userEvent.click(within(dialog).getByRole("button", { name: "Create session" }));

        await expect(onCreateMissingThenConfirm).toHaveBeenCalledWith("/home/u/new-project", undefined);

        const confirmDialog = await within(document.body).findByRole("alertdialog", { name: "Create directory?" });
        await waitFor(() => expect(within(confirmDialog).getByText("/home/u/new-project")).toBeVisible());

        await userEvent.click(within(confirmDialog).getByRole("button", { name: "Create & start" }));
        await expect(onCreateMissingThenConfirm).toHaveBeenLastCalledWith("/home/u/new-project", {
            createDirectory: true,
        });
        await waitFor(() => expect(within(document.body).queryByRole("dialog")).not.toBeInTheDocument());
    },
};

export const ServerError: Story = {
    args: {
        knownCwds: [],
        onCreate: onCreateFailure,
    },
    play: async ({ userEvent }) => {
        onCreateFailure.mockClear();

        const dialog = await within(document.body).findByRole("dialog", { name: "New session" });
        const input = within(dialog).getByLabelText("Working directory");
        await waitFor(() => expect(input).toHaveValue("/home/u/pivia"));

        await userEvent.clear(input);
        await userEvent.type(input, "/restricted/dir");
        await userEvent.click(within(dialog).getByRole("button", { name: "Create session" }));

        await expect(onCreateFailure).toHaveBeenCalledWith("/restricted/dir", undefined);
        await expect(await within(dialog).findByText("Permission denied.")).toBeVisible();
        await expect(input).toHaveAttribute("aria-invalid", "true");
    },
};

export const TruncatedDirectoryList: Story = {
    args: {
        onListDirectories: truncatedListDirectories,
    },
    play: async () => {
        const dialog = await within(document.body).findByRole("dialog", { name: "New session" });
        await expect(await within(dialog).findByText(/more directories than the browser shows/)).toBeVisible();
    },
};

export const CatalogUpdateKeepsBrowsing: Story = {
    args: {
        knownCwds: ["/home/u/pivia", "/home/u/docs"],
    },
    render: (args) => <UpdatingCatalogDemo {...args} />,
    play: async ({ userEvent }) => {
        const dialog = await within(document.body).findByRole("dialog", { name: "New session" });
        await userEvent.click(await within(dialog).findByRole("button", { name: "packages" }));
        await waitFor(() => expect(within(dialog).getByTitle("/home/u/pivia/packages")).toBeVisible());

        mockListDirectories.mockClear();
        pushCatalogUpdate?.();
        await new Promise((resolve) => setTimeout(resolve, 100));

        await expect(mockListDirectories).not.toHaveBeenCalled();
        await expect(within(dialog).getByTitle("/home/u/pivia/packages")).toBeVisible();
        await expect(within(dialog).getByRole("button", { name: "web" })).toBeVisible();
    },
};

export const BottomSheet: Story = {
    args: {
        narrow: true,
    },
    play: async ({ userEvent }) => {
        onCreateSuccess.mockClear();

        const sheet = await within(document.body).findByRole("dialog", { name: "New session" });
        await expect(sheet).toHaveAttribute("data-side", "bottom");
        await expect(within(sheet).getByRole("button", { name: "/home/u/pivia" })).toBeVisible();

        await userEvent.click(within(sheet).getByRole("button", { name: "Create session" }));
        await expect(onCreateSuccess).toHaveBeenCalledWith("/home/u/pivia", undefined);
        await waitFor(async () => {
            await expect(sheet).not.toBeVisible();
        });
    },
};
