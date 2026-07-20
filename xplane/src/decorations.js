const vscode = require("vscode");
const { ENTRY_TYPES } = require("./constants");
const { resolveAnchorRange } = require("./anchors");
const { escapeMarkdown } = require("./utils");

const HEAT_LEVELS = 4;

class EntryDecorations {
    constructor() {
        this.typeDecorations = new Map();
        this.heatMapDecorations = [];
    }

    recreate(context) {
        this.dispose();

        const configuration = vscode.workspace.getConfiguration(
            "xPlane"
        );

        for (const type of ENTRY_TYPES) {
            const color = configuration.get(
                `colors.${type.toLowerCase()}`,
                defaultColorForType(type)
            );

            const markerUri = createMarkerDataUri(color);

            const anchorDecoration =
                vscode.window.createTextEditorDecorationType({
                    isWholeLine: false,
                    borderWidth: "0 0 1px 0",
                    borderStyle: "solid",
                    borderColor: color,
                    overviewRulerColor: color,
                    overviewRulerLane: vscode.OverviewRulerLane.Right
                });

            const markerDecoration =
                vscode.window.createTextEditorDecorationType({
                    isWholeLine: false,
                    gutterIconPath: markerUri,
                    gutterIconSize: "12px",
                    overviewRulerColor: color,
                    overviewRulerLane: vscode.OverviewRulerLane.Right
                });

            this.typeDecorations.set(type, {
                anchorDecoration,
                markerDecoration
            });

            context.subscriptions.push(
                anchorDecoration,
                markerDecoration
            );
        }

        const heatMapColor = configuration.get(
            "heatMap.color",
            "#ff9d00"
        );

        for (let level = 1; level <= HEAT_LEVELS; level += 1) {
            const opacity = heatOpacity(level);
            const color = withAlpha(heatMapColor, opacity);

            const decoration =
                vscode.window.createTextEditorDecorationType({
                    isWholeLine: true,
                    overviewRulerColor: color,
                    overviewRulerLane: vscode.OverviewRulerLane.Full
                });

            this.heatMapDecorations.push(decoration);
            context.subscriptions.push(decoration);
        }
    }

    clear(editor) {
        for (const decoration of this.typeDecorations.values()) {
            editor.setDecorations(decoration.anchorDecoration, []);
            editor.setDecorations(decoration.markerDecoration, []);
        }

        for (const decoration of this.heatMapDecorations) {
            editor.setDecorations(decoration, []);
        }
    }

    update(editor, items) {
        this.clear(editor);

        const configuration = vscode.workspace.getConfiguration(
            "xPlane"
        );

        const showLines = configuration.get("showAnchorLines", true);
        const showMarkers = configuration.get("showGutterMarkers", true);
        const showHeatMap = configuration.get("showHeatMap", true);

        const byType = new Map(
            ENTRY_TYPES.map(type => [
                type,
                { anchors: [], markers: [] }
            ])
        );

        for (const item of items) {
            const bucket = byType.get(item.type);

            if (!bucket) {
                continue;
            }

            const hoverMessage = buildHoverMessage(item);

            if (item.anchor.type === "selection") {
                const range = resolveAnchorRange(item, editor.document);

                if (!range) {
                    continue;
                }

                if (showLines) {
                    bucket.anchors.push({ range, hoverMessage });
                }

                if (showMarkers) {
                    bucket.markers.push({
                        range: new vscode.Range(
                            range.start.line,
                            0,
                            range.start.line,
                            0
                        ),
                        hoverMessage
                    });
                }
            } else if (
                item.anchor.type === "file" &&
                showMarkers
            ) {
                bucket.markers.push({
                    range: new vscode.Range(0, 0, 0, 0),
                    hoverMessage
                });
            }
        }

        for (const [type, values] of byType) {
            const decoration = this.typeDecorations.get(type);

            if (!decoration) {
                continue;
            }

            editor.setDecorations(
                decoration.anchorDecoration,
                values.anchors
            );

            editor.setDecorations(
                decoration.markerDecoration,
                values.markers
            );
        }

        if (showHeatMap) {
            this.renderHeatMap(editor, items);
        }
    }

