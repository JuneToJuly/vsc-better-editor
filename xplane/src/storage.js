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

        const items = parsed.items.map(item => ({
            ...item,
            parentId: item.parentId ?? null,
            type: ENTRY_TYPES.includes(item.type)
                ? item.type
                : "Documentation",
            status: item.status || "active",
            links: Array.isArray(item.links)
                ? [...new Set(item.links.filter(Boolean))]
                : [],
            workspaceFolder:
                item.workspaceFolder || workspaceFolder.name
        }));

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
                items
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
        items.push(item);
        await this.writeItems(workspaceFolder, items);
    }

    static async upsertItem(workspaceFolder, item) {
        const items = await this.readItems(workspaceFolder);
        const index = items.findIndex(existing => existing.id === item.id);

        if (index === -1) {
            items.push(item);
        } else {
            items[index] = item;
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
                links: (item.links || []).filter(linkId => !ids.has(linkId))
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

module.exports = { EntryStorage };
