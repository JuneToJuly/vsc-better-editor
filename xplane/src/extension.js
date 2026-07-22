const vscode = require("vscode");
const { EntryStorage } = require("./storage");
const { EntryProvider } = require("./tree");
const { EntryExplorerProvider } = require("./explorerView");
const { EntryDecorations } = require("./decorations");
const { EntryDetailsProvider } = require("./detailsView");
const { EntryCommands } = require("./commands");
const { ProjectHeatMapProvider } = require("./projectHeatMap");
const { ENTRY_TYPES } = require("./constants");

let provider;
let explorer;
let details;
let decorations;
let commands;
let projectHeatMap;

async function activate(context) {
    provider = new EntryProvider();
    decorations = new EntryDecorations();
    decorations.recreate(context);

    explorer = new EntryExplorerProvider({
        getItems: () => provider.getFilteredItems(),
        getAllItems: () => provider.getAllItems(),
        getFilter: () => provider.filter,
        onSelect: async item => {
            commands.setSelected(item);
        },
        onOpen: async item => {
            commands.setSelected(item);
            await commands.openAnchor(item, false);
        },
        onPreview: async item => {
            commands.setSelected(item);
            await commands.openAnchor(item, true);
            await commands.focusExplorer();
        },
        onFocusDetails: async item => {
            commands.setSelected(item);
            await commands.focusDetails();
        },
        onFilter: async () => {
            await changeFilter();
        },
        onSearch: async () => {
            await commands.searchExplorer();
        }
    });

    const explorerRegistration =
        vscode.window.registerWebviewViewProvider(
            "xPlane.items",
            explorer,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        );

    const refresh = async () => {
        await provider.reload(EntryStorage);
        await updateDecorations();
        explorer?.render();

        if (details) {
            details.render();
        }

        if (projectHeatMap) {
            projectHeatMap.render();
        }
    };

    details = new EntryDetailsProvider(
        itemId => provider
            .getAllItems()
            .find(item => item.id === itemId),
        () => provider.getAllItems(),
        {}
    );

    commands = new EntryCommands({
        provider,
        storage: EntryStorage,
        decorations,
        details,
        explorer,
        refresh
    });

    details.handlers = {
        openAnchor: item => commands.openAnchor(item, false),
        edit: item => commands.edit(item),
        changeType: item => commands.changeType(item),
        toggleResolved: item => commands.toggleResolved(item),
        rebind: item => commands.rebind(item),
        linkItem: item => commands.linkItem(item),
        addComment: item => commands.addComment(item),
        deleteComment: (item, message) =>
            commands.deleteComment(item, message.commentId),
        deleteItem: item => commands.delete(item),
        openLinked: (_item, message) =>
            commands.openLinked(message.linkedItemId)
    };

    const detailsRegistration =
        vscode.window.registerWebviewViewProvider(
            "xPlane.details",
            details,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        );

    projectHeatMap = new ProjectHeatMapProvider(
        () => provider.getAllItems(),
        {
            openFile: openHeatMapFile
        }
    );

    const heatMapRegistration =
        vscode.window.registerWebviewViewProvider(
            "xPlane.projectHeatMap",
            projectHeatMap,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        );



    registerCommands(context);

    context.subscriptions.push(
        explorerRegistration,
        detailsRegistration,
        heatMapRegistration,

        vscode.window.onDidChangeActiveTextEditor(async () => {
            await updateDecorations();

            if (
                provider.filter === "currentFile" ||
                provider.filter === "currentSelection"
            ) {
                provider.changeEmitter.fire(undefined);
                explorer?.render();
            }
        }),

        vscode.workspace.onDidSaveTextDocument(
            async () => updateDecorations()
        ),

        vscode.workspace.onDidChangeConfiguration(async event => {
            if (event.affectsConfiguration("xPlane")) {
                decorations.recreate(context);
                await updateDecorations();
                provider.changeEmitter.fire(undefined);
                explorer?.render();
            }
        })
    );

    await refresh();
}

function deactivate() {
    decorations?.dispose();
}

function getXPlaneConfiguration() {
    return vscode.workspace.getConfiguration("xPlane");
}