    renderHeatMap(editor, items) {
        const scores = new Array(editor.document.lineCount).fill(0);
        const configuration = vscode.workspace.getConfiguration(
            "xPlane"
        );

        const useTypeWeights = configuration.get(
            "heatMap.useTypeWeights",
            true
        );

        for (const item of items) {
            if (item.anchor.type === "file") {
                scores[0] += entryWeight(item.type, useTypeWeights);
                continue;
            }

            if (item.anchor.type !== "selection") {
                continue;
            }

            const range = resolveAnchorRange(item, editor.document);

            if (!range) {
                continue;
            }

            const weight = entryWeight(
                item.type,
                useTypeWeights
            );

            for (
                let line = range.start.line;
                line <= range.end.line;
                line += 1
            ) {
                scores[line] += weight;
            }
        }

        const maximum = Math.max(...scores);

        if (maximum <= 0) {
            return;
        }

        const rangesByLevel = Array.from(
            { length: HEAT_LEVELS },
            () => []
        );

        for (let line = 0; line < scores.length; line += 1) {
            const score = scores[line];

            if (score <= 0) {
                continue;
            }

            const level = heatLevel(score, maximum);
            const range = editor.document.lineAt(line).range;

            rangesByLevel[level - 1].push({
                range,
                hoverMessage: new vscode.MarkdownString(
                    `**Entry density:** ${score}`
                )
            });
        }

        for (let index = 0; index < HEAT_LEVELS; index += 1) {
            editor.setDecorations(
                this.heatMapDecorations[index],
                rangesByLevel[index]
            );
        }
    }

    dispose() {
        for (const decoration of this.typeDecorations.values()) {
            decoration.anchorDecoration.dispose();
            decoration.markerDecoration.dispose();
        }

        for (const decoration of this.heatMapDecorations) {
            decoration.dispose();
        }

        this.typeDecorations.clear();
        this.heatMapDecorations = [];
    }
}

function heatLevel(score, maximum) {
    if (maximum <= 1) {
        return 1;
    }

    const normalized = score / maximum;

    if (normalized <= 0.25) {
        return 1;
    }

    if (normalized <= 0.5) {
        return 2;
    }

    if (normalized <= 0.75) {
        return 3;
    }

    return 4;
}

function entryWeight(type, useTypeWeights) {
    if (!useTypeWeights) {
        return 1;
    }

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

function heatOpacity(level) {
    const opacities = {
        1: "55",
        2: "88",
        3: "bb",
        4: "ff"
    };

    return opacities[level] || "55";
}

function withAlpha(color, alpha) {
    const normalized = String(color || "").trim();

    if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
        return `${normalized}${alpha}`;
    }

    if (/^#[0-9a-fA-F]{8}$/.test(normalized)) {
        return `${normalized.slice(0, 7)}${alpha}`;
    }

    return `#ff9d00${alpha}`;
}

function buildHoverMessage(item) {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;

    markdown.appendMarkdown(
        `**${escapeMarkdown(item.type)}**\n\n`
    );
    markdown.appendMarkdown(
        `${escapeMarkdown(item.text)}\n\n`
    );

    const args = encodeURIComponent(JSON.stringify([item.id]));

    markdown.appendMarkdown(
        `[Open Entry]` +
        `(command:xPlane.viewItem?${args})`
    );

    return markdown;
}

function createMarkerDataUri(color) {
    const safeColor = normalizeCssColor(color);

    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg"
             width="12"
             height="12"
             viewBox="0 0 12 12">
            <circle cx="6" cy="6" r="4.25"
                    fill="${safeColor}"
                    stroke="${safeColor}"
                    stroke-width="1.5"/>
            <circle cx="6" cy="6" r="1.35"
                    fill="#1e1e1e"/>
        </svg>
    `;

    return vscode.Uri.parse(
        `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    );
}

function normalizeCssColor(value) {
    const color = String(value || "").trim();

    if (
        /^#[0-9a-fA-F]{3,8}$/.test(color) ||
        /^rgb(a)?\(/.test(color) ||
        /^hsl(a)?\(/.test(color)
    ) {
        return color;
    }

    return "#75beff";
}

function defaultColorForType(type) {
    const colors = {
        Documentation: "#75beff",
        Comment: "#b5cea8",
        Question: "#c586c0",
        Decision: "#dcdcaa",
        Requirement: "#4ec9b0",
        TODO: "#ce9178",
        Warning: "#f48771",
        Design: "#569cd6",
        Example: "#9cdcfe",
        Test: "#c8c8c8"
    };

    return colors[type] || "#75beff";
}

module.exports = { EntryDecorations };
