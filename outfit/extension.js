const vscode = require("vscode");
const path = require("path");

const PROFILES_KEY = "workspaceExclusionProfiles.profiles";
const ACTIVE_PROFILE_KEY = "workspaceExclusionProfiles.activeProfile";

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "exclusionProfiles.createProfile",
            () => createProfile(context)
        ),

        vscode.commands.registerCommand(
            "exclusionProfiles.switchProfile",
            () => switchProfile(context)
        ),

        vscode.commands.registerCommand(
            "exclusionProfiles.excludeFolderInCurrentProfile",
            (uri) => excludeFolderInCurrentProfile(context, uri)
        ),

        vscode.commands.registerCommand(
            "exclusionProfiles.addFolderToProfile",
            (uri) => addFolderToProfile(context, uri)
        ),

        vscode.commands.registerCommand(
            "exclusionProfiles.onlyShowThisFolder",
            (uri) => onlyShowThisFolder(context, uri)
        ),

        vscode.commands.registerCommand(
            "exclusionProfiles.clearActiveProfile",
            () => clearActiveProfile(context)
        ),

        vscode.commands.registerCommand(
            "exclusionProfiles.showActiveProfile",
            () => showActiveProfile(context)
        ),

        vscode.commands.registerCommand(
            "exclusionProfiles.deleteProfile",
            () => deleteProfile(context)
        ),
        vscode.commands.registerCommand(
            "exclusionProfiles.removeExclusionFromCurrentProfile",
            () => removeExclusionFromCurrentProfile(context)
        )

    );
}

function deactivate() { }

async function createProfile(context) {
    const name = await vscode.window.showInputBox({
        prompt: "Profile name",
        placeHolder: "Project A"
    });

    if (!name) return;

    const profiles = getProfiles(context);

    if (profiles[name]) {
        vscode.window.showWarningMessage(`Profile "${name}" already exists.`);
        return;
    }

    profiles[name] = {
        exclude: []
    };

    await saveProfiles(context, profiles);
    await setActiveProfile(context, name);
    await applyProfile(context, name);

    vscode.window.showInformationMessage(`Created profile "${name}".`);
}

async function switchProfile(context) {
    const profiles = getProfiles(context);
    const names = Object.keys(profiles);

    if (names.length === 0) {
        vscode.window.showWarningMessage("No exclusion profiles exist.");
        return;
    }

    const selected = await vscode.window.showQuickPick(names, {
        placeHolder: "Select exclusion profile"
    });

    if (!selected) return;

    await setActiveProfile(context, selected);
    await applyProfile(context, selected);

    vscode.window.showInformationMessage(`Switched to "${selected}".`);
}

async function excludeFolderInCurrentProfile(context, uri) {
    const folderUri = getFolderUri(uri);
    if (!folderUri) return;

    let activeProfile = getActiveProfile(context);

    if (!activeProfile) {
        activeProfile = await vscode.window.showInputBox({
            prompt: "No active profile. Create profile named:",
            placeHolder: "Project A"
        });

        if (!activeProfile) return;

        const profiles = getProfiles(context);
        profiles[activeProfile] = { exclude: [] };

        await saveProfiles(context, profiles);
        await setActiveProfile(context, activeProfile);
    }

    await addExcludeToProfile(context, activeProfile, folderUri);
    await applyProfile(context, activeProfile);

    vscode.window.showInformationMessage(
        `Excluded folder in profile "${activeProfile}".`
    );
}

async function addFolderToProfile(context, uri) {
    const folderUri = getFolderUri(uri);
    if (!folderUri) return;

    const profiles = getProfiles(context);
    const names = Object.keys(profiles);

    if (names.length === 0) {
        vscode.window.showWarningMessage("Create a profile first.");
        return;
    }

    const selected = await vscode.window.showQuickPick(names, {
        placeHolder: "Add this folder to which profile?"
    });

    if (!selected) return;

    await addExcludeToProfile(context, selected, folderUri);

    if (getActiveProfile(context) === selected) {
        await applyProfile(context, selected);
    }

    vscode.window.showInformationMessage(`Added folder to "${selected}".`);
}

async function onlyShowThisFolder(context, uri) {
    const targetUri = getFolderUri(uri);
    if (!targetUri) return;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
    if (!workspaceFolder) {
        vscode.window.showWarningMessage("Folder is not inside a workspace.");
        return;
    }

    const profileName = await vscode.window.showInputBox({
        prompt: "Create profile name for this view",
        placeHolder: `Only ${path.basename(targetUri.fsPath)}`
    });

    if (!profileName) return;

    const rootEntries = await vscode.workspace.fs.readDirectory(workspaceFolder.uri);
    const excludes = [];

    for (const [entryName, entryType] of rootEntries) {
        if (entryType !== vscode.FileType.Directory) continue;

        const entryUri = vscode.Uri.joinPath(workspaceFolder.uri, entryName);

        if (entryUri.fsPath === targetUri.fsPath) continue;

        const rel = toWorkspaceRelativeGlob(entryUri);
        if (rel) excludes.push(rel);
    }

    const profiles = getProfiles(context);
    profiles[profileName] = {
        exclude: unique(excludes)
    };

    await saveProfiles(context, profiles);
    await setActiveProfile(context, profileName);
    await applyProfile(context, profileName);

    vscode.window.showInformationMessage(`Created profile "${profileName}".`);
}

