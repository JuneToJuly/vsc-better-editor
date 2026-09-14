const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

let index = [];
let indexGeneration = 0;
let rebuilding = false;
let rebuildTimer = undefined;
let output;
let fzfAvailable = undefined;

function cfg() {
  return vscode.workspace.getConfiguration('workspacePathCompletion');
}

function debug(message) {
  if (!cfg().get('debug', false)) return;
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function slash(p) {
  return p.replace(/\\/g, '/');
}

function workspaceRelative(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return slash(uri.fsPath);
  return slash(path.relative(folder.uri.fsPath, uri.fsPath));
}

function getWorkspaceRoots() {
  return (vscode.workspace.workspaceFolders || []).map(f => ({ name: f.name, uri: f.uri }));
}

function globToRegExp(glob) {
  // Deliberately small glob implementation for include/exclude filtering after findFiles.
  // Supports *, ** and ?. Paths are normalized to forward slashes.
  let s = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          s += '(?:.*/)?';
        } else {
          s += '.*';
        }
      } else {
        s += '[^/]*';
      }
    } else if (c === '?') {
      s += '[^/]';
    } else {
      s += c.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
    }
  }
  return new RegExp(s + '$', process.platform === 'win32' ? 'i' : '');
}

function compilePatterns(patterns) {
  return (patterns || []).map(p => {
    try { return globToRegExp(slash(p)); } catch { return null; }
  }).filter(Boolean);
}

function matchesAny(rel, regexes) {
  return regexes.some(r => r.test(rel));
}

function flattenExcludeObject(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => prefix + key);
}

function currentExcludePatterns() {
  const own = cfg().get('exclude', []);
  const filesExclude = flattenExcludeObject(vscode.workspace.getConfiguration('files').get('exclude', {}));
  const useSearchExclude = cfg().get('useSearchExclude', false);
  const searchExclude = useSearchExclude
    ? flattenExcludeObject(vscode.workspace.getConfiguration('search').get('exclude', {}))
    : [];
  return [...own, ...filesExclude, ...searchExclude];
}

async function rebuildIndex(reason = 'manual') {
  if (rebuilding) return;
  rebuilding = true;
  const generation = ++indexGeneration;
  const started = performance.now();
  try {
    const max = cfg().get('maxIndexedFiles', 200000);
    const includeRegex = compilePatterns(cfg().get('include', []));
    const excludeRegex = compilePatterns(currentExcludePatterns());
    const includeOnly = includeRegex.length > 0;

    const includePatterns = cfg().get('include', []);
    const searchInclude = includePatterns.length === 1
      ? includePatterns[0]
      : includePatterns.length > 1
        ? `{${includePatterns.join(',')}}`
        : '**/*';
    const excludePatterns = currentExcludePatterns();
    const searchExclude = excludePatterns.length === 1
      ? excludePatterns[0]
      : excludePatterns.length > 1
        ? `{${excludePatterns.join(',')}}`
        : undefined;

    const uris = await vscode.workspace.findFiles(searchInclude, searchExclude, max);
    if (generation !== indexGeneration) return;

    const map = new Map();
    for (const uri of uris) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) continue;
      const rel = slash(path.relative(folder.uri.fsPath, uri.fsPath));
      if (!rel || rel.startsWith('../')) continue;
      if (matchesAny(rel, excludeRegex)) continue;
      if (includeOnly && !matchesAny(rel, includeRegex)) continue;

      map.set(uri.toString(), {
        uri,
        workspaceFolder: folder,
        rel,
        basename: path.posix.basename(rel),
        dirname: path.posix.dirname(rel),
        kind: 'file'
      });
    }

    if (cfg().get('includeDirectories', true)) {
      const dirs = new Map();
      for (const entry of map.values()) {
        const parts = entry.rel.split('/');
        parts.pop();
        let acc = '';
        for (const part of parts) {
          acc = acc ? `${acc}/${part}` : part;
          const key = `${entry.workspaceFolder.uri.toString()}::${acc}`;
          if (!dirs.has(key)) {
            dirs.set(key, {
              uri: vscode.Uri.joinPath(entry.workspaceFolder.uri, ...acc.split('/')),
              workspaceFolder: entry.workspaceFolder,
              rel: acc + '/',
              basename: part + '/',
              dirname: path.posix.dirname(acc),
              kind: 'dir'
            });
          }
        }
      }
      for (const [key, dir] of dirs) map.set(`dir:${key}`, dir);
    }

    index = [...map.values()];
    debug(`index rebuilt reason=${reason} entries=${index.length} files=${uris.length} time=${(performance.now() - started).toFixed(1)}ms`);
  } catch (err) {
    output.appendLine(`Index rebuild failed: ${err && err.stack || err}`);
  } finally {
    rebuilding = false;
  }
}

