const vscode = require('vscode');

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

  context.subscriptions.push(review, toggle, pick, next, previous, manage);
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
