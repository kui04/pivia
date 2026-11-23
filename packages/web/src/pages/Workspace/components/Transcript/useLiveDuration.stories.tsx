import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactElement } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Button } from "@components";
import type { TranscriptTiming } from "@/stores/session/transcript";

import { useLiveDuration } from "./useLiveDuration";
import styles from "./useLiveDuration.stories.module.css";

// Module scope keeps the wall-clock read out of render. The windows below are wide enough for a
// slow test start and still catch a doubled or stale duration.
const TEN_MINUTES_AGO_MS = Date.now() - 10 * 60_000;
const ONE_HOUR_AGO_MS = Date.now() - 60 * 60_000;
const ONE_SECOND_AGO_MS = Date.now() - 1_000;

function DurationProbe({ timing }: { timing: TranscriptTiming }): ReactElement {
    const durationMs = useLiveDuration(timing, 100);
    return (
        <output className={styles.value} data-slot="duration-probe">
            {durationMs === null ? "pending" : `${durationMs} ms`}
        </output>
    );
}

function SwitchStartHarness(): ReactElement {
    const [startedAtMs, setStartedAtMs] = useState(ONE_HOUR_AGO_MS);

    return (
        <div className={styles.panel}>
            <Button type="button" variant="secondary" onClick={() => setStartedAtMs(ONE_SECOND_AGO_MS)}>
                Restart
            </Button>
            <DurationProbe timing={{ kind: "since", startedAtMs }} />
        </div>
    );
}

const meta = {
    title: "Pages/Workspace/Transcript/useLiveDuration",
    component: DurationProbe,
    args: {
        timing: { kind: "static", durationMs: 4_200 },
    },
    argTypes: {
        timing: { control: false },
    },
    decorators: [
        (Story) => (
            <div className={styles.frame}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof DurationProbe>;

export default meta;

type Story = StoryObj<typeof meta>;

export const StaticDuration: Story = {
    render: () => <DurationProbe timing={{ kind: "static", durationMs: 4_200 }} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText("4200 ms")).toBeVisible();
    },
};

export const RunningSamplesTheStartTime: Story = {
    render: () => <DurationProbe timing={{ kind: "since", startedAtMs: TEN_MINUTES_AGO_MS }} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        // The first wall-clock sample arrives on the next animation frame.
        const probe = await canvas.findByText(/^\d+ ms$/);

        await waitFor(async () => {
            const durationMs = Number.parseInt(probe.textContent ?? "", 10);
            // At least ten minutes passed, and the base must not be added on top of the start time.
            await expect(durationMs).toBeGreaterThanOrEqual(10 * 60_000);
            await expect(durationMs).toBeLessThan(15 * 60_000);
        });
    },
};

export const NewStartDiscardsTheOldSample: Story = {
    render: () => <SwitchStartHarness />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        // The first wall-clock sample arrives on the next animation frame.
        const probe = await canvas.findByText(/^\d+ ms$/);

        await waitFor(async () => {
            const durationMs = Number.parseInt(probe.textContent ?? "", 10);
            await expect(durationMs).toBeGreaterThanOrEqual(60 * 60_000);
        });

        await userEvent.click(canvas.getByRole("button", { name: "Restart" }));

        await waitFor(async () => {
            const durationMs = Number.parseInt(probe.textContent ?? "", 10);
            // A stale sample from the previous hour would keep the old value for one tick window.
            await expect(durationMs).toBeLessThan(60_000);
        });
    },
};
