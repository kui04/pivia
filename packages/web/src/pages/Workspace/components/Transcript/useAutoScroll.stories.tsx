import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactElement } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Button } from "@components";
import storyFrame from "@/storybook/storyFrame.module.css";

import { useAutoScroll } from "./useAutoScroll";
import styles from "./useAutoScroll.stories.module.css";

const LINES = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the probe content.`);

function AutoScrollProbe(): ReactElement {
    const [generation, setGeneration] = useState(0);
    const { viewportRef, atBottom } = useAutoScroll({ enabled: true, initialBottom: true });

    return (
        <div className={styles.panel}>
            <Button type="button" variant="secondary" onClick={() => setGeneration((value) => value + 1)}>
                Remount viewport
            </Button>
            <div
                key={generation}
                ref={viewportRef}
                role="region"
                aria-label="Probe scroll region"
                tabIndex={0}
                className={styles.viewport}
                data-slot="probe-viewport"
            >
                {LINES.map((line) => (
                    <p key={line} className={styles.line}>
                        {line}
                    </p>
                ))}
            </div>
            <output className={styles.value}>{atBottom ? "At bottom" : "Scrolled up"}</output>
        </div>
    );
}

const meta = {
    title: "Pages/Workspace/Transcript/useAutoScroll",
    component: AutoScrollProbe,
    decorators: [
        (Story) => (
            <div className={storyFrame.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof AutoScrollProbe>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NewViewportStartsAtTheBottom: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await waitFor(async () => {
            const viewport = canvasElement.querySelector<HTMLElement>("[data-slot='probe-viewport']");
            await expect(viewport).not.toBeNull();
            await expect(viewport?.scrollTop ?? 0).toBeGreaterThan(0);
            await expect(canvas.getByText("At bottom")).toBeVisible();
        });

        await userEvent.click(canvas.getByRole("button", { name: "Remount viewport" }));

        await waitFor(async () => {
            const viewport = canvasElement.querySelector<HTMLElement>("[data-slot='probe-viewport']");
            await expect(viewport).not.toBeNull();
            const remaining =
                (viewport?.scrollHeight ?? 0) - (viewport?.clientHeight ?? 0) - (viewport?.scrollTop ?? 0);
            await expect(remaining).toBeLessThanOrEqual(2);
            await expect(canvas.getByText("At bottom")).toBeVisible();
        });
    },
};
