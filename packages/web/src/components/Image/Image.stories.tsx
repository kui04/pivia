import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { ImageViewer } from "../ImageViewer/ImageViewer";

import { imageAlt, imageCaption, imageSrc } from "./imageFixture";
import { Image } from "./Image";

const meta = {
    title: "Components/Image",
    component: Image,
    args: {
        src: imageSrc,
        alt: imageAlt,
    },
} satisfies Meta<typeof Image>;

export default meta;

type Story = StoryObj<typeof meta>;

function ImageWithViewer() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <Image src={imageSrc} alt={imageAlt} onOpen={() => setOpen(true)} />
            <ImageViewer open={open} onOpenChange={setOpen} src={imageSrc} alt={imageAlt} caption={imageCaption} />
        </>
    );
}

export const Default: Story = {
    render: () => <ImageWithViewer />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("button", { name: `View image: ${imageAlt}` });

        await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
        await userEvent.click(trigger);

        const dialog = await screen.findByRole("dialog", { name: "Image viewer" });

        await expect(within(dialog).getByRole("img", { name: imageAlt })).toBeInTheDocument();

        await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const Static: Story = {
    args: {
        src: imageSrc,
        alt: imageAlt,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const image = canvas.getByRole("img", { name: imageAlt });

        await expect(image.closest("button")).toBeNull();
        await expect(canvas.queryByRole("button")).toBeNull();
        await expect(Math.round(Number.parseFloat(getComputedStyle(image).borderRadius))).toBe(4);
    },
};
