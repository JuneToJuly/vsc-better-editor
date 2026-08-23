const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FAVORITES_KEY = 'themeFavorites.items';

function activate(context) {
  const review = vscode.commands.registerCommand('themeFavorites.reviewThemes', async () => {
    await reviewThemes(context);
  });

  const toggle = vscode.commands.registerCommand('themeFavorites.toggleFavorite', async () => {
    const currentTheme = getCurrentTheme();
    if (!currentTheme) {
      vscode.window.showWarningMessage('Theme Favorites: no active color theme was found.');
      return;
    }

    const favorites = getFavorites(context);
    const existingIndex = findThemeIndex(favorites, currentTheme);
    const showNotifications = vscode.workspace.getConfiguration('themeFavorites').get('showNotifications', true);

    if (existingIndex >= 0) {
      favorites.splice(existingIndex, 1);
      await saveFavorites(context, favorites);
      if (showNotifications) vscode.window.showInformationMessage(`Removed “${currentTheme}” from favorite themes.`);
    } else {
      favorites.push(currentTheme);
      await saveFavorites(context, favorites);
      if (showNotifications) vscode.window.showInformationMessage(`Added “${currentTheme}” to favorite themes.`);
    }
  });

  const pick = vscode.commands.registerCommand('themeFavorites.pickFavorite', async () => {
    await pickFavoriteWithPreview(context);
  });

  const next = vscode.commands.registerCommand('themeFavorites.nextFavorite', async () => cycleFavorite(context, 1));
  const previous = vscode.commands.registerCommand('themeFavorites.previousFavorite', async () => cycleFavorite(context, -1));

  const exportBundle = vscode.commands.registerCommand('themeFavorites.exportThemeBundle', async () => {
    await exportFavoriteThemeBundle(context);
  });

  const importBundle = vscode.commands.registerCommand('themeFavorites.importThemeBundle', async () => {
    await importFavoriteThemeBundle(context);
  });

  const manage = vscode.commands.registerCommand('themeFavorites.manageFavorites', async () => {
    const favorites = getFavorites(context);
    if (!favorites.length) {
      vscode.window.showInformationMessage('Theme Favorites: there are no favorites to manage.');
      return;
    }

    const chosen = await vscode.window.showQuickPick(
      favorites.map(theme => ({ label: theme, description: 'Favorite theme' })),
      {
        title: 'Remove Favorite Themes',
        placeHolder: 'Select favorites to remove',
        canPickMany: true
      }
    );

    if (!chosen || !chosen.length) return;

    const remove = new Set(chosen.map(item => item.label.toLowerCase()));
    const remaining = favorites.filter(theme => !remove.has(theme.toLowerCase()));
    await saveFavorites(context, remaining);
    vscode.window.showInformationMessage(`Removed ${chosen.length} favorite theme${chosen.length === 1 ? '' : 's'}.`);
  });

  context.subscriptions.push(review, toggle, pick, next, previous, manage, exportBundle, importBundle);
}


async function pickFavoriteWithPreview(context) {
  const favorites = getFavorites(context);
  if (!favorites.length) {
    const action = await vscode.window.showInformationMessage(
      'You do not have any favorite themes yet.',
      'Review Themes'
    );
    if (action === 'Review Themes') await vscode.commands.executeCommand('themeFavorites.reviewThemes');
    return;
  }

  const originalTheme = getCurrentTheme();
  let committed = false;
  let previewing = false;
  let disposed = false;

  const quickPick = vscode.window.createQuickPick();
  quickPick.title = 'Favorite Themes';
  quickPick.placeholder = 'Move through favorites to preview • Enter to keep • Esc to cancel';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.ignoreFocusOut = true;

  const items = favorites.map(theme => ({
    label: theme,
    description: sameTheme(theme, originalTheme) ? 'Current theme' : undefined,
    detail: 'Highlight to preview',
    iconPath: new vscode.ThemeIcon(sameTheme(theme, originalTheme) ? 'check' : 'symbol-color')
  }));

  quickPick.items = items;

  const currentIndex = findThemeIndex(favorites, originalTheme);
  if (currentIndex >= 0) quickPick.activeItems = [items[currentIndex]];

  quickPick.onDidChangeActive(async activeItems => {
    if (disposed || previewing || !activeItems.length) return;

    const item = activeItems[0];
    if (!item || sameTheme(item.label, getCurrentTheme())) return;

    previewing = true;
    await applyTheme(item.label, false);
    previewing = false;
  });

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0] || quickPick.activeItems[0];
    if (!selected) return;

    committed = true;
    if (!sameTheme(getCurrentTheme(), selected.label)) {
      await applyTheme(selected.label);
    }
    quickPick.hide();
  });

  quickPick.onDidHide(async () => {
    disposed = true;
    quickPick.dispose();

    if (!committed && originalTheme && !sameTheme(getCurrentTheme(), originalTheme)) {
      await applyTheme(originalTheme, false);
    }
  });

  quickPick.show();
}

