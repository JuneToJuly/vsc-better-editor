const vscode = require("vscode");
const path = require("path");

function truncate(value, maximumLength) {
    return value.length <= maximumLength
        ? value
        : `${value.slice(0, maximumLength - 1)}…`;
}

function escapeMarkdown(value) {
    return String(value).replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function getAnchorLabel(item) {
    const anchor = item.anchor;

    if (anchor.type === "project") {
        return "Project";
    }

    if (anchor.type === "file") {
        return anchor.relativePath;
    }

    const startLine = (anchor.startLine ?? 0) + 1;
    const startCharacter = (anchor.startCharacter ?? 0) + 1;
    const endLine = (anchor.endLine ?? 0) + 1;
    const endCharacter = (anchor.endCharacter ?? 0) + 1;

    if (startLine === endLine) {
        return `${anchor.relativePath}:${startLine}:${startCharacter}-${endCharacter}`;
    }

    return `${anchor.relativePath}:${startLine}:${startCharacter}-${endLine}:${endCharacter}`;
}

function getAnchorFileName(item) {
    if (
        !item.anchor ||
        item.anchor.type === "project" ||
        !item.anchor.relativePath
    ) {
        return "Project";
    }

    return path.basename(item.anchor.relativePath);
}

function findWorkspaceFolder(name) {
    return (vscode.workspace.workspaceFolders || []).find(
        folder => folder.name === name
    );
}

function rangesOverlap(left, right) {
    return left.start.isBeforeOrEqual(right.end) &&
        right.start.isBeforeOrEqual(left.end);
}

module.exports = {
    truncate,
    escapeMarkdown,
    escapeHtml,
    getAnchorLabel,
    getAnchorFileName,
    findWorkspaceFolder,
    rangesOverlap
};
