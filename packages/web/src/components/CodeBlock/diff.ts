export type LineVariant = "default" | "added" | "removed";

export type DisplayLine = {
    marker: string;
    content: string;
    variant: LineVariant;
};

function parseHunkHeader(text: string): { oldLines: number; newLines: number } | undefined {
    const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
    if (match === null) {
        return undefined;
    }

    return {
        oldLines: match[1] === undefined ? 1 : Number(match[1]),
        newLines: match[2] === undefined ? 1 : Number(match[2]),
    };
}

/**
 * A patch line starts with its sign, so the sign goes into its own column and the
 * code starts at the same x on every row. The hunk header's line counts close the
 * hunk, which keeps the next file's `---`/`+++` headers in a concatenated `diff -u`
 * from being read as removed and added code. CRLF input keeps its carriage returns
 * out of the rendered rows.
 */
export function parseDiffLines(lines: string[]): DisplayLine[] {
    let inHunk = false;
    let oldLines = 0;
    let newLines = 0;

    function closeHunkIfDone() {
        if (inHunk && oldLines <= 0 && newLines <= 0) {
            inHunk = false;
        }
    }

    return lines.map((line) => {
        const text = line.endsWith("\r") ? line.slice(0, -1) : line;
        const hunk = parseHunkHeader(text);

        if (text.startsWith("diff --git ")) {
            inHunk = false;
            return { marker: "", content: text, variant: "default" };
        }
        if (hunk !== undefined) {
            inHunk = true;
            oldLines = hunk.oldLines;
            newLines = hunk.newLines;
            closeHunkIfDone();
            return { marker: "", content: text, variant: "default" };
        }
        if (!inHunk && (text.startsWith("--- ") || text.startsWith("+++ "))) {
            return { marker: "", content: text, variant: "default" };
        }
        if (text.startsWith("+")) {
            newLines -= 1;
            closeHunkIfDone();
            return { marker: "+", content: text.slice(1), variant: "added" };
        }
        if (text.startsWith("-")) {
            oldLines -= 1;
            closeHunkIfDone();
            return { marker: "-", content: text.slice(1), variant: "removed" };
        }
        if (text.startsWith(" ")) {
            oldLines -= 1;
            newLines -= 1;
            closeHunkIfDone();
            return { marker: "", content: text.slice(1), variant: "default" };
        }
        return { marker: "", content: text, variant: "default" };
    });
}
