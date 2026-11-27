import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { DarkTheme } from "@/storybook/theme";

import { requireElement } from "@/storybook/dom";
import { ImageViewer } from "./ImageViewer";
import { imageAlt, imageCaption, imageSrc } from "../Image/imageFixture";

const brokenImage = "data:image/png;base64,not-an-image";

const meta = {
    title: "Components/ImageViewer",
    component: ImageViewer,
    args: {
        open: false,
        onOpenChange: () => {},
        src: imageSrc,
        alt: imageAlt,
        caption: imageCaption,
    },
} satisfies Meta<typeof ImageViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

function ViewerHarness({ defaultOpen = false, src = imageSrc }: { defaultOpen?: boolean; src?: string }) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Open image
            </button>
            <ImageViewer open={open} onOpenChange={setOpen} src={src} alt={imageAlt} caption={imageCaption} />
        </>
    );
}

export const Default: Story = {
    render: () => <ViewerHarness />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: "Open image" });

        await userEvent.click(trigger);

        const dialog = await screen.findByRole("dialog", { name: "Image viewer" });
        const image = within(dialog).getByRole("img", { name: imageAlt });

        await waitFor(() => expect(image).toHaveAttribute("data-status", "loaded"), { timeout: 5000 });

        const caption = requireElement(dialog.querySelector("[data-slot='image-viewer-caption']"), "caption");
        await expect(caption).toHaveTextContent(imageCaption);

        const zoom = requireElement(dialog.querySelector("[data-slot='image-viewer-zoom']"), "zoom");

        await expect(zoom).toHaveTextContent("100%");

        await userEvent.click(within(dialog).getByRole("button", { name: "Zoom in" }));
        await waitFor(() => expect(Number.parseInt(zoom.textContent, 10)).toBeGreaterThan(100));

        await userEvent.click(within(dialog).getByRole("button", { name: "Reset zoom" }));
        await waitFor(() => expect(zoom).toHaveTextContent("100%"));

        await userEvent.click(within(dialog).getByRole("button", { name: "Zoom in" }));
        await waitFor(() => expect(Number.parseInt(zoom.textContent, 10)).toBeGreaterThan(100));

        await userEvent.click(within(dialog).getByRole("button", { name: "Zoom out" }));
        await waitFor(() => expect(zoom).toHaveTextContent("100%"));

        await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const Dark: Story = {
    decorators: [DarkTheme],
    render: () => <ViewerHarness defaultOpen />,
    play: async () => {
        await screen.findByRole("dialog", { name: "Image viewer" });

        const backdrop = requireElement(document.querySelector("[data-slot='image-viewer-backdrop']"), "backdrop");

        await expect(getComputedStyle(backdrop).backgroundColor).toBe("rgba(0, 0, 0, 0.85)");
    },
};

export const Broken: Story = {
    render: () => <ViewerHarness defaultOpen src={brokenImage} />,
    play: async () => {
        const dialog = await screen.findByRole("dialog", { name: "Image viewer" });
        const alert = await screen.findByRole("alert");

        await expect(alert).toHaveTextContent("Image could not be loaded.");
        await expect(within(dialog).queryByRole("button", { name: "Zoom in" })).toBeNull();

        await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    },
};