function scheduleRebuild(reason, delay = 250) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = undefined;
    rebuildIndex(reason);
  }, delay);
}

function isBoundary(str, i) {
  if (i === 0) return true;
  const p = str[i - 1], c = str[i];
  if ('/\\-_. '.includes(p)) return true;
  if (/[a-z]/.test(p) && /[A-Z]/.test(c)) return true;
  if (/[A-Za-z]/.test(p) && /\d/.test(c)) return true;
  if (/\d/.test(p) && /[A-Za-z]/.test(c)) return true;
  return false;
}

function fuzzyScore(query, candidate) {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;

  let qi = 0;
  const positions = [];
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      positions.push(i);
      qi++;
    }
  }
  if (qi !== q.length) return Number.NEGATIVE_INFINITY;

  let score = q.length * 10;
  let gapRuns = 0;
  let gapChars = 0;
  let contiguous = 0;
  let boundary = 0;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (isBoundary(candidate, pos)) {
      boundary += i === 0 ? 28 : 12;
    }
    if (i > 0) {
      const gap = pos - positions[i - 1] - 1;
      if (gap === 0) contiguous += 18;
      else {
        gapRuns++;
        gapChars += gap;
      }
    }
  }

  const span = positions[positions.length - 1] - positions[0] + 1;
  const startPenalty = positions[0] * 0.2;
  const exactBonus = c === q ? 100 : 0;
  const basename = candidate.split('/').pop() || candidate;
  const baseScore = fuzzyScoreSimple(q, basename);
  const baseBonus = Number.isFinite(baseScore) ? Math.min(40, baseScore * 0.18) : 0;

  score += contiguous + boundary + exactBonus + baseBonus;
  score -= gapRuns * 12;
  score -= gapChars * 1.2;
  score -= Math.max(0, span - q.length) * 0.6;
  score -= startPenalty;
  score -= candidate.length * 0.015;
  return score;
}

function fuzzyScoreSimple(query, candidate) {
  if (!query) return 1;
  let qi = 0;
  let score = 0;
  for (let i = 0; i < candidate.length && qi < query.length; i++) {
    if (candidate[i].toLowerCase() === query[qi].toLowerCase()) {
      score += isBoundary(candidate, i) ? 8 : 2;
      qi++;
    }
  }
  return qi === query.length ? score : Number.NEGATIVE_INFINITY;
}

function normalizeTyped(raw) {
  return raw.replace(/\\\\/g, '/').replace(/\\/g, '/');
}

function stringContext(document, position) {
  const line = document.lineAt(position.line).text;
  const left = line.slice(0, position.character);

  // Find the nearest unmatched single/double quote on this line.
  let quoteIndex = -1;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < left.length; i++) {
    const ch = left[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) {
      if (ch === quote) { quote = ''; quoteIndex = -1; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoteIndex = i;
    }
  }
  if (!quote || quoteIndex < 0) return null;

  const typed = left.slice(quoteIndex + 1);
  const start = new vscode.Position(position.line, quoteIndex + 1);
  return {
    typed,
    normalizedTyped: normalizeTyped(typed),
    range: new vscode.Range(start, position),
    line,
    beforeString: line.slice(0, quoteIndex)
  };
}

