const vscode = require("vscode");
const crypto = require("crypto");
const path = require("path");
const { ENTRY_TYPES } = require("./constants");
const { createAnchor, resolveAnchorRange } = require("./anchors");
const {
    findWorkspaceFolder,
    getAnchorFileName,
    getAnchorLabel
} = require("./utils");

class EntryCommands {
    constructor({
        provider,
        storage,
        decorations,
        details,
        explorer,
        refresh
    }) {
        this.provider = provider;
        this.storage = storage;
        this.decorations = decorations;
        this.details = details;
        this.explorer = explorer;
        this.refresh = refresh;
        this.selectedItemId = undefined;
    }

    setSelected(item, options = {}) {
        this.selectedItemId = item?.id;

        if (item) {
            this.details.showItem(item);

            if (options.notifyExplorer) {
                this.explorer?.setSelected(item, {
                    notifyWebview: true,
                    focus: Boolean(options.focusExplorer)
                });
            } else {
                this.explorer?.setSelected(item);
            }
        }
    }

    getSelected() {
        return this.provider.getAllItems().find(
            item => item.id === this.selectedItemId
        );
    }

    async addItem(parentItem = null) {
        const editor = vscode.window.activeTextEditor;
        const workspaceFolder = editor
            ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
            : await chooseWorkspaceFolder();

        if (!workspaceFolder) {
            vscode.window.showWarningMessage(
                "Open a workspace folder before creating a entry."
            );
            return;
        }

        const type = await chooseEntryType();

        if (!type) {
            return;
        }

        const text = await promptForEntryText(type);

        if (!text) {
            return;
        }

        const scope = await chooseAnchorScope(editor);

        if (!scope) {
            return;
        }

        const parentId = parentItem
            ? parentItem.id
            : await chooseParentItem(
                workspaceFolder,
                this.storage
            );

        if (parentId === undefined) {
            return;
        }

        const now = new Date().toISOString();

        const item = {
            id: crypto.randomUUID(),
            parentId,
            type,
            text: text.trim(),
            status: "active",
            createdAt: now,
            updatedAt: now,
            resolvedAt: null,
            links: [],
            comments: [],
            workspaceFolder: workspaceFolder.name,
            anchor: createAnchor(scope, editor)
        };

        await this.storage.addItem(workspaceFolder, item);
        await this.refresh();
        this.setSelected(item);
    }

    async edit(item) {
        const text = await vscode.window.showInputBox({
            title: `Edit ${item.type}`,
            prompt: "Update the entry text",
            value: item.text,
            validateInput: validateEntryText,
            ignoreFocusOut: true
        });

        if (!text) {
            return;
        }

        item.text = text.trim();
        item.updatedAt = new Date().toISOString();

        await this.save(item);
    }

    async changeType(item) {
        const type = await chooseEntryType(item.type);

        if (!type) {
            return;
        }

        item.type = type;
        item.updatedAt = new Date().toISOString();

        await this.save(item);
    }

    async toggleResolved(item) {
        item.status = item.status === "resolved"
            ? "active"
            : "resolved";

        item.resolvedAt = item.status === "resolved"
            ? new Date().toISOString()
            : null;

        item.updatedAt = new Date().toISOString();

        await this.save(item);
    }

    async rebind(item) {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            vscode.window.showWarningMessage(
                "Open a file before moving this entry."
            );
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            editor.document.uri
        );

        if (!workspaceFolder) {
            return;
        }

        const scope = await chooseAnchorScope(editor);

        if (!scope) {
            return;
        }

        item.workspaceFolder = workspaceFolder.name;
        item.anchor = createAnchor(scope, editor);
        item.updatedAt = new Date().toISOString();

