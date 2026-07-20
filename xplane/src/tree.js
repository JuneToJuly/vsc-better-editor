const vscode = require("vscode");
const path = require("path");
const { getAnchorFileName, getAnchorLabel } = require("./utils");
const { resolveAnchorRange } = require("./anchors");

class EntryProvider {
    constructor() {
        this.items = [];
        this.filter = "active";
        this.changeEmitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.changeEmitter.event;
    }

    async reload(storage) {
        const items = [];

        for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
            items.push(...await storage.readItems(workspaceFolder));
        }

        this.items = items.sort(
            (left, right) =>
                new Date(right.updatedAt) - new Date(left.updatedAt)
        );

        this.changeEmitter.fire(undefined);
    }

    setFilter(filter) {
        this.filter = filter;
        this.changeEmitter.fire(undefined);
    }

    getAllItems() {
        return [...this.items];
    }

    getDescendants(itemId) {
        const descendants = [];
        const queue = [itemId];

        while (queue.length > 0) {
            const currentId = queue.shift();
            const children = this.items.filter(
                item => item.parentId === currentId
            );

            descendants.push(...children);
            queue.push(...children.map(child => child.id));
        }

        return descendants;
    }

    getTreeItem(element) {
        return element;
    }

    getChildren() {
        return [];
    }

    getFilteredItems() {
        if (this.filter === "resolved") {
            return this.items.filter(item => item.status === "resolved");
        }

        if (this.filter === "all") {
            return [...this.items];
        }

        if (this.filter.startsWith("type:")) {
            const type = this.filter.slice("type:".length);
            return this.items.filter(item => item.type === type);
        }

        if (
            this.filter === "currentFile" ||
            this.filter === "currentSelection"
        ) {
            const editor = vscode.window.activeTextEditor;

            if (!editor) {
                return [];
            }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(
                editor.document.uri
            );

            if (!workspaceFolder) {
                return [];
            }

            const relativePath = vscode.workspace.asRelativePath(
                editor.document.uri,
                false
            );

            const currentFileItems = this.items.filter(item =>
                item.workspaceFolder === workspaceFolder.name &&
                item.anchor.relativePath === relativePath
            );

            if (this.filter === "currentFile") {
                return currentFileItems;
            }

            if (editor.selection.isEmpty) {
                return [];
            }

            return currentFileItems.filter(item => {
                if (item.anchor.type !== "selection") {
                    return false;
                }

                const range = resolveAnchorRange(item, editor.document);

                return range
                    ? range.intersection(editor.selection) !== undefined
                    : false;
            });
        }

        return this.items.filter(item => item.status === "active");
    }
}

class FileGroupTreeItem extends vscode.TreeItem {
    constructor(groupKey, fileName, relativePath, count) {
        super(
            fileName,
            vscode.TreeItemCollapsibleState.Expanded
        );

        this.groupKey = groupKey;
        this.contextValue = "xPlaneFileGroup";
        this.description = `${count} item${count === 1 ? "" : "s"}`;
        this.tooltip = relativePath;
        this.iconPath = new vscode.ThemeIcon("file-code");
    }
}

class EntryTreeItem extends vscode.TreeItem {
    constructor(item, visibleItems) {
        const children = visibleItems.filter(
            candidate => candidate.parentId === item.id
        );

        super(
            item.text,
            children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.item = item;

        const anchorContext = item.anchor.type === "project"
            ? "Project"
            : item.anchor.type === "file"
                ? "File"
                : "Selection";

        const statusContext = item.status === "resolved"
            ? "Resolved"
            : "Active";

        this.contextValue =
            `xPlane${statusContext}${anchorContext}Item`;

        const resolvedChildren = children.filter(
            child => child.status === "resolved"
        ).length;

        const progress = children.length > 0
            ? `${resolvedChildren}/${children.length}`
            : "";

        this.description = buildEntryMetadata(
            item,
            progress
        );

        this.tooltip = buildTreeTooltip(item, children);
        this.iconPath = new vscode.ThemeIcon(
            item.status === "resolved"
                ? "pass-filled"
                : iconForEntryType(item.type)
        );

        this.accessibilityInformation = {
            label:
                `${item.type}. ${item.text}. ` +
                `${getAnchorFileName(item)}.`
        };
    }
}

function buildEntryMetadata(item, progress) {
    const parts = [];

    if (progress) {
        parts.push(progress);
    }

    parts.push(shortTypeLabel(item.type));

    const grouping = vscode.workspace
        .getConfiguration("xPlane")
        .get("groupByFile", true);

    if (!grouping) {
        parts.push(getAnchorFileName(item));
    }

    return parts.join(" · ");
}

function shortTypeLabel(type) {
    const labels = {
        Documentation: "DOC",
        Comment: "COMMENT",
        Question: "QUESTION",
        Decision: "DECISION",
        Requirement: "REQUIREMENT",
        TODO: "TODO",
        Warning: "WARNING",
        Design: "DESIGN",
        Example: "EXAMPLE",
        Test: "TEST"
    };

    return labels[type] || String(type).toUpperCase();
}

function buildFileGroups(items) {
    const groups = new Map();

    for (const item of items) {
        const key = fileGroupKey(item);

        if (!groups.has(key)) {
            groups.set(key, {
                key,
                fileName: getAnchorFileName(item),
                relativePath:
                    item.anchor?.relativePath || "Project",
                count: 0
            });
        }

        groups.get(key).count += 1;
    }

    return [...groups.values()]
        .sort((left, right) =>
            left.fileName.localeCompare(right.fileName)
        )
        .map(group =>
            new FileGroupTreeItem(
                group.key,
                group.fileName,
                group.relativePath,
                group.count
            )
        );
}

function fileGroupKey(item) {
    if (
        !item.anchor ||
        item.anchor.type === "project" ||
        !item.anchor.relativePath
    ) {
        return `${item.workspaceFolder}::Project`;
    }

    return `${item.workspaceFolder}::${item.anchor.relativePath}`;
}


function iconForEntryType(type) {
    const icons = {
        Documentation: "book",
        Comment: "comment",
        Question: "question",
        Decision: "law",
        Requirement: "checklist",
        TODO: "tasklist",
        Warning: "warning",
        Design: "symbol-structure",
        Example: "beaker",
        Test: "testing-view-icon"
    };

    return icons[type] || "note";
}

module.exports = {
    EntryProvider,
    EntryTreeItem
};