function javaApiMode(document, context) {
  if (document.languageId !== 'java') return 'generic';
  const b = context.beforeString;

  // ClassLoader resource names never start with '/'. Check this before the
  // broader getResource/getResourceAsStream match.
  if (/(?:getClassLoader\s*\(\s*\)|classLoader\b)[\s\S]*?\.\s*(?:getResource|getResourceAsStream)\s*\(\s*$/i.test(b)) {
    return 'classloader-resource';
  }
  if (/\.\s*(?:getResource|getResourceAsStream)\s*\(\s*$/.test(b)) {
    return 'class-resource';
  }
  if (/(?:new\s+File|Path\.of|Paths\.get)\s*\(\s*$/.test(b)) {
    return 'filesystem';
  }
  return 'generic';
}

let resourceRootCacheKey = '';
let resourceRootRegexes = [];

function configuredResourceRootRegexes() {
  const patterns = cfg().get('resourceRoots', [
    '**/src/main/resources',
    '**/src/test/resources'
  ]);
  const key = JSON.stringify(patterns);
  if (key !== resourceRootCacheKey) {
    resourceRootCacheKey = key;
    resourceRootRegexes = compilePatterns(patterns.map(p => slash(p).replace(/\/$/, '')));
  }
  return resourceRootRegexes;
}

function resourcePathForEntry(entry) {
  const rel = slash(entry.rel).replace(/\/$/, '');
  if (!rel) return null;
  const parts = rel.split('/');
  const regexes = configuredResourceRootRegexes();

  // Test each directory prefix against the configured resource-root globs.
  // This supports multi-project workspaces such as service-a/src/main/resources.
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (!matchesAny(prefix, regexes)) continue;
    let resource = parts.slice(i).join('/');
    if (!resource) return null;
    if (entry.kind === 'dir' && !resource.endsWith('/')) resource += '/';
    return resource;
  }
  return null;
}

function absolutePathForEntry(entry) {
  let absolute = slash(entry.uri.fsPath);
  if (entry.kind === 'dir' && !absolute.endsWith('/')) absolute += '/';
  return absolute;
}

function javaCandidateForms(entry, apiMode) {
  const forms = [];
  const resource = cfg().get('javaResourceAwareness', true) ? resourcePathForEntry(entry) : null;
  const absolute = absolutePathForEntry(entry);

  if (resource) {
    let resourceText;
    let weight;
    if (apiMode === 'classloader-resource') {
      resourceText = resource;
      weight = 100;
    } else {
      // Class.getResource uses '/' for a classpath-root-relative resource. For
      // generic strings we prefer that explicit root form as the safest Java
      // resource representation.
      resourceText = '/' + resource;
      weight = apiMode === 'class-resource' ? 100 : 75;
    }
    forms.push({
      text: resourceText,
      weight,
      semantic: 'Resource',
      label: resourceText,
      description: apiMode === 'classloader-resource' ? 'Resource • ClassLoader' : 'Resource'
    });
  }

  // Filesystem APIs should rank absolute paths first. Resource APIs still show
  // the absolute form as an escape hatch, but clearly below the resource name.
  const absoluteWeight = apiMode === 'filesystem' ? 100
    : (apiMode === 'class-resource' || apiMode === 'classloader-resource') ? 20
      : resource ? 55 : 85;
  forms.push({
    text: absolute,
    weight: absoluteWeight,
    semantic: 'Absolute',
    label: absolute,
    description: 'Absolute'
  });

  return forms;
}

function nonJavaCandidateForms(entry, document) {
  const forms = [];
  const rel = entry.rel;
  forms.push({ text: rel, weight: 35, label: rel, semantic: 'Workspace', description: 'Workspace' });

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder && folder.uri.toString() === entry.workspaceFolder.uri.toString()) {
    const currentDir = path.dirname(document.uri.fsPath);
    let relative = slash(path.relative(currentDir, entry.uri.fsPath));
    if (entry.kind === 'dir' && !relative.endsWith('/')) relative += '/';
    if (relative && relative !== '.') {
      const preferRelative = cfg().get('preferRelativeToCurrentFile', true);
      forms.push({ text: relative, weight: preferRelative ? 50 : 20, label: relative, semantic: 'Relative', description: 'Relative' });
    }
  }

  if ((vscode.workspace.workspaceFolders || []).length > 1) {
    const text = `${entry.workspaceFolder.name}/${rel}`;
    forms.push({ text, weight: 10, label: text, semantic: 'Workspace', description: entry.workspaceFolder.name });
  }
  return forms;
}

function candidateForms(entry, document, apiMode) {
  const forms = document.languageId === 'java'
    ? javaCandidateForms(entry, apiMode)
    : nonJavaCandidateForms(entry, document);

  const dedupe = new Map();
  for (const f of forms) {
    const prev = dedupe.get(f.text);
    if (!prev || prev.weight < f.weight) dedupe.set(f.text, f);
  }
  return [...dedupe.values()];
}


function compactParentPath(entry, maxChars = 44) {
  let parent = slash(path.dirname(entry.uri.fsPath));
  if (!parent || parent === '.' || parent === '/') return '';

  const parts = parent.split('/').filter(Boolean);
  if (!parts.length) return parent;

  // Keep the most useful information visible: the directories nearest the file.
  // Build from the end until the hint reaches the desired width, then prefix an ellipsis.
  const kept = [];
  let length = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const nextLength = length + part.length + (kept.length ? 1 : 0);
    if (kept.length && nextLength > maxChars) break;
    kept.unshift(part);
    length = nextLength;
  }

  let result = kept.join('/');
  if (kept.length < parts.length) result = `…/${result}`;
  return result ? `${result}/` : '';
}

