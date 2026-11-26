import {
    Code,
    FilePen,
    FilePlus,
    FileText,
    FolderOpen,
    FolderSearch,
    Search,
    SearchCode,
    Terminal,
    Wrench,
    type LucideIcon,
} from "lucide-react";

import type { TranscriptToolKind } from "@/stores/session";

type ToolDisplay = {
    /** Display label; omitted for generic tools, which show the SDK tool name. */
    readonly label?: string | undefined;
    readonly icon: LucideIcon;
};

/** Maps Pi built-in tools to their transcript label and icon; extension tools share the Wrench. */
const TOOL_DISPLAY: Record<TranscriptToolKind, ToolDisplay> = {
    bash: { label: "Bash", icon: Terminal },
    powershell: { label: "PowerShell", icon: Terminal },
    read: { label: "Read", icon: FileText },
    write: { label: "Write", icon: FilePlus },
    edit: { label: "Edit", icon: FilePen },
    grep: { label: "Grep", icon: Search },
    find: { label: "Find", icon: FolderSearch },
    ls: { label: "Ls", icon: FolderOpen },
    codemode: { label: "Codemode", icon: Code },
    tool_search: { label: "Tool search", icon: SearchCode },
    generic: { icon: Wrench },
};

/**
 * Resolves the display label and icon for one tool call.
 *
 * @param kind - Built-in tool category, or `generic` for extension and MCP tools.
 * @param toolName - Raw SDK tool name, shown when no built-in label applies.
 */
export function toolDisplay(
    kind: TranscriptToolKind,
    toolName: string,
): { readonly label: string; readonly icon: LucideIcon } {
    const entry = TOOL_DISPLAY[kind];
    return { label: entry.label ?? toolName, icon: entry.icon };
}
