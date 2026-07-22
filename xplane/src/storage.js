const vscode = require("vscode");
const {
    ENTRY_TYPES,
    STORAGE_DIRECTORY,
    STORAGE_FILE,
    LEGACY_STORAGE_DIRECTORY,
    LEGACY_STORAGE_FILE,
    STORAGE_VERSION
} = require("./constants");

class EntryStorage {
    static storageUri(workspaceFolder) {
        return vscode.Uri.joinPath(
            workspaceFolder.uri,
            STORAGE_DIRECTORY,
            STORAGE_FILE
        );
    }

    static legacyStorageUri(workspaceFolder) {
        return vscode.Uri.joinPath(
            workspaceFolder.uri,
            LEGACY_STORAGE_DIRECTORY,
            LEGACY_STORAGE_FILE
        );
    }

    static async readItems(workspaceFolder) {
        const currentUri = this.storageUri(workspaceFolder);
        const legacyUri = this.legacyStorageUri(workspaceFolder);

        let parsed;
        let loadedFromLegacy = false;

        try {
            parsed = await this.readJson(currentUri);
        } catch (error) {
            if (error.code !== "FileNotFound") {
                return this.reportReadError(currentUri, error);
            }

            try {
                parsed = await this.readJson(legacyUri);
                loadedFromLegacy = true;
            } catch (legacyError) {
                if (legacyError.code === "FileNotFound") {
                    return [];
                }

                return this.reportReadError(legacyUri, legacyError);
            }
        }

        if (!Array.isArray(parsed.items)) {
            return [];
        }

        const items = parsed.items.map(item =>
            normalizeItem(item, workspaceFolder.name)
        );

        if (loadedFromLegacy) {
            await this.writeItems(workspaceFolder, items);
        }

        return items;
    }

    static async readJson(uri) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(Buffer.from(bytes).toString("utf8"));
    }

    static reportReadError(uri, error) {
        console.error(`Unable to read X-Plane entries at ${uri.fsPath}`, error);
        vscode.window.showErrorMessage(
            `Unable to read X-Plane entries from ${uri.fsPath}.`
        );
        return [];
    }

    static async writeItems(workspaceFolder, items) {
        const directoryUri = vscode.Uri.joinPath(
            workspaceFolder.uri,
            STORAGE_DIRECTORY
        );

        await vscode.workspace.fs.createDirectory(directoryUri);

        const bytes = Buffer.from(
            `${JSON.stringify({
                version: STORAGE_VERSION,
                items: items.map(item =>
                    normalizeItem(item, workspaceFolder.name)
                )
            }, null, 2)}\n`,
            "utf8"
        );

        await vscode.workspace.fs.writeFile(
            this.storageUri(workspaceFolder),
            bytes
        );
    }

    static async addItem(workspaceFolder, item) {
        const items = await this.readItems(workspaceFolder);
        items.push(normalizeItem(item, workspaceFolder.name));
        await this.writeItems(workspaceFolder, items);
    }

    static async upsertItem(workspaceFolder, item) {
        const items = await this.readItems(workspaceFolder);
        const normalized = normalizeItem(
            item,
            workspaceFolder.name
        );
        const index = items.findIndex(
            existing => existing.id === normalized.id
        );

        if (index === -1) {
            items.push(normalized);
        } else {
            items[index] = normalized;
        }

        await this.writeItems(workspaceFolder, items);
    }

    static async deleteItems(workspaceFolder, itemIds) {
        const ids = new Set(itemIds);
        const items = await this.readItems(workspaceFolder);

        const remaining = items
            .filter(item => !ids.has(item.id))
            .map(item => ({
                ...item,
                links: (item.links || []).filter(
                    linkId => !ids.has(linkId)
                )
            }));

        await this.writeItems(workspaceFolder, remaining);
    }

    static async deleteResolved(workspaceFolder) {
        const items = await this.readItems(workspaceFolder);
        const resolvedIds = new Set(
            items
                .filter(item => item.status === "resolved")
                .map(item => item.id)
        );

        await this.deleteItems(workspaceFolder, resolvedIds);
    }
}

function normalizeItem(item, workspaceFolderName) {
    return {
        ...item,
        parentId: item.parentId ?? null,
        type: ENTRY_TYPES.includes(item.type)
            ? item.type
            : "Documentation",
        status: item.status || "active",
        links: uniqueStrings(item.links),
        comments: normalizeComments(item.comments),
        workspaceFolder:
            workspaceFolderName ||
            item.workspaceFolder ||
            ""
    };
}

function normalizeComments(comments) {
    if (!Array.isArray(comments)) {
        return [];
    }

    const byId = new Map();

    for (const comment of comments) {
        if (
            !comment ||
            typeof comment.id !== "string" ||
            typeof comment.text !== "string"
        ) {
            continue;
        }

        byId.set(comment.id, {
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
    }

    return [...byId.values()].sort(
        (left, right) =>
            new Date(left.createdAt) - new Date(right.createdAt)
    );
}

function uniqueStrings(values) {
    if (!Array.isArray(values)) {
        return [];
    }

    return [
        ...new Set(
            values.filter(
                value =>
                    typeof value === "string" &&
                    value.length > 0
            )
        )
    ];
}

module.exports = {
    EntryStorage,
    normalizeItem,
    normalizeComments
};