function completionPresentation(candidate) {
  if (candidate.semantic === 'Absolute') {
    // Keep the natural path reading order while avoiding the useless long prefix:
    //   …/nearest/parent/file.ext
    // The full absolute path remains candidate.text and is what gets inserted.
    const parent = compactParentPath(candidate.entry);
    return {
      label: `${parent}${candidate.entry.basename}`,
      labelDetail: '',
      description: 'Absolute'
    };
  }

  if (candidate.semantic === 'Resource') {
    return {
      label: candidate.text,
      labelDetail: '',
      description: candidate.description || 'Resource'
    };
  }

  return {
    label: candidate.label || candidate.text,
    labelDetail: '',
    description: candidate.description || candidate.semantic
  };
}

function checkFzfAvailable() {
  if (fzfAvailable !== undefined) return fzfAvailable;
  const exe = cfg().get('fzfPath', 'fzf');
  try {
    const result = cp.spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 500 });
    fzfAvailable = result.status === 0;
  } catch {
    fzfAvailable = false;
  }
  debug(`fzf available=${fzfAvailable}`);
  return fzfAvailable;
}

function rankWithFzf(query, candidates, limit) {
  if (!query || !candidates.length) return null;
  const exe = cfg().get('fzfPath', 'fzf');
  // Use numeric IDs so duplicate path forms remain safe and output parsing is trivial.
  const input = candidates.map((c, i) => `${i}\t${c.text}`).join('\n');
  try {
    const result = cp.spawnSync(exe, [
      '--filter', query,
      '--no-sort',
      '--tiebreak=begin,length,index',
      '--delimiter=\t',
      '--with-nth=2..'
    ], {
      input,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 1000,
      windowsHide: true
    });
    if (result.error) return null;
    const rows = (result.stdout || '').split(/\r?\n/).filter(Boolean).slice(0, limit);
    const ranked = [];
    for (const row of rows) {
      const tab = row.indexOf('\t');
      const id = Number(tab >= 0 ? row.slice(0, tab) : row);
      if (Number.isInteger(id) && candidates[id]) ranked.push(candidates[id]);
    }
    return ranked;
  } catch {
    return null;
  }
}