async function reviewThemes(context) {
  const themes = getInstalledThemes();
  if (!themes.length) {
    vscode.window.showWarningMessage('Theme Favorites: no installed color themes could be discovered.');
    return;
  }

  const originalTheme = getCurrentTheme();
  let index = Math.max(0, findThemeIndex(themes, originalTheme));
  let finished = false;
  let changing = false;

  const quickPick = vscode.window.createQuickPick();
  quickPick.title = 'Theme Favorites: Review Installed Themes';
  quickPick.placeholder = 'Preview each installed theme, then Favorite or Skip';
  quickPick.ignoreFocusOut = true;
  quickPick.matchOnDescription = false;
  quickPick.matchOnDetail = false;

  const favoriteItem = { label: '$(star-full)  Favorite & Next', action: 'favorite', alwaysShow: true };
  const skipItem = { label: '$(arrow-right)  Skip & Next', action: 'skip', alwaysShow: true };
  const previousItem = { label: '$(arrow-left)  Previous Theme', action: 'previous', alwaysShow: true };
  const doneItem = { label: '$(check)  Done — Keep This Theme', action: 'done', alwaysShow: true };

  async function showCurrent() {
    changing = true;
    const theme = themes[index];
    await applyTheme(theme, false);
    changing = false;

    const favorites = getFavorites(context);
    const isFavorite = findThemeIndex(favorites, theme) >= 0;

    quickPick.items = [favoriteItem, skipItem, previousItem, doneItem];
    quickPick.title = `Review Themes  ${index + 1} / ${themes.length}`;
    quickPick.placeholder = `${isFavorite ? '★ FAVORITE' : '☆ Not favorited'}   —   ${theme}`;
    quickPick.activeItems = [isFavorite ? skipItem : favoriteItem];
  }

  async function move(direction) {
    index = (index + direction + themes.length) % themes.length;
    await showCurrent();
  }

  quickPick.onDidAccept(async () => {
    if (changing) return;
    const selected = quickPick.selectedItems[0] || quickPick.activeItems[0];
    if (!selected || !selected.action) return;

    if (selected.action === 'favorite') {
      const favorites = getFavorites(context);
      const theme = themes[index];
      if (findThemeIndex(favorites, theme) < 0) {
        favorites.push(theme);
        await saveFavorites(context, favorites);
      }
      await move(1);
      return;
    }

    if (selected.action === 'skip') {
      await move(1);
      return;
    }

    if (selected.action === 'previous') {
      await move(-1);
      return;
    }

    if (selected.action === 'done') {
      finished = true;
      quickPick.hide();
    }
  });

  quickPick.onDidHide(async () => {
    quickPick.dispose();
    if (!finished && originalTheme && !sameTheme(getCurrentTheme(), originalTheme)) {
      await applyTheme(originalTheme, false);
    }
  });

  await showCurrent();
  quickPick.show();
}


function getThemeContributions() {
  const result = [];
  for (const extension of vscode.extensions.all) {
    const contributions = extension.packageJSON && extension.packageJSON.contributes;
    const themes = contributions && Array.isArray(contributions.themes) ? contributions.themes : [];
    for (const theme of themes) {
      const name = String(theme.label || theme.id || '').trim();
      if (!name || !theme.path) continue;
      result.push({
        name,
        id: theme.id || name,
        label: theme.label || name,
        uiTheme: theme.uiTheme || 'vs-dark',
        themePath: String(theme.path),
        extensionId: extension.id,
        extensionPath: extension.extensionPath,
        extensionVersion: String(extension.packageJSON && extension.packageJSON.version || '')
      });
    }
  }
  return result;
}