        await this.storage.upsertItem(workspaceFolder, item);
        await this.refresh();
        this.setSelected(item);
    }

    async delete(item) {
        const descendants = this.provider.getDescendants(item.id);

        const answer = await vscode.window.showWarningMessage(
            descendants.length === 0
                ? `Delete "${item.text}"?`
                : `Delete "${item.text}" and ${descendants.length} child item(s)?`,
            { modal: true },
            "Delete"
        );

        if (answer !== "Delete") {
            return;
        }

        const workspaceFolder = findWorkspaceFolder(item.workspaceFolder);

        if (!workspaceFolder) {
            return;
        }

        await this.storage.deleteItems(
            workspaceFolder,
            [item.id, ...descendants.map(child => child.id)]
        );

        this.selectedItemId = undefined;
        this.details.clear();
        await this.refresh();
    }

    async openAnchor(
        item,
        {
            preserveFocus = false,
            selectRange = true
        } = {}
    ) {
        if (!item || item.anchor.type === "project") {
            return;
        }

        const workspaceFolder = findWorkspaceFolder(item.workspaceFolder);

        if (!workspaceFolder) {
            return;
        }

        const uri = vscode.Uri.joinPath(
            workspaceFolder.uri,
            item.anchor.relativePath
        );

        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus,
            preview: true
        });

        const range = resolveAnchorRange(item, document);

        if (!range) {
            vscode.window.showWarningMessage(
                "The saved entry location could not be found."
            );
            return;
        }

        if (selectRange) {
            editor.selection = new vscode.Selection(
                range.start,
                range.end
            );
        } else {
            // Place the caret at the anchor without selecting its text.
            editor.selection = new vscode.Selection(
                range.start,
                range.start
            );
        }

        editor.revealRange(
            range,
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
    }

    async focusExplorer() {
        await vscode.commands.executeCommand(
            "xPlane.items.focus"
        );

        this.explorer?.focusSelected();
    }

    async focusDetails() {
        const item = this.getSelected();

        if (item) {
            this.details.showItem(item);
        }

        await vscode.commands.executeCommand(
            "xPlane.details.focus"
        );
    }

    async previewSelected() {
        const item = this.getSelected();

        if (!item) {
            return;
        }

        this.details.showItem(item);

        if (item.anchor.type !== "project") {
            await this.openAnchor(item, {
                preserveFocus: true,
                selectRange: true
            });
        }

        await this.focusExplorer();
    }

    async openSelected() {
        const item = this.getSelected();

        if (!item) {
            return;
        }

        this.details.showItem(item);
        await this.openAnchor(item, {
            preserveFocus: false,
            selectRange: false
        });
    }

    async searchExplorer() {
        const items = this.provider.getFilteredItems();

        const selected = await vscode.window.showQuickPick(
            items.map(item => ({
                label: item.text,
                description: `${item.type} · ${getAnchorFileName(item)}`,
                detail: getAnchorLabel(item),
                item
            })),
            {
                title: "Search Entry",
                placeHolder: "Type to search the current Explorer results",
                matchOnDescription: true,
                matchOnDetail: true
            }
        );

        if (!selected) {
            return;
        }

        this.setSelected(selected.item);
        await this.focusExplorer();
    }

    async showAtCursor() {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            editor.document.uri
        );

        if (!workspaceFolder) {
            return;
        }

        const relativePath = vscode.workspace.asRelativePath(
            editor.document.uri,
            false
        );

        const cursor = editor.selection.active;

        const matches = this.provider.getAllItems().filter(item => {
            if (
                item.status !== "active" ||
                item.workspaceFolder !== workspaceFolder.name ||
                item.anchor.type === "project" ||
                item.anchor.relativePath !== relativePath
            ) {
                return false;
            }

            if (item.anchor.type === "file") {
                return true;
            }

            const range = resolveAnchorRange(item, editor.document);
            return range ? range.contains(cursor) : false;
        });

        if (matches.length === 1) {
            this.setSelected(matches[0]);
            return;
        }

        if (matches.length > 1) {
            const selected = await vscode.window.showQuickPick(
                matches.map(item => ({
                    label: item.text,
                    description: item.type,
                    item
                })),
                {
                    title: "Entry at Cursor"
                }
            );

            if (selected) {
                this.setSelected(selected.item);
            }
        }
    }

    async toggleGutterMarkers() {
        await toggleSetting("showGutterMarkers");
    }

    async toggleAnchorLines() {
        await toggleSetting("showAnchorLines");
    }

    async toggleHeatMap() {
        await toggleSetting("showHeatMap");
    }

    async toggleDecorations() {
        const configuration = vscode.workspace.getConfiguration(
            "xPlane"
        );

        const gutters = configuration.get("showGutterMarkers", true);
        const lines = configuration.get("showAnchorLines", true);
        const next = !(gutters || lines);

        await configuration.update(
            "showGutterMarkers",
            next,
            vscode.ConfigurationTarget.Workspace
        );

        await configuration.update(
            "showAnchorLines",
            next,
            vscode.ConfigurationTarget.Workspace
        );
    }

    async linkItem(item) {
        const existingLinks = new Set(item.links || []);

        const candidates = this.provider
            .getAllItems()
            .filter(candidate =>
                candidate.id !== item.id &&
                !existingLinks.has(candidate.id)
            );

        if (candidates.length === 0) {
            vscode.window.showInformationMessage(
                "There are no additional entrys to link."
            );
            return;
        }

        const selected = await vscode.window.showQuickPick(
            candidates.map(candidate => ({
                label: candidate.text,
                description:
                    `${candidate.type} · ${getAnchorFileName(candidate)}`,
                detail: getAnchorLabel(candidate),
                item: candidate
            })),
            {
                title: "Link Entry",
                placeHolder: "Choose entry to link",
                matchOnDescription: true,
                matchOnDetail: true
            }
        );

        if (!selected) {
            return;
        }

        item.links = [
            ...existingLinks,
            selected.item.id
        ];

        item.updatedAt = new Date().toISOString();

        await this.save(item);
    }

    async openLinked(itemId) {
        const item = this.provider
            .getAllItems()
            .find(candidate => candidate.id === itemId);

        if (!item) {
            return;
        }

        this.setSelected(item, {
            notifyExplorer: true
        });
    }

    async addComment(item) {
        const author = await getCommentAuthor();

        if (!author) {
            return;
        }

        const text = await vscode.window.showInputBox({
            title: "Add Comment",
            prompt: `Posting as ${author}`,
            placeHolder: "Write your comment",
            validateInput: validateCommentText,
            ignoreFocusOut: true
        });

        if (!text) {
            return;
        }

        const now = new Date().toISOString();

        item.comments = [
            ...(item.comments || []),
            {
                id: crypto.randomUUID(),
                author,
                text: text.trim(),
                createdAt: now,
                updatedAt: now
            }
        ];

        item.updatedAt = now;
        await this.save(item);
    }

    async deleteComment(item, commentId) {
        const comment = (item.comments || []).find(
            candidate => candidate.id === commentId
        );

        if (!comment) {
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            `Delete ${comment.author}'s comment?`,
            { modal: true },
            "Delete Comment"
        );

        if (answer !== "Delete Comment") {
            return;
        }

        item.comments = (item.comments || []).filter(
            candidate => candidate.id !== commentId
        );

        item.updatedAt = new Date().toISOString();
        await this.save(item);
    }


    async exportExchange() {
        const workspaceFolder = await chooseWorkspaceFolder();

        if (!workspaceFolder) {
            return;
        }

        const items = await this.storage.readItems(workspaceFolder);

        const defaultUri = vscode.Uri.file(
            path.join(
                workspaceFolder.uri.fsPath,
                `${workspaceFolder.name}.xplane-share.json`
            )
        );

        const destination = await vscode.window.showSaveDialog({
            title: "Export X-Plane Exchange",
            defaultUri,
            filters: {
                "X-Plane Exchange": ["json"]
            }
        });

        if (!destination) {
            return;
        }

        const payload = {
            format: "x-plane-exchange",
            version: 1,
            exportedAt: new Date().toISOString(),
            sourceWorkspace: workspaceFolder.name,
            items
        };

        await vscode.workspace.fs.writeFile(
            destination,
            Buffer.from(
                `${JSON.stringify(payload, null, 2)}\n`,
                "utf8"
            )
        );

        vscode.window.showInformationMessage(
            `Exported ${items.length} X-Plane ` +
            `entr${items.length === 1 ? "y" : "ies"}.`
        );
    }

    async importExchange() {
        const workspaceFolder = await chooseWorkspaceFolder();

        if (!workspaceFolder) {
            return;
        }

        const selectedFiles = await vscode.window.showOpenDialog({
            title: "Import X-Plane Exchange",
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                "X-Plane Exchange": ["json"]
            }
        });

        const source = selectedFiles?.[0];

        if (!source) {
            return;
        }

        let payload;

        try {
            const bytes = await vscode.workspace.fs.readFile(source);
            payload = JSON.parse(
                Buffer.from(bytes).toString("utf8")
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Unable to import X-Plane exchange: ${error.message}`
            );
            return;
        }

        if (
            payload?.format !== "x-plane-exchange" ||
            !Array.isArray(payload.items)
        ) {
            vscode.window.showErrorMessage(
                "This file is not a valid X-Plane exchange."
            );
            return;
        }

        const localItems = await this.storage.readItems(
            workspaceFolder
        );

        const result = mergeExchangeItems(
            localItems,
            payload.items,
            workspaceFolder.name
        );

        await this.storage.writeItems(
            workspaceFolder,
            result.items
        );

        await this.refresh();

        const details = [
            `${result.addedEntries} new entr` +
                `${result.addedEntries === 1 ? "y" : "ies"}`,
            `${result.addedComments} new comment` +
                `${result.addedComments === 1 ? "" : "s"}`,
            `${result.addedLinks} new link` +
                `${result.addedLinks === 1 ? "" : "s"}`
        ];

        if (result.conflicts > 0) {
            details.push(
                `${result.conflicts} local entr` +
                `${result.conflicts === 1 ? "y" : "ies"} preserved ` +
                "instead of being overwritten"
            );
        }

        vscode.window.showInformationMessage(
            `X-Plane import complete: ${details.join(", ")}.`
        );
    }

    async save(item) {
        const workspaceFolder = findWorkspaceFolder(item.workspaceFolder);

        if (!workspaceFolder) {
            return;
        }

        await this.storage.upsertItem(workspaceFolder, item);
        await this.refresh();
        this.setSelected(item);
    }
}

async function toggleSetting(name) {
    const configuration = vscode.workspace.getConfiguration(
        "xPlane"
    );

    const current = configuration.get(name, true);

    await configuration.update(
        name,
        !current,
        vscode.ConfigurationTarget.Workspace
    );
}

async function chooseWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders || [];

    if (folders.length === 0) {
        return null;
    }

    if (folders.length === 1) {
        return folders[0];
    }

    const selected = await vscode.window.showQuickPick(
        folders.map(folder => ({
            label: folder.name,
            description: folder.uri.fsPath,
            folder
        }))
    );

    return selected?.folder ?? null;
}

async function chooseEntryType(currentType) {
    const selected = await vscode.window.showQuickPick(
        ENTRY_TYPES.map(type => ({
            label: type,
            description: type === currentType
                ? "Current type"
                : undefined,
            value: type
        })),
        {
            title: "Entry Type"
        }
    );

    return selected?.value ?? null;
}

async function chooseAnchorScope(editor) {
    const options = [];

    if (editor && !editor.selection.isEmpty) {
        options.push({
            label: "$(selection) Exact Selection",
            description:
                "The full selection, including multiple lines, is one entry.",
            value: "selection"
        });
    }

    if (editor) {
        options.push({
            label: "$(file) Entire File",
            value: "file"
        });
    }

    options.push({
        label: "$(project) Entire Project",
        value: "project"
    });

    const selected = await vscode.window.showQuickPick(options, {
        title: "Anchor Entry To"
    });

    return selected?.value ?? null;
}

async function chooseParentItem(workspaceFolder, storage) {
    const items = await storage.readItems(workspaceFolder);

    const selected = await vscode.window.showQuickPick(
        [
            {
                label: "$(root-folder) No Parent",
                value: null
            },
            ...items.map(item => ({
                label: item.text,
                description: item.type,
                value: item.id
            }))
        ],
        {
            title: "Choose Parent Entry"
        }
    );

    return selected ? selected.value : undefined;
}

async function promptForEntryText(type) {
    return vscode.window.showInputBox({
        title: `Add ${type}`,
        prompt: "Describe the entry.",
        validateInput: validateEntryText,
        ignoreFocusOut: true
    });
}

function validateEntryText(value) {
    if (!value || value.trim().length === 0) {
        return "Entry text is required.";
    }

    if (value.trim().length > 4000) {
        return "Entry text must be 4,000 characters or fewer.";
    }

    return null;
}

async function getCommentAuthor() {
    const configuration = vscode.workspace.getConfiguration(
        "xPlane"
    );

    const configured = configuration.get("authorName", "");

    if (
        typeof configured === "string" &&
        configured.trim()
    ) {
        return configured.trim();
    }

    const choice = await vscode.window.showInformationMessage(
        "Set the name that will appear beside your shared X-Plane comments.",
        { modal: true },
        "Set Comment Name"
    );

    if (choice !== "Set Comment Name") {
        return null;
    }

    const author = await vscode.window.showInputBox({
        title: "X-Plane Comment Name",
        prompt:
            "Enter your name only. Your comment will be entered in the next prompt.",
        placeHolder: "For example: Alex",
        validateInput: value =>
            value && value.trim()
                ? null
                : "A name is required.",
        ignoreFocusOut: true
    });

    if (!author) {
        return null;
    }

    await configuration.update(
        "authorName",
        author.trim(),
        vscode.ConfigurationTarget.Global
    );

    return author.trim();
}

function validateCommentText(value) {
    if (!value || !value.trim()) {
        return "Comment text is required.";
    }

    if (value.trim().length > 4000) {
        return "Comments must be 4,000 characters or fewer.";
    }

    return null;
}

function mergeExchangeItems(
    localItems,
    importedItems,
    workspaceFolderName
) {
    const items = localItems.map(item => ({
        ...item,
        links: [...(item.links || [])],
        comments: [...(item.comments || [])]
    }));

    const localById = new Map(
        items.map(item => [item.id, item])
    );

    let addedEntries = 0;
    let addedComments = 0;
    let addedLinks = 0;
    let conflicts = 0;

    for (const imported of importedItems) {
        if (
            !imported ||
            typeof imported.id !== "string" ||
            typeof imported.text !== "string" ||
            !imported.anchor
        ) {
            continue;
        }

        const existing = localById.get(imported.id);

        if (!existing) {
            const added = {
                ...imported,
                workspaceFolder: workspaceFolderName,
                links: uniqueStrings(imported.links),
                comments: mergeComments([], imported.comments)
                    .comments
            };

            items.push(added);
            localById.set(added.id, added);
            addedEntries += 1;
            addedComments += added.comments.length;
            addedLinks += added.links.length;
            continue;
        }

        if (coreEntryDiffers(existing, imported)) {
            conflicts += 1;
        }

        const mergedComments = mergeComments(
            existing.comments,
            imported.comments
        );

        existing.comments = mergedComments.comments;
        addedComments += mergedComments.added;

        const beforeLinks = new Set(existing.links || []);
        existing.links = uniqueStrings([
            ...(existing.links || []),
            ...(imported.links || [])
        ]);
        addedLinks += existing.links.filter(
            linkId => !beforeLinks.has(linkId)
        ).length;
    }

    return {
        items,
        addedEntries,
        addedComments,
        addedLinks,
        conflicts
    };
}

function mergeComments(localComments, importedComments) {
    const comments = [...(localComments || [])];
    const knownIds = new Set(
        comments.map(comment => comment.id)
    );
    let added = 0;

    for (const comment of importedComments || []) {
        if (
            !comment ||
            typeof comment.id !== "string" ||
            typeof comment.text !== "string" ||
            knownIds.has(comment.id)
        ) {
            continue;
        }

        comments.push({
            id: comment.id,
            author:
                typeof comment.author === "string" &&
                comment.author.trim()
                    ? comment.author.trim()
                    : "Unknown",
            text: comment.text.trim(),
            createdAt:
                typeof comment.createdAt === "string"
                    ? comment.createdAt
                    : new Date(0).toISOString(),
            updatedAt:
                typeof comment.updatedAt === "string"
                    ? comment.updatedAt
                    : (
                        typeof comment.createdAt === "string"
                            ? comment.createdAt
                            : new Date(0).toISOString()
                    )
        });

        knownIds.add(comment.id);
        added += 1;
    }

    comments.sort(
        (left, right) =>
            new Date(left.createdAt) - new Date(right.createdAt)
    );

    return { comments, added };
}

function coreEntryDiffers(local, imported) {
    return (
        local.text !== imported.text ||
        local.type !== imported.type ||
        local.status !== imported.status ||
        JSON.stringify(local.anchor) !==
            JSON.stringify(imported.anchor)
    );
}

function uniqueStrings(values) {
    return [
        ...new Set(
            (values || []).filter(
                value =>
                    typeof value === "string" &&
                    value.length > 0
            )
        )
    ];
}


module.exports = { EntryCommands };