async function clearActiveProfile(context) {
    await setActiveProfile(context, undefined);

    const config = vscode.workspace.getConfiguration();

    await config.update(
        "files.exclude",
        {},
        vscode.ConfigurationTarget.Workspace
    );

    await config.update(
        "search.exclude",
        {},
        vscode.ConfigurationTarget.Workspace
    );

    vscode.window.showInformationMessage("Cleared active exclusion profile.");
}

async function showActiveProfile(context) {
    const active = getActiveProfile(context);

    if (!active) {
        vscode.window.showInformationMessage("No active exclusion profile.");
        return;
    }

    const profiles = getProfiles(context);
    const profile = profiles[active];

    if (!profile) {
        vscode.window.showWarningMessage(`Active profile "${active}" no longer exists.`);
        return;
    }

    vscode.window.showInformationMessage(
        `Active profile: ${active}. Exclusions: ${profile.exclude.length}`
    );
}

async function deleteProfile(context) {
    const profiles = getProfiles(context);
    const names = Object.keys(profiles);

    if (names.length === 0) {
        vscode.window.showWarningMessage("No profiles to delete.");
        return;
    }

    const selected = await vscode.window.showQuickPick(names, {
        placeHolder: "Delete which profile?"
    });

    if (!selected) return;

    delete profiles[selected];
    await saveProfiles(context, profiles);

    if (getActiveProfile(context) === selected) {
        await clearActiveProfile(context);
    }

    vscode.window.showInformationMessage(`Deleted profile "${selected}".`);
}

async function addExcludeToProfile(context, profileName, folderUri) {
    const profiles = getProfiles(context);

    if (!profiles[profileName]) {
        profiles[profileName] = { exclude: [] };
    }

    const glob = toWorkspaceRelativeGlob(folderUri);

    if (!glob) {
        vscode.window.showWarningMessage("Could not compute workspace-relative path.");
        return;
    }

    profiles[profileName].exclude = unique([
        ...profiles[profileName].exclude,
        glob
    ]);

    await saveProfiles(context, profiles);
}

async function applyProfile(context, profileName) {
    const profiles = getProfiles(context);
    const profile = profiles[profileName];

    if (!profile) {
        vscode.window.showWarningMessage(`Profile "${profileName}" does not exist.`);
        return;
    }

    const excludes = buildExcludeObject(profile.exclude);
    const config = vscode.workspace.getConfiguration();

    await config.update(
        "files.exclude",
        excludes,
        vscode.ConfigurationTarget.Workspace
    );

    await config.update(
        "search.exclude",
        excludes,
        vscode.ConfigurationTarget.Workspace
    );
}

function buildExcludeObject(excludeGlobs) {
    const result = {};

    for (const glob of excludeGlobs || []) {
        result[glob] = true;
    }

    return result;
}

function getProfiles(context) {
    return context.workspaceState.get(PROFILES_KEY, {});
}

async function saveProfiles(context, profiles) {
    await context.workspaceState.update(PROFILES_KEY, profiles);
}

function getActiveProfile(context) {
    return context.workspaceState.get(ACTIVE_PROFILE_KEY);
}

async function setActiveProfile(context, profileName) {
    await context.workspaceState.update(ACTIVE_PROFILE_KEY, profileName);
}

function getFolderUri(uri) {
    if (uri) return uri;

    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;

    return vscode.Uri.file(path.dirname(editor.document.uri.fsPath));
}

function toWorkspaceRelativeGlob(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

    if (!workspaceFolder) return undefined;

    let rel = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    rel = rel.replace(/\\/g, "/");

    if (!rel || rel === ".") return undefined;

    return `${rel}/**`;
}

async function removeExclusionFromCurrentProfile(context) {
    const activeProfile = getActiveProfile(context);

    if (!activeProfile) {
        vscode.window.showWarningMessage("No active exclusion profile.");
        return;
    }

    const profiles = getProfiles(context);
    const profile = profiles[activeProfile];

    if (!profile || !profile.exclude || profile.exclude.length === 0) {
        vscode.window.showInformationMessage(
            `Profile "${activeProfile}" has no exclusions.`
        );
        return;
    }

    const selected = await vscode.window.showQuickPick(profile.exclude, {
        placeHolder: `Remove exclusion from "${activeProfile}"`
    });

    if (!selected) return;

    profile.exclude = profile.exclude.filter(item => item !== selected);
    profiles[activeProfile] = profile;

    await saveProfiles(context, profiles);
    await applyProfile(context, activeProfile);

    vscode.window.showInformationMessage(
        `Removed "${selected}" from "${activeProfile}".`
    );
}

function unique(values) {
    return [...new Set(values)];
}

module.exports = {
    activate,
    deactivate
};