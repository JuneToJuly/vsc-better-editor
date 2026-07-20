const vscode = require("vscode");
const { escapeHtml, getAnchorFileName } = require("./utils");

class EntryExplorerProvider {
    constructor({
        getItems,
        getAllItems,
        getFilter,
        onSelect,
        onOpen,
        onPreview,
        onFocusDetails,
        onFilter,
        onSearch
    }) {
        this.getItems = getItems;
        this.getAllItems = getAllItems;
        this.getFilter = getFilter;
        this.onSelect = onSelect;
        this.onOpen = onOpen;
        this.onPreview = onPreview;
        this.onFocusDetails = onFocusDetails;
        this.onFilter = onFilter;
        this.onSearch = onSearch;
        this.view = undefined;
        this.selectedItemId = undefined;
    }

    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.onDidReceiveMessage(
            async message => {
                if (message.command === "filter") {
                    await this.onFilter();
                    return;
                }

                if (message.command === "search") {
                    await this.onSearch();
                    return;
                }

                const item = this.getItems().find(
                    candidate => candidate.id === message.itemId
                );

                if (!item) {
                    return;
                }

                // Store selection without rendering. The webview owns its
                // visual selection state while it has focus.
                this.selectedItemId = item.id;

                if (message.command === "select") {
                    await this.onSelect(item);
                } else if (message.command === "open") {
                    await this.onOpen(item);
                } else if (message.command === "preview") {
                    await this.onPreview(item);
                } else if (message.command === "focusDetails") {
                    await this.onFocusDetails(item);
                }
            }
        );

        this.render();
    }

    setSelected(item, options = {}) {
        this.selectedItemId = item?.id;

        if (
            options.notifyWebview &&
            this.view &&
            this.selectedItemId
        ) {
            this.view.webview.postMessage({
                command: "selectItem",
                itemId: this.selectedItemId,
                focus: Boolean(options.focus)
            });
        }
    }

    focusSelected() {
        if (!this.view) {
            return;
        }

        this.view.webview.postMessage({
            command: "focusSelected",
            itemId: this.selectedItemId
        });
    }

    render() {
        if (!this.view) {
            return;
        }

        this.view.webview.html = buildExplorerHtml({
            items: this.getItems(),
            allItems: this.getAllItems(),
            filter: this.getFilter(),
            selectedItemId: this.selectedItemId
        });
    }
}

