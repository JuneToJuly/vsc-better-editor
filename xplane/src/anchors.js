const vscode = require("vscode");

function createAnchor(scope, editor) {
    if (scope === "project") {
        return {
            type: "project",
            relativePath: null,
            startLine: null,
            startCharacter: null,
            endLine: null,
            endCharacter: null,
            selectedText: "",
            startLineText: "",
            endLineText: ""
        };
    }

    if (!editor) {
        throw new Error(
            "A file editor is required for file or selection anchors."
        );
    }

    const relativePath = vscode.workspace.asRelativePath(
        editor.document.uri,
        false
    );

    if (scope === "file") {
        return {
            type: "file",
            relativePath,
            startLine: null,
            startCharacter: null,
            endLine: null,
            endCharacter: null,
            selectedText: "",
            startLineText: "",
            endLineText: ""
        };
    }

    if (editor.selection.isEmpty) {
        throw new Error(
            "An exact selection is required for a selection anchor."
        );
    }

    const selection = editor.selection;

    return {
        type: "selection",
        relativePath,
        startLine: selection.start.line,
        startCharacter: selection.start.character,
        endLine: selection.end.line,
        endCharacter: selection.end.character,
        selectedText: editor.document.getText(selection),
        startLineText: editor.document
            .lineAt(selection.start.line)
            .text
            .trim(),
        endLineText: editor.document
            .lineAt(selection.end.line)
            .text
            .trim()
    };
}

function resolveAnchorRange(item, document) {
    const anchor = item.anchor;

    if (anchor.type === "file") {
        return new vscode.Range(0, 0, 0, 0);
    }

    if (anchor.type !== "selection") {
        return null;
    }

    const originalRange = createSafeRange(anchor, document);

    if (
        originalRange &&
        anchor.selectedText &&
        document.getText(originalRange) === anchor.selectedText
    ) {
        return originalRange;
    }

    if (anchor.selectedText) {
        const fullText = document.getText();
        const indexes = findAllOccurrences(fullText, anchor.selectedText);

        if (indexes.length === 1) {
            const start = document.positionAt(indexes[0]);
            const end = document.positionAt(
                indexes[0] + anchor.selectedText.length
            );
            return new vscode.Range(start, end);
        }
    }

    return findRangeByBoundaryLines(anchor, document) || originalRange;
}

function createSafeRange(anchor, document) {
    if (
        !Number.isInteger(anchor.startLine) ||
        !Number.isInteger(anchor.endLine)
    ) {
        return null;
    }

    if (
        anchor.startLine < 0 ||
        anchor.endLine < 0 ||
        anchor.startLine >= document.lineCount ||
        anchor.endLine >= document.lineCount
    ) {
        return null;
    }

    const startLine = document.lineAt(anchor.startLine);
    const endLine = document.lineAt(anchor.endLine);

    return new vscode.Range(
        anchor.startLine,
        Math.min(
            Math.max(anchor.startCharacter ?? 0, 0),
            startLine.text.length
        ),
        anchor.endLine,
        Math.min(
            Math.max(anchor.endCharacter ?? endLine.text.length, 0),
            endLine.text.length
        )
    );
}

function findAllOccurrences(text, searchText) {
    const results = [];
    let index = text.indexOf(searchText);

    while (index !== -1) {
        results.push(index);
        index = text.indexOf(searchText, index + 1);
    }

    return results;
}

function findRangeByBoundaryLines(anchor, document) {
    if (!anchor.startLineText || !anchor.endLineText) {
        return null;
    }

    const startMatches = [];
    const endMatches = [];

    for (let index = 0; index < document.lineCount; index += 1) {
        const trimmed = document.lineAt(index).text.trim();

        if (trimmed === anchor.startLineText) {
            startMatches.push(index);
        }

        if (trimmed === anchor.endLineText) {
            endMatches.push(index);
        }
    }

    const candidates = [];

    for (const startLine of startMatches) {
        for (const endLine of endMatches) {
            if (endLine < startLine) {
                continue;
            }

            candidates.push(
                new vscode.Range(
                    startLine,
                    Math.min(
                        anchor.startCharacter ?? 0,
                        document.lineAt(startLine).text.length
                    ),
                    endLine,
                    Math.min(
                        anchor.endCharacter ??
                            document.lineAt(endLine).text.length,
                        document.lineAt(endLine).text.length
                    )
                )
            );
        }
    }

    return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {
    createAnchor,
    resolveAnchorRange
};