async function provideCompletionItems(document, position, token) {
  const settings = cfg();
  if (!settings.get('enabled', true)) return undefined;
  const languages = settings.get('languages', []);
  if (languages.length && !languages.includes(document.languageId)) return undefined;

  const context = stringContext(document, position);
  if (!context) return undefined;
  if (token.isCancellationRequested) return undefined;

  const started = performance.now();
  const apiMode = javaApiMode(document, context);
  const query = context.normalizedTyped;
  const maxResults = settings.get('maxResults', 60);

  let candidates = [];
  for (const entry of index) {
    for (const form of candidateForms(entry, document, apiMode)) {
      candidates.push({ entry, ...form });
    }
  }

  // Strongly prefer candidates that share the typed path prefix. Fuzzy matching remains available.
  for (const c of candidates) {
    const lower = c.text.toLowerCase();
    const q = query.toLowerCase();
    c.prefixBonus = q && lower.startsWith(q) ? 120 : 0;
  }

  let ranked;
  const backend = settings.get('rankingBackend', 'auto');
  const useFzf = (backend === 'fzf' || (backend === 'auto' && candidates.length >= settings.get('fzfMinCandidates', 100))) && checkFzfAvailable();

  if (useFzf) {
    const fzfRanked = rankWithFzf(query, candidates, Math.max(maxResults * 4, maxResults));
    if (fzfRanked) {
      // Re-score the fzf-filtered set so our path/domain weighting still applies.
      ranked = fzfRanked.map(c => ({ c, score: fuzzyScore(query, c.text) + c.weight + c.prefixBonus }))
        .filter(x => Number.isFinite(x.score))
        .sort((a, b) => b.score - a.score || a.c.text.length - b.c.text.length || a.c.text.localeCompare(b.c.text))
        .slice(0, maxResults)
        .map(x => x.c);
    }
  }

  if (!ranked) {
    ranked = candidates.map(c => ({ c, score: fuzzyScore(query, c.text) + c.weight + c.prefixBonus }))
      .filter(x => Number.isFinite(x.score))
      .sort((a, b) => b.score - a.score || a.c.text.length - b.c.text.length || a.c.text.localeCompare(b.c.text))
      .slice(0, maxResults)
      .map(x => x.c);
  }

  const seen = new Set();
  const items = [];
  for (let i = 0; i < ranked.length; i++) {
    const c = ranked[i];
    if (seen.has(c.text)) continue;
    seen.add(c.text);

    const presentation = completionPresentation(c);
    const item = new vscode.CompletionItem(
      {
        label: presentation.label,
        detail: presentation.labelDetail,
        description: presentation.description
      },
      c.entry.kind === 'dir' ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
    );
    // The visible label is intentionally concise. The inserted value remains the
    // full runtime-meaningful path (absolute filesystem path or resource path).
    item.insertText = c.text;
    item.range = context.range;
    item.filterText = `${c.text} ${c.entry.basename} ${c.entry.rel}`;
    item.sortText = String(i).padStart(5, '0');
    item.detail = `${c.semantic} • ${c.entry.kind === 'dir' ? 'Directory' : 'File'} • ${c.entry.workspaceFolder.name}`;
    item.documentation = new vscode.MarkdownString(`**${c.semantic}**\n\nWorkspace file: \`${c.entry.rel}\``);
    if (c.entry.kind === 'dir') {
      // Keep the completion UI open after accepting a directory.
      item.command = { command: 'editor.action.triggerSuggest', title: 'Continue path completion' };
    }
    items.push(item);
  }

  debug(`complete lang=${document.languageId} query=${JSON.stringify(query)} candidates=${candidates.length} returned=${items.length} apiMode=${apiMode} backend=${useFzf ? 'fzf' : 'internal'} time=${(performance.now() - started).toFixed(1)}ms`);
  return items;
}

function activate(context) {
  output = vscode.window.createOutputChannel('Workspace Path Completion');
  context.subscriptions.push(output);

  const selector = { scheme: 'file' };
  // Trigger directly on normal path/query characters so completion works even when
  // editor.quickSuggestions.strings is disabled (the common VS Code default).
  const triggerCharacters = [
    ...'abcdefghijklmnopqrstuvwxyz',
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ...'0123456789',
    '/', '\\', '.', '-', '_', '@', '~'
  ];
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    selector,
    { provideCompletionItems },
    ...triggerCharacters
  ));

  context.subscriptions.push(vscode.commands.registerCommand('workspacePathCompletion.rebuildIndex', async () => {
    await rebuildIndex('command');
    vscode.window.showInformationMessage(`Workspace Path Completion indexed ${index.length} entries.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('workspacePathCompletion.showStats', () => {
    const files = index.filter(x => x.kind === 'file').length;
    const dirs = index.length - files;
    vscode.window.showInformationMessage(`Workspace Path Completion: ${files} files, ${dirs} directories, fzf=${checkFzfAvailable() ? 'available' : 'not found'}.`);
  }));

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate(() => scheduleRebuild('create', 400));
  watcher.onDidDelete(() => scheduleRebuild('delete', 400));
  context.subscriptions.push(watcher);

  context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => scheduleRebuild('rename', 250)));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRebuild('workspace-folders', 100)));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (
      e.affectsConfiguration('workspacePathCompletion') ||
      e.affectsConfiguration('files.exclude') ||
      (cfg().get('useSearchExclude', false) && e.affectsConfiguration('search.exclude'))
    ) {
      fzfAvailable = undefined;
      scheduleRebuild('configuration', 100);
    }
  }));

  rebuildIndex('activate');
}

function deactivate() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
}

module.exports = { activate, deactivate };
