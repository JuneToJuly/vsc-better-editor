const vscode = require("vscode");
const path = require("path");
const { escapeHtml } = require("./utils");

class ProjectHeatMapProvider {
    constructor(getItems, handlers) {
        this.getItems = getItems;
        this.handlers = handlers;
        this.view = undefined;
    }

    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.onDidReceiveMessage(
            async message => {
                if (message.command !== "openFile") {
                    return;
                }

                await this.handlers.openFile(
                    message.workspaceFolder,
                    message.relativePath
                );
            }
        );

        this.render();
    }

    render() {
        if (!this.view) {
            return;
        }

        const model = buildHeatMapModel(this.getItems());
        this.view.webview.html = buildHeatMapHtml(model);
    }
}

function buildHeatMapModel(items) {
    const files = new Map();

    for (const item of items) {
        if (
            !item.anchor ||
            item.anchor.type === "project" ||
            !item.anchor.relativePath
        ) {
            continue;
        }

        const key =
            `${item.workspaceFolder}::${item.anchor.relativePath}`;

        let entry = files.get(key);

        if (!entry) {
            entry = {
                workspaceFolder: item.workspaceFolder,
                relativePath: item.anchor.relativePath,
                fileName: path.basename(item.anchor.relativePath),
                count: 0,
                weightedScore: 0,
                activeCount: 0,
                resolvedCount: 0,
                types: {}
            };

            files.set(key, entry);
        }

        entry.count += 1;
        entry.weightedScore += entryWeight(item.type);

        if (item.status === "resolved") {
            entry.resolvedCount += 1;
        } else {
            entry.activeCount += 1;
        }

        entry.types[item.type] =
            (entry.types[item.type] || 0) + 1;
    }

    const entries = [...files.values()].sort(
        (left, right) =>
            right.weightedScore - left.weightedScore ||
            right.count - left.count ||
            left.relativePath.localeCompare(right.relativePath)
    );

    const maximumScore = Math.max(
        1,
        ...entries.map(entry => entry.weightedScore)
    );

    return {
        entries: entries.map(entry => ({
            ...entry,
            intensity: entry.weightedScore / maximumScore
        })),
        totalFiles: entries.length,
        totalItems: entries.reduce(
            (sum, entry) => sum + entry.count,
            0
        )
    };
}

function entryWeight(type) {
    const weights = {
        Documentation: 1,
        Comment: 1,
        Example: 1,
        Test: 1,
        Question: 2,
        TODO: 2,
        Design: 2,
        Decision: 3,
        Requirement: 3,
        Warning: 3
    };

    return weights[type] || 1;
}

function buildHeatMapHtml(model) {
    const nonce = Math.random().toString(36).slice(2);

    const rows = model.entries.length === 0
        ? `
        <div class="empty">
            Add file- or selection-level entry to populate
            the project heat map.
        </div>`
        : model.entries.map((entry, index) => {
            const width = Math.max(
                8,
                Math.round(entry.intensity * 100)
            );

            const typeSummary = Object.entries(entry.types)
                .sort((left, right) => right[1] - left[1])
                .slice(0, 3)
                .map(([type, count]) => `${type} ${count}`)
                .join(" · ");

            return `
            <button
                class="file-row"
                data-workspace="${escapeHtml(entry.workspaceFolder)}"
                data-path="${escapeHtml(entry.relativePath)}"
                title="${escapeHtml(entry.relativePath)}"
            >
                <div class="rank">${index + 1}</div>

                <div class="file-content">
                    <div class="file-heading">
                        <span class="file-name">
                            ${escapeHtml(entry.fileName)}
                        </span>
                        <span class="score">
                            ${entry.count} item${entry.count === 1 ? "" : "s"}
                        </span>
                    </div>

                    <div class="path">
                        ${escapeHtml(entry.relativePath)}
                    </div>

                    <div class="bar-track">
                        <div
                            class="bar"
                            style="width:${width}%"
                        ></div>
                    </div>

                    <div class="metadata">
                        <span>Weight ${entry.weightedScore}</span>
                        <span>${entry.activeCount} active</span>
                        ${
                            entry.resolvedCount > 0
                                ? `<span>${entry.resolvedCount} resolved</span>`
                                : ""
                        }
                    </div>

                    ${
                        typeSummary
                            ? `<div class="types">${escapeHtml(typeSummary)}</div>`
                            : ""
                    }
                </div>
            </button>`;
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
        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
        }

        .summary {
            display: flex;
            gap: 14px;
            padding: 10px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }

        .summary strong {
            color: var(--vscode-foreground);
        }

        .list {
            padding: 6px;
        }

        .file-row {
            display: flex;
            width: 100%;
            gap: 8px;
            padding: 9px 8px;
            border: 0;
            border-radius: 4px;
            color: var(--vscode-foreground);
            background: transparent;
            text-align: left;
            font: inherit;
            cursor: pointer;
        }

        .file-row:hover,
        .file-row:focus {
            outline: none;
            background: var(--vscode-list-hoverBackground);
        }

        .rank {
            flex: 0 0 20px;
            padding-top: 1px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            text-align: right;
        }

        .file-content {
            min-width: 0;
            flex: 1;
        }

        .file-heading {
            display: flex;
            justify-content: space-between;
            gap: 8px;
        }

        .file-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-weight: 600;
        }

        .score {
            flex: 0 0 auto;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }

        .path {
            margin-top: 2px;
            overflow: hidden;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
            font-size: 10px;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .bar-track {
            height: 6px;
            margin-top: 7px;
            overflow: hidden;
            border-radius: 999px;
            background: var(--vscode-progressBar-background);
            opacity: .35;
        }

        .bar {
            height: 100%;
            min-width: 4px;
            border-radius: 999px;
            background: var(--vscode-charts-orange);
            opacity: 1;
        }

        .metadata {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 5px;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }

        .types {
            margin-top: 3px;
            overflow: hidden;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .empty {
            padding: 24px 14px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="summary">
        <span><strong>${model.totalFiles}</strong> files</span>
        <span><strong>${model.totalItems}</strong> entrys</span>
    </div>

    <div class="list">
        ${rows}
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        for (const row of document.querySelectorAll(".file-row")) {
            row.addEventListener("click", () => {
                vscode.postMessage({
                    command: "openFile",
                    workspaceFolder: row.dataset.workspace,
                    relativePath: row.dataset.path
                });
            });
        }
    </script>
</body>
</html>`;
}

module.exports = {
    ProjectHeatMapProvider,
    buildHeatMapModel
};
