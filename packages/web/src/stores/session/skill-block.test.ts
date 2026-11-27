import { parseSkillBlock as sdkParseSkillBlock } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { parseSkillBlock } from "./skill-block";

function skillBlock(name: string, location: string, body: string, prompt?: string): string {
    const block = `<skill name="${name}" location="${location}">\n${body}\n</skill>`;
    return prompt === undefined ? block : `${block}\n\n${prompt}`;
}

const LOCATION = "/skills/tydd/SKILL.md";

/**
 * Every input the transcript can hand the parser, with the expected parse.
 *
 * The browser cannot import the SDK parser (it pulls Node built-ins), so the web module mirrors it.
 * Each row also runs through the installed SDK, so a release that changes the block format fails
 * here instead of silently rendering skill bodies as user text.
 */
const CORPUS = [
    [
        skillBlock(
            "tydd",
            "/home/kui04/.pi/agent/skills/tydd/SKILL.md",
            "References are relative to /skills.\n\nAct.",
            "  Review this diff  ",
        ),
        {
            name: "tydd",
            location: "/home/kui04/.pi/agent/skills/tydd/SKILL.md",
            content: "References are relative to /skills.\n\nAct.",
            userMessage: "Review this diff",
        },
    ],
    [
        skillBlock("tydd", LOCATION, "Body"),
        { name: "tydd", location: LOCATION, content: "Body", userMessage: undefined },
    ],
    [
        skillBlock("tydd", LOCATION, "Body", "Review this diff"),
        { name: "tydd", location: LOCATION, content: "Body", userMessage: "Review this diff" },
    ],
    [
        skillBlock("tydd", LOCATION, "Line one\nLine two"),
        { name: "tydd", location: LOCATION, content: "Line one\nLine two", userMessage: undefined },
    ],
    [
        skillBlock("tydd", LOCATION, "Write the tag\n</skill>\ninside prose"),
        { name: "tydd", location: LOCATION, content: "Write the tag\n</skill>\ninside prose", userMessage: undefined },
    ],
    [skillBlock("tydd", LOCATION, ""), { name: "tydd", location: LOCATION, content: "", userMessage: undefined }],
    [
        skillBlock("tydd", LOCATION, "Body", "   "),
        { name: "tydd", location: LOCATION, content: "Body", userMessage: undefined },
    ],
    [
        skillBlock("tydd", LOCATION, "Body", "trailing\n\nparagraph"),
        { name: "tydd", location: LOCATION, content: "Body", userMessage: "trailing\n\nparagraph" },
    ],
    ["Explain the <skill> tag of a session file.", null],
    ['<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody', null],
    [`${skillBlock("tydd", LOCATION, "Body")} trailing`, null],
    [`  ${skillBlock("tydd", LOCATION, "Body")}`, null],
    ['<skill name="" location="/skills/x/SKILL.md">\nBody\n</skill>', null],
    ['<skill name="x" location="">\nBody\n</skill>', null],
] as const;

describe("parseSkillBlock", () => {
    it.each(CORPUS)("parses %#", (text, expected) => {
        expect(parseSkillBlock(text)).toEqual(expected);
    });

    describe("parity with the SDK", () => {
        it.each(CORPUS)("matches the sdk parser for %#", (text) => {
            expect(parseSkillBlock(text)).toEqual(sdkParseSkillBlock(text));
        });

        it("matches the block the terminal client expands a /skill command into", () => {
            const expanded = [
                '<skill name="tydd" location="/home/kui04/.pi/agent/skills/tydd/SKILL.md">',
                "References are relative to /home/kui04/.pi/agent/skills/tydd.",
                "",
                "# Type-Driven Development",
                "</skill>",
                "",
                "Review this diff",
            ].join("\n");

            expect(parseSkillBlock(expanded)).toEqual(sdkParseSkillBlock(expanded));
            expect(parseSkillBlock(expanded)?.userMessage).toBe("Review this diff");
        });
    });
});
