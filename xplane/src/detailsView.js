const vscode = require("vscode");
const { escapeHtml, getAnchorLabel } = require("./utils");

class EntryDetailsProvider {
    constructor(getItemById, getAllItems, handlers) {
        this.getItemById = getItemById;
        this.getAllItems = getAllItems;
        this.handlers = handlers;
        this.view = undefined;
        this.currentItemId = undefined;
    }

    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        webviewView.webview.onDidReceiveMessage(
            async message => {
                const item = this.getItemById(message.itemId);

                if (!item) {
                    return;
                }

                const handler = this.handlers[message.command];

                if (handler) {
                    await handler(item, message);
                }
            }
        );

        this.render();
    }

    showItem(item) {
        this.currentItemId = item.id;
        this.render();
    }

    clear() {
        this.currentItemId = undefined;
        this.render();
    }

    render() {
        if (!this.view) {
            return;
        }

        const item = this.getItemById(this.currentItemId);

        const allItems = this.getAllItems();

        const outgoingItems = item
            ? (item.links || [])
                .map(linkId => this.getItemById(linkId))
                .filter(Boolean)
            : [];

        const incomingItems = item
            ? allItems.filter(candidate =>
                candidate.id !== item.id &&
                Array.isArray(candidate.links) &&
                candidate.links.includes(item.id)
            )
            : [];

        this.view.webview.html = item
            ? buildDetailsHtml(
                item,
                outgoingItems,
                incomingItems
            )
            : buildEmptyHtml();
    }
}

function buildEmptyHtml() {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body {
    margin: 0;
    padding: 20px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-sideBar-background);
    font-family: var(--vscode-font-family);
}
.empty {
    display: flex;
    min-height: 180px;
    align-items: center;
    justify-content: center;
    text-align: center;
    line-height: 1.5;
}
</style>
</head>
<body>
<div class="empty">
    Select a entry above to view its details.
