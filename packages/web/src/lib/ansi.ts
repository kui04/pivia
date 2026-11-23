/*
 * Portions of this pattern derive from ansi-regex and strip-ansi (MIT). It is the same grammar the
 * Pi terminal client uses, so both clients drop the same sequences from captured command output.
 */
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const OSC_START = "\\u001B\\]";
const CSI_START = "(?:(?:\\u001B\\[|\\u009B)[<=>]|[\\u001B\\u009B][[\\]()#;?]*)(?:\\d{1,4}(?:[;:]\\d{0,4})*)?";
const CSI_FINAL = "[\\dA-PR-TZcf-nq-uy=><~]";

const ANSI_SEQUENCE = new RegExp(`(?:${OSC_START}[\\s\\S]*?${ST})|${CSI_START}${CSI_FINAL}`, "g");

/**
 * A sequence the writer never finished at the end of the captured output.
 *
 * Truncation can cut a sequence at any byte. Without this pass a lone trailing ESC survives, and
 * the CSI rule would consume printable text after an unterminated OSC introducer.
 */
const UNFINISHED_ANSI_SUFFIX = new RegExp(
    `(?:${OSC_START}(?:[^\\u0007\\u009C\\u001B]|\\u001B(?!\\\\))*|${CSI_START})$`,
);

/**
 * Remove terminal control sequences from captured command output.
 *
 * The grammar covers CSI (colors, cursor movement, erases), OSC (window titles and hyperlinks) and
 * the two-byte escapes. A sequence cut off at the end is dropped whole, so no escape bytes reach
 * the view and no printable text after an unterminated introducer is lost.
 *
 * @param raw - Output exactly as the session recorded it.
 * @returns The printable text.
 */
export function stripAnsi(raw: string): string {
    // Escape sequences need an ESC (7-bit) or CSI (8-bit) introducer; plain text returns as is.
    if (!raw.includes("\u001B") && !raw.includes("\u009B")) {
        return raw;
    }
    return raw.replace(UNFINISHED_ANSI_SUFFIX, "").replace(ANSI_SEQUENCE, "");
}