function buildExplorerHtml({
    items,
    allItems,
    filter,
    selectedItemId
}) {
    const nonce = Math.random().toString(36).slice(2);
    const groups = groupByFile(items, allItems);

    const sections = groups.length === 0
        ? `
        <div class="empty">
            No entrys match the current filter.
        </div>`
        : groups.map(group => {
            const rows = group.items.map(entry => {
                const item = entry.item;
                const linkCount = Array.isArray(item.links)
                    ? item.links.length
                    : 0;

                return `
                <button
                    class="entry-row
                        ${item.id === selectedItemId ? "selected" : ""}
                        ${item.status === "resolved" ? "is-resolved" : ""}
                    "
                    data-id="${escapeHtml(item.id)}"
                    type="button"
                >
                    <span class="type">
                        ${escapeHtml(shortTypeLabel(item.type))}
                    </span>

                    <span class="text">
                        ${escapeHtml(item.text)}
                    </span>

                    <span class="meta">
                        ${
                            linkCount > 0
                                ? `<span
                                    class="link-count"
                                    title="${linkCount} linked item${linkCount === 1 ? "" : "s"}"
                                >↗ ${linkCount}</span>`
                                : ""
                        }

                        ${
                            item.status === "resolved"
                                ? `<span
                                    class="resolved-dot"
                                    title="Resolved"
                                ></span>`
                                : ""
                        }
                    </span>
                </button>`;
            }).join("");

            return `
                <section class="file-section">
                    <div class="file-header">
                        <span class="file-name">
                            ${escapeHtml(group.fileName)}
                        </span>
                        <span class="count">
                            ${group.items.length}
                        </span>
                    </div>
                    <div class="rows">${rows}</div>
                </section>
            `;
        }).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
    >
    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >
    <style nonce="${nonce}">
        * { box-sizing: border-box; }

        body {
            margin: 0;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
        }

        .filter {
            display: flex;
            justify-content: space-between;
            gap: 10px;
            padding: 7px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }

        .keys {
            flex: 0 0 auto;
            opacity: .8;
        }

        .file-section {
            padding: 7px 6px 2px;
        }

        .file-header {
            display: flex;
            align-items: center;
            gap: 7px;
            padding: 5px 6px 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .file-name {
            min-width: 0;
            flex: 1;
            overflow: hidden;
            font-weight: 650;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .count {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }

        .rows { padding-top: 2px; }

        .entry-row {
            display: grid;
            grid-template-columns: 58px minmax(0, 1fr) auto;
            align-items: center;
            width: 100%;
            gap: 8px;
            min-height: 30px;
            padding: 5px 8px;
            border: 0;
            border-radius: 4px;
            color: var(--vscode-foreground);
            background: transparent;
            text-align: left;
            font: inherit;
            cursor: default;
        }

        .entry-row:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .entry-row:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        .entry-row.selected {
            color: var(--vscode-list-activeSelectionForeground);
            background: var(--vscode-list-activeSelectionBackground);
        }

        .entry-row.is-resolved:not(.selected) {
            color: var(--vscode-descriptionForeground);
        }

        .entry-row.is-resolved:not(.selected) .text {
            opacity: .72;
        }

        .entry-row.is-resolved:not(.selected) .type {
            opacity: .62;
        }

        .type {
            color: var(--vscode-textLink-foreground);
            font-size: 10px;
            font-weight: 700;
            letter-spacing: .06em;
            line-height: 1;
        }

        .text {
            min-width: 0;
            overflow: hidden;
            font-size: 13px;
            line-height: 1.35;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .meta {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            min-width: 0;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }

        .link-count {
            opacity: .78;
        }

        .resolved-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: var(--vscode-testing-iconPassed);
            opacity: .8;
        }

        .empty {
            padding: 24px 14px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            line-height: 1.5;
        }
    </style>
</head>
<body tabindex="0">
    <div class="filter">
        <span>
            Filter: ${escapeHtml(filterLabel(filter))}
            · ${items.length} item${items.length === 1 ? "" : "s"}
        </span>
        <span class="keys">f filter · / search</span>
    </div>

    ${sections}

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const rows = [...document.querySelectorAll(".entry-row")];
        let currentIndex = rows.findIndex(
            row => row.classList.contains("selected")
        );

        function applySelection(index, options = {}) {
            if (rows.length === 0) {
                return;
            }

            currentIndex = Math.max(
                0,
                Math.min(index, rows.length - 1)
            );

            for (const row of rows) {
                row.classList.remove("selected");
            }

            const row = rows[currentIndex];
            row.classList.add("selected");
            row.scrollIntoView({ block: "nearest" });

            if (options.focus) {
                row.focus({ preventScroll: true });
            }

            if (options.notify !== false) {
                vscode.postMessage({
                    command: "select",
                    itemId: row.dataset.id
                });
            }
        }

        function selectedRow() {
            return currentIndex >= 0 ? rows[currentIndex] : null;
        }

        function postForSelected(command) {
            const row = selectedRow();

            if (!row) {
                return;
            }

            vscode.postMessage({
                command,
                itemId: row.dataset.id
            });
        }

        for (const [index, row] of rows.entries()) {
            row.addEventListener("click", () => {
                applySelection(index, {
                    focus: true,
                    notify: true
                });
            });

            row.addEventListener("dblclick", () => {
                applySelection(index, {
                    focus: false,
                    notify: false
                });
                postForSelected("open");
            });
        }

        window.addEventListener("message", event => {
            if (event.data?.command === "selectItem") {
                const index = rows.findIndex(
                    row => row.dataset.id === event.data.itemId
                );

                if (index >= 0) {
                    applySelection(index, {
                        focus: Boolean(event.data.focus),
                        notify: false
                    });
                }

                return;
            }

            if (event.data?.command === "focusSelected") {
                let index = rows.findIndex(
                    row => row.dataset.id === event.data.itemId
                );

                if (index < 0) {
                    index = currentIndex >= 0 ? currentIndex : 0;
                }

                if (rows.length > 0) {
                    applySelection(index, {
                        focus: true,
                        notify: false
                    });
                }
            }
        });

        document.addEventListener("keydown", event => {
            if (event.key === "j") {
                event.preventDefault();
                applySelection(
                    currentIndex < 0 ? 0 : currentIndex + 1,
                    { focus: true, notify: true }
                );
                return;
            }

            if (event.key === "k") {
                event.preventDefault();
                applySelection(
                    currentIndex < 0 ? 0 : currentIndex - 1,
                    { focus: true, notify: true }
                );
                return;
            }

            if (event.key === "f") {
                event.preventDefault();
                vscode.postMessage({ command: "filter" });
                return;
            }

            if (event.key === "/") {
                event.preventDefault();
                vscode.postMessage({ command: "search" });
                return;
            }

            if (event.key === "o") {
                event.preventDefault();
                postForSelected("focusDetails");
                return;
            }

            if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                postForSelected("preview");
                return;
            }

            if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                postForSelected("open");
            }
        });

        // Establish one selection without notifying the extension.
        if (currentIndex < 0 && rows.length > 0) {
            applySelection(0, {
                focus: false,
                notify: false
            });
        }
    </script>
</body>
</html>`;
}

function groupByFile(items) {
    const groups = new Map();

    for (const item of items) {
        const key = item.anchor?.relativePath || "Project";

        if (!groups.has(key)) {
            groups.set(key, {
                fileName: getAnchorFileName(item),
                items: []
            });
        }

        groups.get(key).items.push(item);
    }

    return [...groups.values()]
        .sort((left, right) =>
            left.fileName.localeCompare(right.fileName)
        )
        .map(group => ({
            ...group,
            items: group.items
                .sort(
                    (left, right) =>
                        new Date(right.updatedAt) -
                        new Date(left.updatedAt)
                )
                .map(item => ({
                    item,
                    depth: 0
                }))
        }));
}

function shortTypeLabel(type) {
    const labels = {
        Documentation: "DOC",
        Comment: "COMMENT",
        Question: "QUESTION",
        Decision: "DECISION",
        Requirement: "REQ",
        TODO: "TODO",
        Warning: "WARN",
        Design: "DESIGN",
        Example: "EXAMPLE",
        Test: "TEST"
    };

    return labels[type] || String(type).toUpperCase();
}

function filterLabel(filter) {
    if (filter.startsWith("type:")) {
        return filter.slice("type:".length);
    }

    const labels = {
        active: "Active",
        all: "All",
        resolved: "Resolved",
        currentFile: "Current File",
        currentSelection: "Current Selection"
    };

    return labels[filter] || filter;
}

module.exports = {
    EntryExplorerProvider
};