function registerCommands(context) {
    const register = (name, handler) => {
        context.subscriptions.push(
            vscode.commands.registerCommand(name, handler)
        );

        if (name.startsWith("xPlane.")) {
            const legacyName = name.replace(
                "xPlane.",
                "codeKnowledge."
            );

            context.subscriptions.push(
                vscode.commands.registerCommand(
                    legacyName,
                    handler
                )
            );
        }
    };

    register(
        "xPlane.addItem",
        () => commands.addItem()
    );

    register(
        "xPlane.addChildItem",
        value => commands.addItem(value?.item || value)
    );

    register(
        "xPlane.viewItem",
        value => {
            const item = typeof value === "string"
                ? provider.getAllItems().find(candidate => candidate.id === value)
                : value?.item || value;

            if (item) {
                commands.setSelected(item);
            }
        }
    );

    register(
        "xPlane.openAnchor",
        value => commands.openAnchor(value?.item || value, false)
    );

    register(
        "xPlane.openSelected",
        () => commands.openSelected()
    );

    register(
        "xPlane.previewSelected",
        () => commands.previewSelected()
    );

    register(
        "xPlane.focusExplorer",
        () => commands.focusExplorer()
    );

    register(
        "xPlane.focusDetails",
        () => commands.focusDetails()
    );

    register(
        "xPlane.searchExplorer",
        () => commands.searchExplorer()
    );

    register(
        "xPlane.showAtCursor",
        () => commands.showAtCursor()
    );

    register(
        "xPlane.toggleResolved",
        value => commands.toggleResolved(value?.item || value)
    );

    register(
        "xPlane.editItem",
        value => commands.edit(value?.item || value)
    );

    register(
        "xPlane.changeType",
        value => commands.changeType(value?.item || value)
    );

    register(
        "xPlane.rebindItem",
        value => commands.rebind(value?.item || value)
    );

    register(
        "xPlane.deleteItem",
        value => commands.delete(value?.item || value)
    );

    register(
        "xPlane.linkItem",
        value => commands.linkItem(value?.item || value)
    );

    register(
        "xPlane.addComment",
        value => commands.addComment(value?.item || value)
    );

    register(
        "xPlane.exportExchange",
        () => commands.exportExchange()
    );

    register(
        "xPlane.importExchange",
        () => commands.importExchange()
    );

    register(
        "xPlane.toggleGutterMarkers",
        () => commands.toggleGutterMarkers()
    );

    register(
        "xPlane.toggleAnchorLines",
        () => commands.toggleAnchorLines()
    );

    register(
        "xPlane.toggleHeatMap",
        () => commands.toggleHeatMap()
    );

    register(
        "xPlane.toggleDecorations",
        () => commands.toggleDecorations()
    );

    register(
        "xPlane.changeFilter",
        changeFilter
    );

    register(
        "xPlane.showProjectHeatMap",
        async () => {
            projectHeatMap.render();
            await vscode.commands.executeCommand(
                "xPlane.projectHeatMap.focus"
            );
        }
    );

    register(
        "xPlane.refresh",
        async () => {
            await provider.reload(EntryStorage);
            await updateDecorations();
            explorer?.render();
            projectHeatMap?.render();
        }
    );
}

async function openHeatMapFile(
    workspaceFolderName,
    relativePath
) {
    const workspaceFolder =
        (vscode.workspace.workspaceFolders || []).find(
            folder => folder.name === workspaceFolderName
        );

    if (!workspaceFolder) {
        vscode.window.showErrorMessage(
            `Workspace folder "${workspaceFolderName}" is not open.`
        );
        return;
    }

    const uri = vscode.Uri.joinPath(
        workspaceFolder.uri,
        relativePath
    );

    const document = await vscode.workspace.openTextDocument(uri);

    await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: true
    });

    provider.setFilter("currentFile");
    explorer?.render();

    await vscode.commands.executeCommand(
        "xPlane.items.focus"
    );
}

async function changeFilter() {
    const typeOptions = ENTRY_TYPES.map(type => ({
        label: type,
        value: `type:${type}`
    }));

    const selected = await vscode.window.showQuickPick(
        [
            { label: "Active Items", value: "active" },
            { label: "All Items", value: "all" },
            { label: "Resolved Items", value: "resolved" },
            { label: "Current File", value: "currentFile" },
            { label: "Current Selection", value: "currentSelection" },
            ...typeOptions
        ],
        {
            title: "Entry Filter"
        }
    );

    if (!selected) {
        return;
    }

    provider.setFilter(selected.value);
    explorer?.render();
}

async function updateDecorations() {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
        editor.document.uri
    );

    if (!workspaceFolder) {
        decorations.clear(editor);
        return;
    }

    const relativePath = vscode.workspace.asRelativePath(
        editor.document.uri,
        false
    );

    const items = provider.getAllItems().filter(item =>
        item.status === "active" &&
        item.workspaceFolder === workspaceFolder.name &&
        item.anchor.relativePath === relativePath
    );

    decorations.update(editor, items);
}

module.exports = {
    activate,
    deactivate
};