async function exportFavoriteThemeBundle(context) {
  const favorites = getFavorites(context);
  if (!favorites.length) {
    vscode.window.showInformationMessage('Theme Favorites: there are no favorite themes to export.');
    return;
  }

  const allThemes = getThemeContributions();
  const matched = [];
  const missing = [];
  for (const favorite of favorites) {
    const info = allThemes.find(theme => sameTheme(theme.name, favorite));
    if (info) matched.push(info);
    else missing.push(favorite);
  }

  if (!matched.length) {
    vscode.window.showWarningMessage('Theme Favorites: none of the favorite theme files could be located.');
    return;
  }

  const uri = await vscode.window.showSaveDialog({
    title: 'Export Favorite Theme Bundle',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'theme-favorites-bundle.vsthemes')),
    filters: { 'Theme Favorites Bundle': ['vsthemes'] }
  });
  if (!uri) return;

  try {
    const files = [];
    const providers = new Map();
    for (const theme of matched) {
      let provider = providers.get(theme.extensionId);
      if (!provider) {
        const safe = safeFileName(theme.extensionId);
        provider = { safe, extensionPath: theme.extensionPath };
        providers.set(theme.extensionId, provider);
        collectFiles(theme.extensionPath, `providers/${safe}`, files);
      }
    }

    const manifest = {
      format: 1,
      exportedAt: new Date().toISOString(),
      favorites,
      missingThemeFiles: missing,
      themes: matched.map(theme => ({
        name: theme.name,
        id: theme.id,
        label: theme.label,
        uiTheme: theme.uiTheme,
        extensionId: theme.extensionId,
        extensionVersion: theme.extensionVersion,
        path: `providers/${providers.get(theme.extensionId).safe}/${normalizeZipPath(theme.themePath)}`
      }))
    };
    files.push({ name: 'theme-favorites.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

    const zip = createStoreZip(files);
    await fs.promises.writeFile(uri.fsPath, zip);
    const suffix = missing.length ? ` ${missing.length} favorite(s) had no discoverable theme file and are listed in the manifest.` : '';
    vscode.window.showInformationMessage(`Exported ${matched.length} favorite theme${matched.length === 1 ? '' : 's'} with their actual extension files.${suffix}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Theme Favorites: export failed. ${errorMessage(error)}`);
  }
}

async function importFavoriteThemeBundle(context) {
  const picks = await vscode.window.showOpenDialog({
    title: 'Import Favorite Theme Bundle',
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    filters: { 'Theme Favorites Bundle': ['vsthemes'] }
  });
  if (!picks || !picks.length) return;

  try {
    const raw = await fs.promises.readFile(picks[0].fsPath);
    const entries = readStoreZip(raw);
    const manifestEntry = entries.get('theme-favorites.json');
    if (!manifestEntry) throw new Error('Bundle does not contain theme-favorites.json.');
    const manifest = JSON.parse(manifestEntry.toString('utf8'));
    if (!manifest || manifest.format !== 1 || !Array.isArray(manifest.themes)) throw new Error('Unsupported bundle format.');

    const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
    const extensionDirName = `local.theme-favorites-imported-${digest}`;
    const extensionsRoot = path.dirname(context.extensionPath);
    const destination = path.join(extensionsRoot, extensionDirName);
    await fs.promises.rm(destination, { recursive: true, force: true });
    await fs.promises.mkdir(destination, { recursive: true });

    for (const [entryName, data] of entries) {
      if (!entryName.startsWith('providers/') || entryName.endsWith('/')) continue;
      const target = safeJoin(destination, entryName);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, data);
    }

    const contributesThemes = manifest.themes.map((theme, index) => ({
      id: theme.id || `theme-favorites-imported-${index}`,
      label: theme.label || theme.name,
      uiTheme: theme.uiTheme || 'vs-dark',
      path: `./${normalizeZipPath(theme.path)}`
    }));
    const packageJson = {
      name: `theme-favorites-imported-${digest}`,
      displayName: 'Theme Favorites Imported Pack',
      description: 'Portable themes imported by Theme Favorites.',
      version: '1.0.0',
      publisher: 'local',
      engines: { vscode: '^1.90.0' },
      categories: ['Themes'],
      contributes: { themes: contributesThemes }
    };
    await fs.promises.writeFile(path.join(destination, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');

    const importedNames = manifest.themes.map(theme => theme.label || theme.name).filter(Boolean);
    const desiredFavorites = Array.isArray(manifest.favorites) ? manifest.favorites : importedNames;
    const existing = getFavorites(context);
    for (const favorite of desiredFavorites) {
      if (findThemeIndex(existing, favorite) < 0) existing.push(favorite);
    }
    await saveFavorites(context, existing);

    const action = await vscode.window.showInformationMessage(
      `Imported ${manifest.themes.length} theme${manifest.themes.length === 1 ? '' : 's'} and restored ${desiredFavorites.length} favorite entr${desiredFavorites.length === 1 ? 'y' : 'ies'}. Reload VS Code to register the imported themes.`,
      'Reload Window'
    );
    if (action === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    vscode.window.showErrorMessage(`Theme Favorites: import failed. ${errorMessage(error)}`);
  }
}

function collectFiles(root, zipRoot, output) {
  const stack = [{ dir: root, rel: '' }];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const abs = path.join(current.dir, entry.name);
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push({ dir: abs, rel });
      else if (entry.isFile()) output.push({ name: `${zipRoot}/${normalizeZipPath(rel)}`, data: fs.readFileSync(abs) });
    }
  }
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function normalizeZipPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const base = path.resolve(root) + path.sep;
  if (target !== path.resolve(root) && !target.startsWith(base)) throw new Error(`Unsafe bundle path: ${relative}`);
  return target;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createStoreZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(normalizeZipPath(file.name), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function readStoreZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString('utf8');
    if (method !== 0) throw new Error('This bundle uses unsupported ZIP compression.');
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== uncompressedSize) throw new Error(`Corrupt bundle entry: ${name}`);
    entries.set(name, Buffer.from(data));
    offset = dataStart + compressedSize;
  }
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function getInstalledThemes() {
  const found = new Map();

  for (const extension of vscode.extensions.all) {
    const contributions = extension.packageJSON && extension.packageJSON.contributes;
    const themes = contributions && Array.isArray(contributions.themes) ? contributions.themes : [];

    for (const theme of themes) {
      const name = String(theme.label || theme.id || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!found.has(key)) found.set(key, name);
    }
  }

  return [...found.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function getCurrentTheme() {
  return vscode.workspace.getConfiguration('workbench').get('colorTheme');
}

function getFavorites(context) {
  const value = context.globalState.get(FAVORITES_KEY, []);
  return Array.isArray(value) ? [...value] : [];
}

async function saveFavorites(context, favorites) {
  await context.globalState.update(FAVORITES_KEY, favorites);
}

async function applyTheme(theme, showError = true) {
  try {
    await vscode.workspace.getConfiguration('workbench').update(
      'colorTheme',
      theme,
      vscode.ConfigurationTarget.Global
    );
    return true;
  } catch (error) {
    if (showError) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Theme Favorites: could not switch to “${theme}”. ${message}`);
    }
    return false;
  }
}

async function cycleFavorite(context, direction) {
  const favorites = getFavorites(context);
  if (!favorites.length) {
    const action = await vscode.window.showInformationMessage('No favorite themes yet.', 'Review Themes');
    if (action === 'Review Themes') await vscode.commands.executeCommand('themeFavorites.reviewThemes');
    return;
  }

  const currentTheme = getCurrentTheme();
  let index = findThemeIndex(favorites, currentTheme);
  if (index < 0) index = direction > 0 ? -1 : 0;

  const nextIndex = (index + direction + favorites.length) % favorites.length;
  await applyTheme(favorites[nextIndex]);
}

function findThemeIndex(themes, target) {
  return themes.findIndex(theme => sameTheme(theme, target));
}

function sameTheme(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function deactivate() {}

module.exports = { activate, deactivate };
