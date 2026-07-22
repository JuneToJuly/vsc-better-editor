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

    const commentsSection = buildCommentsSection(
        item.comments || []
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

        .comment-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .comment {
            overflow: visible;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            background: var(--vscode-editor-background);
        }

        .comment-header {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            min-height: 34px;
            padding: 7px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            border-radius: 6px 6px 0 0;
            background: var(--vscode-sideBarSectionHeader-background);
        }

        .comment-identity {
            display: flex;
            min-width: 0;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 5px;
        }

        .comment-author {
            color: var(--vscode-foreground);
            font-size: 11px;
            font-weight: 700;
        }

        .comment-event,
        .comment-time {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }

        .comment-time {
            text-decoration: underline;
            text-underline-offset: 2px;
        }

        .comment-menu {
            position: relative;
            flex: 0 0 auto;
        }

        .comment-menu-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 22px;
            padding: 0;
            color: var(--vscode-descriptionForeground);
            background: transparent;
            font-size: 16px;
            line-height: 1;
        }

        .comment-menu-button:hover,
        .comment-menu-button:focus {
            color: var(--vscode-foreground);
            background: var(--vscode-toolbar-hoverBackground);
        }

        .comment-menu-popover {
            position: absolute;
            top: calc(100% + 4px);
            right: 0;
            z-index: 20;
            min-width: 132px;
            padding: 4px;
            border: 1px solid var(--vscode-widget-border);
            border-radius: 4px;
            background: var(--vscode-menu-background);
            box-shadow: 0 4px 12px rgba(0, 0, 0, .25);
        }

        .comment-menu-popover[hidden] {
            display: none;
        }

        .comment-delete {
            display: block;
            width: 100%;
            padding: 6px 8px;
            border-radius: 3px;
            color: var(--vscode-menu-foreground);
            background: transparent;
            text-align: left;
            font-size: 11px;
        }

        .comment-delete:hover,
        .comment-delete:focus {
            color: var(--vscode-menu-selectionForeground);
            background: var(--vscode-menu-selectionBackground);
        }

        .comment-body {
            padding: 16px;
        }

        .comment-text {
            margin: 0;
            padding: 0;
            color: var(--vscode-foreground);
            font-size: 13px;
            line-height: 1.55;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
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
        <button id="addComment"><span>＋</span>Comment</button>
        <button id="toggleResolved"><span>✓</span>${item.status === "resolved" ? "Reopen" : "Resolve"}</button>
        <button id="rebind"><span>⇄</span>Move</button>
        <button id="deleteItem" class="danger"><span>⌫</span>Delete</button>
    </div>

    ${sourceSection}
    ${commentsSection}
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
    "addComment",
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
    const button of document.querySelectorAll(
        ".comment-menu-button"
    )
) {
    button.addEventListener("click", event => {
        event.stopPropagation();

        const menu = button.nextElementSibling;
        const willOpen = menu.hasAttribute("hidden");

        for (
            const otherMenu of document.querySelectorAll(
                ".comment-menu-popover"
            )
        ) {
            otherMenu.setAttribute("hidden", "");
        }

        for (
            const otherButton of document.querySelectorAll(
                ".comment-menu-button"
            )
        ) {
            otherButton.setAttribute(
                "aria-expanded",
                "false"
            );
        }

        if (willOpen) {
            menu.removeAttribute("hidden");
            button.setAttribute("aria-expanded", "true");
        }
    });
}

document.addEventListener("click", () => {
    for (
        const menu of document.querySelectorAll(
            ".comment-menu-popover"
        )
    ) {
        menu.setAttribute("hidden", "");
    }

    for (
        const button of document.querySelectorAll(
            ".comment-menu-button"
        )
    ) {
        button.setAttribute("aria-expanded", "false");
    }
});

for (
    const element of document.querySelectorAll(
        ".comment-delete"
    )
) {
    element.addEventListener("click", event => {
        event.stopPropagation();

        vscode.postMessage({
            command: "deleteComment",
            itemId,
            commentId: element.dataset.commentId
        });
    });
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

function buildCommentsSection(comments) {
    if (!comments.length) {
        return `
        <section class="section">
            <div class="section-title">Discussion</div>
            <div class="relationship-summary">
                No comments yet.
            </div>
        </section>`;
    }

    return `
    <section class="section">
        <div class="section-title">
            Discussion · ${comments.length}
        </div>

        <div class="comment-list">
            ${comments.map(comment => `
                <article class="comment">
                    <header class="comment-header">
                        <div class="comment-identity">
                            <span class="comment-author">
                                ${escapeHtml(comment.author || "Unknown")}
                            </span>

                            <span class="comment-event">
                                commented
                            </span>

                            <span class="comment-time">
                                ${escapeHtml(formatRelativeDate(comment.createdAt))}
                            </span>
                        </div>

                        <div class="comment-menu">
                            <button
                                class="comment-menu-button"
                                type="button"
                                title="Comment actions"
                                aria-label="Comment actions"
                                aria-expanded="false"
                            >
                                ⋯
                            </button>

                            <div class="comment-menu-popover" hidden>
                                <button
                                    class="comment-delete"
                                    data-comment-id="${escapeHtml(comment.id)}"
                                    type="button"
                                >
                                    Delete comment
                                </button>
                            </div>
                        </div>
                    </header>

                    <div class="comment-body">
                        <div class="comment-text">
                            ${escapeHtml(comment.text)}
                        </div>
                    </div>
                </article>
            `).join("")}
        </div>
    </section>`;
}

function formatRelativeDate(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const now = new Date();
    const seconds = Math.max(
        0,
        Math.floor((now.getTime() - date.getTime()) / 1000)
    );

    if (seconds < 45) {
        return "Just now";
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `${minutes} min ago`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return `${hours} hr ago`;
    }

    const days = Math.floor(hours / 24);

    if (days === 1) {
        return "Yesterday";
    }

    if (days < 7) {
        return `${days} days ago`;
    }

    return date.toLocaleDateString();
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