</div>
</body>
</html>`;
}

function buildDetailsHtml(
    item,
    outgoingItems = [],
    incomingItems = []
) {
    const nonce = Math.random().toString(36).slice(2);
    const selectedText = item.anchor.type === "selection"
        ? escapeHtml(item.anchor.selectedText || "")
        : "";

    const sourceSection = item.anchor.type === "selection"
        ? `
        <section class="section">
            <div class="section-title">Referenced code</div>
            <pre>${selectedText}</pre>
        </section>`
        : "";

    const locationSection = item.anchor.type !== "project"
        ? `
        <section class="location">
            <div class="location-copy">
                <div class="location-file">
                    ${escapeHtml(
                        item.anchor.relativePath
                            ? item.anchor.relativePath.split("/").pop()
                            : "Project"
                    )}
                </div>
                <div class="location-path">
                    ${escapeHtml(getAnchorLabel(item))}
                </div>
            </div>
            <button id="openAnchor" class="open-button">Open</button>
        </section>`
        : "";

    const outgoingSection = buildRelationshipSection(
        "References",
        "Entry referenced by this item",
        outgoingItems,
        "outgoing"
    );

    const incomingSection = buildRelationshipSection(
        "Referenced By",
        "Entry that points to this item",
        incomingItems,
        "incoming"
    );

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
>
<style nonce="${nonce}">
        * { box-sizing: border-box; }

        body {
            margin: 0;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
        }

        .details { padding: 16px; }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
        }

        .type {
            color: var(--vscode-textLink-foreground);
            font-size: 11px;
            font-weight: 700;
            letter-spacing: .09em;
            text-transform: uppercase;
        }

        .status {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }

        .status-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: ${item.status === "resolved"
                ? "var(--vscode-testing-iconPassed)"
                : "var(--vscode-textLink-foreground)"};
        }

        .entry {
            padding: 14px 15px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-editor-background);
            font-size: 15px;
            line-height: 1.55;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .location {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 14px;
            margin-top: 14px;
            padding: 12px 0;
            border-top: 1px solid var(--vscode-panel-border);
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .location-copy { min-width: 0; }

        .location-file {
            overflow: hidden;
            font-size: 12px;
            font-weight: 600;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .location-path {
            margin-top: 3px;
            overflow: hidden;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
            font-size: 10px;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin: 12px 0 16px;
        }

        button {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 5px 8px;
            border: 1px solid transparent;
            border-radius: 3px;
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
            font: inherit;
            font-size: 11px;
            cursor: pointer;
        }

        button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        button.primary {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }

        button.danger {
            color: var(--vscode-errorForeground);
            background: transparent;
            border-color: color-mix(
                in srgb,
                var(--vscode-errorForeground) 45%,
                transparent
            );
        }

        button.danger:hover {
            color: var(--vscode-button-foreground);
            background: var(--vscode-errorForeground);
        }

        .section { margin-top: 16px; }

        .section-title {
            margin-bottom: 4px;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            font-weight: 700;
            letter-spacing: .08em;
            text-transform: uppercase;
        }

        .relationship-summary {
            margin-bottom: 8px;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }

        .relationship-list {
            display: flex;
            flex-direction: column;
            gap: 7px;
        }

        .relationship-item {
            display: grid;
            grid-template-columns: 1fr;
            gap: 4px;
            width: 100%;
            padding: 9px 10px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 5px;
            background: var(--vscode-editor-background);
            text-align: left;
        }

        .relationship-item:hover {
            border-color: var(--vscode-focusBorder);
            background: var(--vscode-list-hoverBackground);
        }

        .relationship-type {
            color: var(--vscode-textLink-foreground);
            font-size: 9px;
            font-weight: 700;
            letter-spacing: .07em;
            text-transform: uppercase;
        }

        .relationship-text {
            overflow: hidden;
            color: var(--vscode-foreground);
            font-size: 12px;
            line-height: 1.35;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .relationship-file {
            overflow: hidden;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
            font-size: 9px;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        pre {
            margin: 0;
            padding: 10px;
            max-height: 220px;
            overflow: auto;
            border-radius: 4px;
            background: var(--vscode-textCodeBlock-background);
            font-family: var(--vscode-editor-font-family);
            line-height: 1.45;
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
<main class="details">
    <div class="header">
        <div class="type">${escapeHtml(item.type)}</div>

        <div class="status">
            <span class="status-dot"></span>
            ${escapeHtml(
                item.status === "resolved"
                    ? "Resolved"
                    : "Active"
            )}
        </div>
    </div>

    <div class="entry">${escapeHtml(item.text)}</div>

    ${locationSection}

    <div class="actions">
        <button id="edit" class="primary"><span>✎</span>Edit</button>
        <button id="changeType"><span>⌁</span>Type</button>
        <button id="linkItem"><span>↗</span>Link</button>
        <button id="toggleResolved"><span>✓</span>${item.status === "resolved" ? "Reopen" : "Resolve"}</button>
        <button id="rebind"><span>⇄</span>Move</button>
        <button id="deleteItem" class="danger"><span>⌫</span>Delete</button>
    </div>

    ${sourceSection}
    ${outgoingSection}
    ${incomingSection}
</main>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const itemId = ${JSON.stringify(item.id)};

for (const command of [
    "openAnchor",
    "edit",
    "changeType",
    "toggleResolved",
    "rebind",
    "linkItem",
    "deleteItem"
]) {
    const element = document.getElementById(command);

    if (element) {
        element.addEventListener("click", () => {
            vscode.postMessage({ command, itemId });
        });
    }
}

for (
    const element of document.querySelectorAll(
        ".relationship-item"
    )
) {
    element.addEventListener("click", () => {
        vscode.postMessage({
            command: "openLinked",
            itemId,
            linkedItemId: element.dataset.linkedId
        });
    });
}
</script>
</body>
</html>`;
}

function buildRelationshipSection(
    title,
    summary,
    items,
    direction
) {
    if (items.length === 0) {
        return `
        <section class="section">
            <div class="section-title">${escapeHtml(title)}</div>
            <div class="relationship-summary">
                ${escapeHtml(summary)}
            </div>
            <div class="relationship-summary">None</div>
        </section>`;
    }

    return `
    <section class="section">
        <div class="section-title">
            ${escapeHtml(title)} · ${items.length}
        </div>

        <div class="relationship-summary">
            ${escapeHtml(summary)}
        </div>

        <div class="relationship-list">
            ${items.map(linked => `
                <button
                    class="relationship-item"
                    data-linked-id="${escapeHtml(linked.id)}"
                    data-direction="${escapeHtml(direction)}"
                    type="button"
                >
                    <span class="relationship-type">
                        ${escapeHtml(linked.type)}
                    </span>

                    <span class="relationship-text">
                        ${escapeHtml(linked.text)}
                    </span>

                    <span class="relationship-file">
                        ${escapeHtml(
                            linked.anchor?.relativePath || "Project"
                        )}
                    </span>
                </button>
            `).join("")}
        </div>
    </section>`;
}


module.exports = { EntryDetailsProvider };
