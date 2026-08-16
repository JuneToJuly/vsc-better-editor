const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const util = require('util');

const execFile = util.promisify(cp.execFile);

let muralPanel;
let lastState;
let providerRegistration;

function activate(context) {
  const provider = new BaseDocumentProvider();
  providerRegistration = vscode.workspace.registerTextDocumentContentProvider('code-diff-mural-base', provider);
  context.subscriptions.push(providerRegistration);

  context.subscriptions.push(vscode.commands.registerCommand('codeDiffMural.compareAgainst', async () => {
    try {
      const repo = await chooseRepository();
      if (!repo) return;
      const target = await currentBranchOrHead(repo);
      const base = await chooseRef(repo, {
        side: 'base',
        otherRef: target,
        placeHolder: `Compare ${target} against…`
      });
      if (!base) return;
      await showMural(repo, base, target);
    } catch (err) {
      vscode.window.showErrorMessage(`Code Diff Mural: ${friendlyError(err)}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeDiffMural.refresh', async () => {
    if (!lastState) {
      return vscode.commands.executeCommand('codeDiffMural.compareAgainst');
    }
    try {
      await showMural(lastState.repo, lastState.base, lastState.target, true);
    } catch (err) {
      vscode.window.showErrorMessage(`Code Diff Mural: ${friendlyError(err)}`);
    }
  }));
}

function deactivate() {}

class BaseDocumentProvider {
  async provideTextDocumentContent(uri) {
    const params = new URLSearchParams(uri.query);
    const repo = params.get('repo');
    const ref = params.get('ref');
    const file = params.get('file');
    if (!repo || !ref || !file) return '';
    try {
      return await git(repo, ['show', `${ref}:${file}`], { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      return `Unable to load ${file} at ${ref}\n\n${friendlyError(err)}`;
    }
  }
}

async function discoverRepositories() {
  const found = new Map();
  const add = root => {
    if (!root) return;
    const normalized = normalizePath(path.resolve(root));
    if (!found.has(normalized)) {
      found.set(normalized, { label: path.basename(root), description: root, root });
    }
  };

  // Prefer VS Code's built-in Git repository discovery. This sees repositories
  // nested inside a multi-root workspace instead of assuming each workspace
  // folder is itself the repository.
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
      if (!gitExtension.isActive) await gitExtension.activate();
      const api = gitExtension.exports?.getAPI?.(1);
      for (const repo of api?.repositories || []) add(repo.rootUri.fsPath);
    }
  } catch (_) {}

  // The active editor is the strongest signal in a workspace containing many
  // repos. Ask Git directly from that file's directory as a fallback and so a
  // repo is available even before the built-in Git extension has discovered it.
  const activeUri = vscode.window.activeTextEditor?.document?.uri;
  if (activeUri?.scheme === 'file') {
    try {
      add((await git(path.dirname(activeUri.fsPath), ['rev-parse', '--show-toplevel'])).trim());
    } catch (_) {}
  }

  for (const folder of vscode.workspace.workspaceFolders || []) {
    try {
      add((await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim());
    } catch (_) {}
  }

  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function chooseRepository(preferActive = true) {
  const repos = await discoverRepositories();
  if (!repos.length) {
    vscode.window.showErrorMessage('No Git repository found in the workspace.');
    return undefined;
  }

  if (preferActive) {
    const activeUri = vscode.window.activeTextEditor?.document?.uri;
    if (activeUri?.scheme === 'file') {
      const activePath = normalizePath(activeUri.fsPath);
      // Deepest matching repository wins if repositories are nested.
      const matching = repos
        .filter(r => isPathInside(activePath, normalizePath(r.root)))
        .sort((a, b) => b.root.length - a.root.length);
      if (matching.length) return matching[0].root;
    }
    if (repos.length === 1) return repos[0].root;
  }

  const picked = await vscode.window.showQuickPick(
    repos.map(r => ({ ...r, detail: 'Git repository' })),
    { placeHolder: 'Choose the Git repository to compare', matchOnDescription: true }
  );
  return picked?.root;
}

async function currentBranchOrHead(repo) {
  try {
    const branch = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    if (branch) return branch;
  } catch (_) {}
  return (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim();
}

async function chooseRef(repo, options = {}) {
  const [branchesRaw, tagsRaw, commitsRaw, current] = await Promise.all([
    git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
    git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/tags']),
    git(repo, ['log', '-30', '--pretty=format:%h%x09%s']),
    currentBranchOrHead(repo)
  ]);

  const excluded = new Set([options.otherRef].filter(Boolean));
  const items = [
    { label: '$(edit) Enter commit / branch / tag…', kind: 'input', alwaysShow: true },
    ...uniqueLines(branchesRaw)
      .filter(ref => ref !== 'origin/HEAD' && !excluded.has(ref))
      .map(ref => ({
        label: `$(git-branch) ${ref}`,
        description: ref === current ? 'current branch' : 'branch',
        ref
      })),
    ...uniqueLines(tagsRaw)
      .filter(ref => !excluded.has(ref))
      .map(ref => ({ label: `$(tag) ${ref}`, description: 'tag', ref })),
    ...commitsRaw.split(/\r?\n/).filter(Boolean).map(line => {
      const [hash, ...rest] = line.split('\t');
      return { label: `$(git-commit) ${hash}`, description: rest.join('\t'), ref: hash };
    }).filter(item => !excluded.has(item.ref))
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: options.placeHolder || (options.side === 'target' ? 'Choose the newer / target revision' : 'Choose the older / base revision'),
    matchOnDescription: true
  });
  if (!picked) return undefined;

  let ref = picked.ref;
  if (picked.kind === 'input') {
    ref = await vscode.window.showInputBox({
      prompt: options.side === 'target' ? 'Target Git commit, branch, tag, or revision' : 'Base Git commit, branch, tag, or revision',
      placeHolder: 'origin/main, feature/my-branch, HEAD~5, a1b2c3d…',
      validateInput: async value => {
        if (!value.trim()) return 'Enter a Git revision';
        if (excluded.has(value.trim())) return 'Choose a revision different from the other side of the comparison';
        try {
          await git(repo, ['rev-parse', '--verify', `${value.trim()}^{commit}`]);
          return undefined;
        } catch (_) {
          return `Git cannot resolve “${value.trim()}”`;
        }
      }
    });
  }
  if (!ref) return undefined;
  ref = ref.trim();
  if (excluded.has(ref)) {
    vscode.window.showInformationMessage('Choose two different revisions for the mural.');
    return undefined;
  }

  await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return ref;
}

async function showMural(repo, base, target, preserveView = false) {
  const [diffText, targetHash, baseHash] = await Promise.all([
    git(repo, ['diff', '--find-renames', '--find-copies', '--no-ext-diff', '--no-color', '--unified=3', base, target, '--'], { maxBuffer: 128 * 1024 * 1024 }),
    git(repo, ['rev-parse', '--short', target]),
    git(repo, ['rev-parse', '--short', base])
  ]);

  const model = parseDiff(diffText);
  const summary = summarize(model);
  lastState = { repo, base, target };

  if (!muralPanel) {
    muralPanel = vscode.window.createWebviewPanel(
      'codeDiffMural',
      'Code Diff Mural',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    muralPanel.onDidDispose(() => { muralPanel = undefined; });
    muralPanel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'chooseRepo') {
          const nextRepo = await chooseRepository(false);
          if (nextRepo) {
            const nextTarget = await currentBranchOrHead(nextRepo);
            const nextBase = await chooseRef(nextRepo, { side:'base', otherRef:nextTarget, placeHolder:`Compare ${nextTarget} against…` });
            if (nextBase) await showMural(nextRepo, nextBase, nextTarget);
          }
        } else if (message.type === 'chooseBase') {
          const next = await chooseRef(lastState.repo, { side:'base', otherRef:lastState.target });
          if (next) await showMural(lastState.repo, next, lastState.target);
        } else if (message.type === 'chooseTarget') {
          const next = await chooseRef(lastState.repo, { side:'target', otherRef:lastState.base });
          if (next) await showMural(lastState.repo, lastState.base, next);
        } else if (message.type === 'refresh') {
          await showMural(lastState.repo, lastState.base, lastState.target, true);
        } else if (message.type === 'openFile') {
          await openTargetFile(lastState.repo, lastState.target, message.file, message.line || 1);
        } else if (message.type === 'openDiff') {
          await openFileDiff(lastState.repo, lastState.base, lastState.target, message.file, message.oldFile, message.line || 1, message.status);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Code Diff Mural: ${friendlyError(err)}`);
      }
    });
  } else {
    muralPanel.reveal(vscode.ViewColumn.One, true);
  }

  muralPanel.title = `Diff Mural: ${base} ↔ ${target}`;
  muralPanel.webview.html = renderHtml({
    model,
    summary,
    repoName: path.basename(repo),
    repo,
    base,
    baseHash: baseHash.trim(),
    target,
    targetHash: targetHash.trim(),
    nonce: nonce(),
    preserveView,
    minZoom: vscode.workspace.getConfiguration('codeDiffMural').get('minZoom', 10),
    maxZoom: vscode.workspace.getConfiguration('codeDiffMural').get('maxZoom', 44)
  });
}

async function refDocumentUri(repo, ref, file) {
  return vscode.Uri.parse(`code-diff-mural-base:/${encodeURIComponent(path.basename(file))}?${new URLSearchParams({ repo, ref, file }).toString()}`);
}

async function refResolvesToHead(repo, ref) {
  const [refHash, headHash] = await Promise.all([
    git(repo, ['rev-parse', `${ref}^{commit}`]),
    git(repo, ['rev-parse', 'HEAD'])
  ]);
  return refHash.trim() === headHash.trim();
}

async function openTargetFile(repo, target, file, line) {
  const p = new vscode.Position(Math.max(0, line - 1), 0);
  const currentPath = path.join(repo, file);
  let editor;

  // When the target is the checked-out commit, use the real workspace file so
  // normal navigation/editing still works. Otherwise open the branch snapshot
  // through the read-only Git document provider.
  if (fs.existsSync(currentPath) && await refResolvesToHead(repo, target)) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(currentPath));
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  } else {
    const doc = await vscode.workspace.openTextDocument(await refDocumentUri(repo, target, file));
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  }
  editor.selection = new vscode.Selection(p, p);
  editor.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
}

async function openFileDiff(repo, base, target, file, oldFile, line, status) {
  const basePath = oldFile || file;
  const baseUri = await refDocumentUri(repo, base, basePath);
  const targetPath = path.join(repo, file);
  let targetUri;

  if (status !== 'deleted' && fs.existsSync(targetPath) && await refResolvesToHead(repo, target)) {
    targetUri = vscode.Uri.file(targetPath);
  } else if (status !== 'deleted') {
    targetUri = await refDocumentUri(repo, target, file);
  }

  if (!targetUri) {
    const doc = await vscode.workspace.openTextDocument(baseUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const p = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(p, p);
    editor.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
    return;
  }

  await vscode.commands.executeCommand('vscode.diff', baseUri, targetUri, `${basePath} (${base}) ↔ ${file} (${target})`, { preview: false });
}

async function git(cwd, args, options = {}) {
  const { stdout } = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024
  });
  return stdout;
}

function parseDiff(text) {
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const files = [];
  let file = null;
  let hunk = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      if (file) files.push(file);
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      file = {
        oldPath: m ? m[1] : '',
        path: m ? m[2] : '',
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
        binary: false
      };
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('new file mode ')) file.status = 'added';
    else if (line.startsWith('deleted file mode ')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length);
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true;
    } else if (line.startsWith('@@ ')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      hunk = {
        header: line,
        oldStart: hm ? Number(hm[1]) : 1,
        oldCount: hm ? Number(hm[2] || 1) : 1,
        newStart: hm ? Number(hm[3]) : 1,
        newCount: hm ? Number(hm[4] || 1) : 1,
        context: hm ? hm[5].trim() : '',
        lines: [],
        additions: 0,
        deletions: 0,
        _oldLine: hm ? Number(hm[1]) : 1,
        _newLine: hm ? Number(hm[3]) : 1
      };
      file.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        hunk.additions++; file.additions++;
        hunk.lines.push({ type: 'add', text: line.slice(1), oldLine: null, newLine: hunk._newLine++ });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        hunk.deletions++; file.deletions++;
        hunk.lines.push({ type: 'del', text: line.slice(1), oldLine: hunk._oldLine++, newLine: null });
      } else if (line.startsWith(' ')) {
        hunk.lines.push({ type: 'ctx', text: line.slice(1), oldLine: hunk._oldLine++, newLine: hunk._newLine++ });
      } else if (line === '\\ No newline at end of file') {
        hunk.lines.push({ type: 'meta', text: line, oldLine: null, newLine: null });
      }
    }
  }
  if (file) files.push(file);

  return files.filter(f => f.hunks.length || f.binary || f.status !== 'modified').map(f => {
    f.packageName = packageFor(f.path);
    f.fileName = path.basename(f.path);
    return f;
  });
}

function packageFor(filePath) {
  const dir = path.posix.dirname(filePath.replace(/\\/g, '/'));
  const parts = dir.split('/').filter(Boolean);
  const markers = ['java', 'kotlin', 'scala', 'groovy', 'src'];
  let start = -1;
  for (let i = 0; i < parts.length; i++) {
    if (markers.includes(parts[i]) && parts[i + 1]) start = i + 1;
  }
  const pkgParts = start >= 0 ? parts.slice(start) : parts;
  return pkgParts.length ? pkgParts.join('.') : '(root)';
}

function summarize(files) {
  let additions = 0, deletions = 0, hunks = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
    hunks += file.hunks.length;
  }
  return { files: files.length, additions, deletions, hunks };
}

function renderHtml(data) {
  const groups = groupBy(data.model, f => f.packageName);
  const packages = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Size each package around the code it actually contains.  The previous
  // fixed two-column package grid left a large empty half when a package only
  // contained one changed file, while narrow file cards clipped ordinary Java
  // lines.  Estimate an editor-like width from the longest displayed line and
  // cap it so pathological generated/minified lines cannot create a mile-wide
  // mural.
  function editorWidthFor(file) {
    let longest = Math.max(file.fileName.length, file.path.length);
    for (const h of file.hunks || []) {
      for (const line of h.lines || []) longest = Math.max(longest, (line.text || '').length);
    }
    const editorChars = Math.max(96, Math.min(168, longest + 8));
    return Math.max(900, Math.min(1500, 126 + editorChars * 8.15));
  }

  const packageHtml = packages.map(([pkg, files], pkgIndex) => {
    files = files.sort((a, b) => a.path.localeCompare(b.path));
    const fileWidth = Math.max(...files.map(editorWidthFor), 900);
    const fileCols = files.length === 1 ? 1 : 2;
    const packageWidth = (fileCols * fileWidth) + ((fileCols - 1) * 12) + 24;
    const filesHtml = files.map((f, fileIndex) => {
      const hunks = f.hunks.length ? f.hunks : [{ header: f.binary ? 'Binary file changed' : 'File metadata changed', newStart: 1, oldStart: 1, additions: f.additions, deletions: f.deletions, lines: [] }];
      const hunkHtml = hunks.map((h, hunkIndex) => {
        const changeWeight = Math.max(1, h.additions + h.deletions);
        const sizeClass = changeWeight > 35 ? 'xl' : changeWeight > 16 ? 'lg' : changeWeight > 6 ? 'md' : 'sm';
        const code = renderHunkLines(h.lines, f.path);
        const tone = h.additions && h.deletions ? 'mixed' : h.additions ? 'added' : h.deletions ? 'deleted' : 'meta';
        const start = h.newStart || h.oldStart || 1;
        const count = Math.max(h.newCount || 0, h.oldCount || 0, 1);
        const end = start + count - 1;
        const rangeLabel = count > 1 ? `Lines ${start}–${end}` : `Line ${start}`;
        const contextLabel = h.context || '';
        const titleLabel = contextLabel ? `${rangeLabel} · ${contextLabel}` : rangeLabel;
        return `<div class="hunk ${tone} ${sizeClass}" data-file="${escapeAttr(f.path)}" data-old-file="${escapeAttr(f.oldPath || f.path)}" data-line="${h.newStart || h.oldStart || 1}" data-status="${f.status}" tabindex="0" title="${escapeAttr(f.path)} — ${escapeAttr(titleLabel)}">
          <div class="hunk-summary"><span class="hunk-label"><span class="hunk-range">${escapeHtml(rangeLabel)}</span>${contextLabel ? `<span class="hunk-context">${escapeHtml(contextLabel)}</span>` : ''}</span><span class="counts"><b>+${h.additions}</b> <i>−${h.deletions}</i></span></div>
          <div class="source-wrap">
            <div class="overview-hint"><strong>${changeWeight} line${changeWeight === 1 ? '' : 's'} changed</strong><span><b>+${h.additions}</b> <i>−${h.deletions}</i></span></div>
            <div class="source">${code || `<div class="line meta"><span class="sign">·</span><span>${escapeHtml(h.header)}</span></div>`}</div>
          </div>
        </div>`;
      }).join('');
      return `<section class="file status-${f.status}" data-file-container="${escapeAttr(f.path)}" data-file="${escapeAttr(f.path)}" data-old-file="${escapeAttr(f.oldPath || f.path)}" data-status="${f.status}">
        <header class="file-header">
          <span class="file-title">${escapeHtml(f.fileName)}</span>
          <span class="file-actions"><button class="file-action" data-action="open-file" title="Open target file">Open</button><button class="file-action" data-action="open-diff" title="Open side-by-side diff">Diff</button></span>
          <span class="file-counts">+${f.additions} −${f.deletions}</span>
        </header>
        <div class="file-path">${escapeHtml(f.path)}</div>
        <div class="hunks">${hunkHtml}</div>
      </section>`;
    }).join('');

    return `<section class="package" data-package="${escapeAttr(pkg)}" style="--pkg-order:${pkgIndex}; --file-width:${Math.round(fileWidth)}px; --file-cols:${fileCols}; width:${Math.round(packageWidth)}px">
      <header class="package-header" title="Drag to reorganize this package"><span class="drag-grip">⠿</span><span class="package-name">${escapeHtml(pkg)}</span><span class="package-count">${files.length} file${files.length === 1 ? '' : 's'}</span></header>
      <div class="package-files">${filesHtml}</div>
    </section>`;
  }).join('');

  const stateScript = data.preserveView ? `const remembered = vscode.getState() || {}; if (remembered.scale) { scale = remembered.scale; tx = remembered.tx || 0; ty = remembered.ty || 0; }` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${data.nonce}';">
<title>Code Diff Mural</title>
<style>
:root { color-scheme: dark; --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --muted: var(--vscode-descriptionForeground); --border: var(--vscode-panel-border); --panel: var(--vscode-sideBar-background); --hover: var(--vscode-list-hoverBackground); --accent: var(--vscode-focusBorder); --add: #2d7d46; --del: #a84743; --mix: #9b6a22; --neutral: #53606d; }
* { box-sizing: border-box; }
html, body { width:100%; height:100%; margin:0; overflow:hidden; background:var(--bg); color:var(--fg); font-family:var(--vscode-font-family); font-size:12px; }
#toolbar { height:44px; display:flex; align-items:center; gap:10px; padding:0 12px; border-bottom:1px solid var(--border); background:var(--panel); position:relative; z-index:10; }
.brand { font-weight:700; letter-spacing:.04em; margin-right:8px; }
.pill { border:1px solid var(--border); border-radius:5px; padding:5px 8px; color:var(--muted); white-space:nowrap; }
.pill strong { color:var(--fg); }
.stat.add { color:#81c995; } .stat.del { color:#ef8b87; }
button, input { font:inherit; }
button { border:1px solid var(--vscode-button-border, transparent); background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); border-radius:4px; padding:6px 9px; cursor:pointer; }
button:hover { background:var(--vscode-button-secondaryHoverBackground); }
.spacer { flex:1; }
#search { width:240px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--border)); outline:none; padding:6px 8px; border-radius:4px; }
.search-wrap { position:relative; display:flex; align-items:center; gap:7px; }
#searchStatus { min-width:62px; color:var(--muted); font-size:11px; white-space:nowrap; }
#searchStatus.no-match { color:var(--vscode-errorForeground, #f48771); }
#viewport { position:absolute; left:0; right:0; top:44px; bottom:0; overflow:hidden; cursor:grab; background-image:radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--muted) 22%, transparent) 1px, transparent 0); background-size:24px 24px; }
#viewport.dragging { cursor:grabbing; }
#world { --label-boost:1; transform-origin:0 0; position:absolute; left:0; top:0; padding:90px; width:4600px; display:flex; flex-wrap:wrap; gap:72px 80px; align-content:flex-start; align-items:flex-start; will-change:transform; }
.package { flex:0 0 auto; border:1px solid color-mix(in srgb, var(--border) 75%, transparent); background:color-mix(in srgb, var(--panel) 55%, transparent); border-radius:10px; padding:12px; box-shadow:0 10px 30px rgba(0,0,0,.12); }
.package.user-placed { box-shadow:0 12px 34px rgba(0,0,0,.18), 0 0 0 1px color-mix(in srgb,var(--accent) 35%,transparent); }
.package-header { display:flex; align-items:center; gap:8px; font-weight:700; font-size:15px; padding:2px 4px 10px; color:var(--fg); cursor:move; user-select:none; }
.package-name { transform:scale(var(--label-boost)); transform-origin:left center; }
.drag-grip { color:var(--muted); opacity:.55; font-size:13px; }
.package-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.package-count { margin-left:auto; font-size:11px; font-weight:400; color:var(--muted); white-space:nowrap; }
.package-files { display:grid; grid-template-columns:repeat(var(--file-cols), var(--file-width)); gap:12px; align-items:start; width:max-content; }
.file { width:var(--file-width); border:1px solid var(--border); border-radius:7px; overflow:hidden; background:var(--vscode-editor-background); min-width:0; }
.file-header { display:flex; justify-content:space-between; gap:8px; padding:7px 9px 4px; font-weight:700; white-space:nowrap; overflow:hidden; }
.file-header span:first-child { text-overflow:ellipsis; overflow:hidden; transform:scale(var(--label-boost)); transform-origin:left center; }
.file-header { justify-content:flex-start; }
.file-title { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.file-actions { display:flex; gap:4px; opacity:0; pointer-events:none; flex:0 0 auto; }
.file:hover .file-actions, .file:focus-within .file-actions { opacity:1; pointer-events:auto; }
.file-action { padding:2px 6px; font-size:10px; line-height:1.2; }
.file-counts { margin-left:auto; flex:0 0 auto; }
.file-counts { font-weight:400; color:var(--muted); }
.file-path { padding:0 9px 7px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:10px; }
.hunks { display:flex; flex-direction:column; gap:5px; padding:0 6px 6px; }
.hunk { position:relative; border:1px solid color-mix(in srgb, var(--border) 82%, transparent); border-radius:4px; overflow:hidden; min-height:26px; cursor:pointer; background:var(--vscode-editor-background); }
/* Hunk containers are intentionally neutral. Diff meaning belongs to the changed lines,
   not the card border/header, so mixed hunks never look like an all-green/all-red change. */
.hunk.added, .hunk.deleted, .hunk.mixed, .hunk.meta { border-color:color-mix(in srgb, var(--border) 82%, transparent); background:var(--vscode-editor-background); }
.hunk:hover { border-color:color-mix(in srgb, var(--accent) 55%, var(--border)); }
.hunk.selected, .hunk.auto-focus { outline:2px solid var(--accent); outline-offset:1px; }
.hunk-summary { display:flex; justify-content:space-between; gap:8px; align-items:center; min-height:26px; padding:4px 7px; color:var(--muted); background:var(--vscode-editorGroupHeader-tabsBackground, var(--panel)); border-bottom:1px solid color-mix(in srgb, var(--border) 65%, transparent); }
.hunk-label { display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden; white-space:nowrap; }
.hunk-range { flex:0 0 auto; font-weight:600; color:var(--muted); }
.hunk-context { min-width:0; overflow:hidden; text-overflow:ellipsis; color:var(--fg); opacity:.82; }
.counts { white-space:nowrap; color:var(--muted); } .counts b { color:var(--vscode-gitDecoration-addedResourceForeground, #81c995); } .counts i { color:var(--vscode-gitDecoration-deletedResourceForeground, #ef8b87); font-style:normal; }
.hunk.sm { min-height:28px; } .hunk.md { min-height:48px; } .hunk.lg { min-height:72px; } .hunk.xl { min-height:100px; }
.source-wrap { position:relative; border-top:1px solid color-mix(in srgb, var(--border) 70%, transparent); background:var(--vscode-editor-background); }
.source { display:block; width:100%; font-family:var(--vscode-editor-font-family); font-size:14px; line-height:1.5; max-height:520px; overflow:hidden; visibility:visible; }
.overview-hint { display:none; position:absolute; inset:0; align-items:center; justify-content:center; gap:10px; padding:10px; color:var(--fg); font-family:var(--vscode-font-family); pointer-events:none; white-space:nowrap; }
.overview-hint strong { font-size:15px; transform:scale(var(--label-boost)); transform-origin:center; }
.overview-hint span { color:var(--muted); transform:scale(var(--label-boost)); transform-origin:left center; }
.overview-hint b { color:#81c995; }
.overview-hint i { color:#ef8b87; font-style:normal; }
#world.overview-mode .source { visibility:hidden; }
#world.overview-mode .overview-hint { display:flex; }
#world.detail-ready .hunk { box-shadow:none; }
#world.detail-ready .hunk.selected { outline-width:2px; }
.line { display:grid; grid-template-columns:38px 38px 22px minmax(max-content,1fr); min-height:20px; white-space:pre; align-items:stretch; }
.line .ln { padding:1px 8px 1px 4px; text-align:right; user-select:none; color:var(--vscode-editorLineNumber-foreground); border-right:1px solid color-mix(in srgb, var(--border) 55%, transparent); font-variant-numeric:tabular-nums; }
.line .sign { padding:1px 0; text-align:center; user-select:none; font-weight:700; opacity:.9; }
.line .code { padding:1px 12px; min-width:max-content; overflow:visible; }
.line.add { background:color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground, rgba(46,125,70,.20)) 62%, transparent); }
.line.del { background:color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground, rgba(168,71,67,.20)) 62%, transparent); }
.line.add .sign { color:var(--vscode-gitDecoration-addedResourceForeground, #81c995); }
.line.del .sign { color:var(--vscode-gitDecoration-deletedResourceForeground, #ef8b87); }
.line.ctx { color:var(--vscode-editor-foreground); }
.line.meta { color:var(--muted); font-style:italic; grid-template-columns:24px minmax(max-content,1fr); }
.line.meta .code { grid-column:2; }
/* Intraline edits carry the strongest diff emphasis, matching editor diff semantics. */
.intraline.added { background:var(--vscode-diffEditor-insertedTextBackground, rgba(60,160,80,.44)); border:1px solid color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #81c995) 42%, transparent); border-radius:2px; }
.intraline.removed { background:var(--vscode-diffEditor-removedTextBackground, rgba(190,70,70,.46)); border:1px solid color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #ef8b87) 42%, transparent); border-radius:2px; }
/* Lightweight syntax colors use editor theme variables where possible. */
.tok-keyword { color:var(--vscode-symbolIcon-keywordForeground, #c586c0); }
.tok-string { color:var(--vscode-symbolIcon-stringForeground, #ce9178); }
.tok-number { color:var(--vscode-symbolIcon-numberForeground, #b5cea8); }
.tok-comment { color:var(--vscode-descriptionForeground, #6a9955); font-style:italic; }
.tok-type { color:var(--vscode-symbolIcon-classForeground, #4ec9b0); }
.tok-annotation { color:var(--vscode-symbolIcon-interfaceForeground, #dcdcaa); }
.tok-call { color:var(--vscode-symbolIcon-methodForeground, #dcdcaa); }
/* Semantic zoom only changes what is painted, never card geometry. */
#world.detail-ready .hunk-summary { font-size:12px; }
#inspector { position:fixed; z-index:30; right:18px; top:60px; bottom:64px; width:min(720px,46vw); display:none; flex-direction:column; border:1px solid var(--border); border-radius:9px; background:var(--vscode-editor-background); box-shadow:0 18px 60px rgba(0,0,0,.28); overflow:hidden; }
#inspector.open { display:flex; }
.inspector-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:12px 14px; border-bottom:1px solid var(--border); background:var(--panel); }
.inspector-file { font-size:15px; font-weight:700; }
.inspector-meta { color:var(--muted); margin-top:3px; }
#closeInspector { font-size:18px; line-height:1; padding:3px 7px; }
.inspector-tools { display:flex; align-items:center; gap:7px; padding:8px 12px; border-bottom:1px solid var(--border); background:color-mix(in srgb,var(--panel) 70%,transparent); }
#hunkIndex { color:var(--muted); margin-right:auto; }
.inspector-code { overflow:auto; flex:1; font-family:var(--vscode-editor-font-family); font-size:var(--vscode-editor-font-size); line-height:1.55; padding:8px 0 24px; background:var(--vscode-editor-background); }
.inspector-code .line { grid-template-columns:48px 48px 26px minmax(max-content,1fr); min-height:22px; }
.inspector-code .line .code { padding-right:24px; }
.inspector-code .hunk-title { position:sticky; top:0; z-index:2; padding:6px 12px; color:var(--muted); background:var(--vscode-editorWidget-background, var(--panel)); border-bottom:1px solid var(--border); font-family:var(--vscode-font-family); }
#hud { position:fixed; right:16px; bottom:14px; display:flex; align-items:center; gap:8px; padding:7px 9px; border:1px solid var(--border); border-radius:6px; background:color-mix(in srgb, var(--panel) 92%, transparent); z-index:20; }
#hud button { padding:4px 8px; min-width:28px; }
#zoomLabel { min-width:50px; text-align:center; color:var(--muted); }
#minimap { position:fixed; left:14px; bottom:14px; width:180px; height:110px; border:1px solid var(--border); border-radius:5px; background:color-mix(in srgb, var(--panel) 94%, transparent); z-index:20; overflow:hidden; }
#miniWorld { position:absolute; inset:6px; display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
.miniPkg { border:1px solid color-mix(in srgb,var(--muted) 40%,transparent); border-radius:2px; padding:2px; display:grid; grid-template-columns:repeat(8,1fr); gap:1px; }
.miniHunk { min-width:2px; min-height:2px; border-radius:1px; background:var(--mix); } .miniHunk.a { background:var(--add); } .miniHunk.d { background:var(--del); }
#miniViewport { position:absolute; border:1px solid var(--accent); pointer-events:none; }
#empty { margin:120px; max-width:650px; padding:28px; border:1px solid var(--border); border-radius:8px; background:var(--panel); font-size:15px; line-height:1.6; }
.search-muted { opacity:.16; }
.search-hit { outline:2px solid var(--vscode-focusBorder); outline-offset:3px; }
.search-active { box-shadow:0 0 0 2px color-mix(in srgb,var(--vscode-focusBorder) 70%,transparent); }
#contextMenu { position:fixed; z-index:60; display:none; min-width:170px; padding:5px; border:1px solid var(--border); border-radius:6px; background:var(--vscode-menu-background, var(--panel)); box-shadow:0 10px 35px rgba(0,0,0,.35); }
#contextMenu.open { display:block; }
#contextMenu button { width:100%; text-align:left; border:0; background:transparent; color:var(--vscode-menu-foreground, var(--fg)); }
#contextMenu button:hover { background:var(--vscode-menu-selectionBackground, var(--hover)); color:var(--vscode-menu-selectionForeground, var(--fg)); }
@media (max-width:900px) { #toolbar .optional { display:none; } }
</style>
</head>
<body>
<div id="toolbar">
  <div class="brand">DIFF MURAL</div>
  <button id="repoButton" title="Git repository: ${escapeAttr(data.repo)}">${escapeHtml(data.repoName)} ▾</button>
  <button id="baseButton" title="Choose base branch / commit">${escapeHtml(data.base)} ▾</button>
  <span class="compare-arrow">→</span>
  <button id="targetButton" title="Choose target branch / commit">${escapeHtml(data.target)} ▾</button>
  <div class="pill optional"><strong>${escapeHtml(data.baseHash)}</strong> → <strong>${escapeHtml(data.targetHash)}</strong></div>
  <div class="pill stat">${data.summary.files} files · ${data.summary.hunks} changes</div>
  <div class="stat add">+${data.summary.additions}</div>
  <div class="stat del">−${data.summary.deletions}</div>
  <div class="spacer"></div>
  <div class="search-wrap"><input id="search" placeholder="Find package, file, method…" /><span id="searchStatus"></span></div>
  <button id="refresh" title="Refresh diff">↻</button>
</div>
<div id="viewport">
  ${data.model.length ? `<div id="world">${packageHtml}</div>` : `<div id="empty"><b>No differences.</b><br><br><code>${escapeHtml(data.base)}</code> and <code>${escapeHtml(data.target)}</code> have no differences. Choose either side from the toolbar.</div>`}
</div>
${data.model.length ? `<div id="minimap"><div id="miniWorld">${packages.map(([pkg, files]) => `<div class="miniPkg" title="${escapeAttr(pkg)}">${files.flatMap(f => (f.hunks.length ? f.hunks : [{}])).map(h => `<span class="miniHunk ${h.additions && !h.deletions ? 'a' : h.deletions && !h.additions ? 'd' : ''}"></span>`).join('')}</div>`).join('')}</div><div id="miniViewport"></div></div>
<div id="hud"><button id="minus">−</button><span id="zoomLabel">100%</span><button id="plus">+</button><button id="fit">Fit</button><button id="resetLayout" title="Restore automatic package layout">Auto Layout</button></div>
<div id="inspector" aria-hidden="true">
  <div class="inspector-head"><div><div id="inspectorFile" class="inspector-file"></div><div id="inspectorMeta" class="inspector-meta"></div></div><button id="closeInspector" title="Close">×</button></div>
  <div class="inspector-tools"><span id="hunkIndex"></span><button id="prevHunk" title="Previous change">←</button><button id="nextHunk" title="Next change">→</button><button id="openInspectorDiff">Open side-by-side diff</button></div>
  <div id="inspectorCode" class="inspector-code"></div>
</div>
<div id="contextMenu" role="menu"><button data-action="open-file">Open File</button><button data-action="open-diff">Open Side-by-Side Diff</button></div>` : ''}
<script nonce="${data.nonce}">
const vscode = acquireVsCodeApi();
const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
if (world) {
  let scale = Math.min(0.72, ${Number(data.maxZoom) || 44} / 100), tx = 20, ty = 20;
  ${stateScript}
  let drag = false, lastX = 0, lastY = 0, spaceDown = false;
  let packageDrag = null;
  let selectedHunk = null;
  let packagePositions = (vscode.getState() || {}).packagePositions || {};
  const autoPackagePositions = {};
  const MIN_SCALE = Math.max(0.05, Math.min(1, ${Number(data.minZoom) || 10} / 100));
  const MAX_SCALE = Math.max(MIN_SCALE, Math.min(3, ${Number(data.maxZoom) || 44} / 100));
  const SOURCE_SCALE = Math.min(0.36, MAX_SCALE * 0.82);
  const clampScale = s => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

  function apply() {
    world.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
    world.classList.toggle('overview-mode', scale < SOURCE_SCALE);
    world.classList.toggle('detail-ready', scale >= SOURCE_SCALE);
    // Counter-scale labels at overview distances so package/file/change summaries
    // remain readable without changing the mural's physical layout.
    const labelBoost = scale < SOURCE_SCALE ? Math.min(1.9, Math.max(1, SOURCE_SCALE / scale)) : 1;
    world.style.setProperty('--label-boost', labelBoost.toFixed(3));
    scheduleAutoFocus();
    document.getElementById('zoomLabel').textContent = Math.round(scale * 100) + '%';
    vscode.setState({ ...(vscode.getState() || {}), scale, tx, ty, packagePositions });
    updateMinimap();
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = viewport.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const worldX = (x - tx) / scale;
    const worldY = (y - ty) / scale;
    const next = clampScale(scale * factor);
    tx = x - worldX * next;
    ty = y - worldY * next;
    scale = next;
    apply();
  }

  function worldBounds() {
    let maxX = 2100, maxY = 1200;
    document.querySelectorAll('.package').forEach(pkg => {
      maxX = Math.max(maxX, pkg.offsetLeft + pkg.offsetWidth + 180);
      maxY = Math.max(maxY, pkg.offsetTop + pkg.offsetHeight + 180);
    });
    world.style.width = maxX + 'px';
    world.style.height = maxY + 'px';
  }

  function freezePackageLayout() {
    const pkgs = [...document.querySelectorAll('.package')];
    if (!pkgs.length) return;
    const initial = pkgs.map(pkg => ({ pkg, x: pkg.offsetLeft, y: pkg.offsetTop, w: pkg.offsetWidth }));
    initial.forEach(({pkg,x,y}) => { autoPackagePositions[pkg.dataset.package] = {x,y}; });
    world.style.display = 'block';
    initial.forEach(({pkg,x,y,w}) => {
      const saved = packagePositions[pkg.dataset.package];
      pkg.style.position = 'absolute';
      pkg.style.width = w + 'px';
      pkg.style.left = (saved?.x ?? x) + 'px';
      pkg.style.top = (saved?.y ?? y) + 'px';
      pkg.classList.toggle('user-placed', !!saved);
    });
    worldBounds();
  }

  document.querySelectorAll('.package-header').forEach(header => {
    header.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const pkg = header.closest('.package');
      packageDrag = { pkg, pointerId:e.pointerId, x:e.clientX, y:e.clientY, left:parseFloat(pkg.style.left)||pkg.offsetLeft, top:parseFloat(pkg.style.top)||pkg.offsetTop };
      header.setPointerCapture(e.pointerId);
      e.stopPropagation(); e.preventDefault();
    });
    header.addEventListener('pointermove', e => {
      if (!packageDrag || packageDrag.pointerId !== e.pointerId) return;
      const dx = (e.clientX - packageDrag.x) / scale;
      const dy = (e.clientY - packageDrag.y) / scale;
      const x = Math.max(0, packageDrag.left + dx);
      const y = Math.max(0, packageDrag.top + dy);
      packageDrag.pkg.style.left = x + 'px';
      packageDrag.pkg.style.top = y + 'px';
      packageDrag.pkg.classList.add('user-placed');
      packagePositions[packageDrag.pkg.dataset.package] = {x,y};
      worldBounds(); updateMinimap();
    });
    header.addEventListener('pointerup', e => {
      if (!packageDrag || packageDrag.pointerId !== e.pointerId) return;
      try { header.releasePointerCapture(e.pointerId); } catch {}
      packageDrag = null;
      vscode.setState({ ...(vscode.getState() || {}), scale, tx, ty, packagePositions });
      e.stopPropagation();
    });
  });

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.shiftKey) {
      // Shift + wheel pans the mural. A physical mouse wheel becomes horizontal
      // movement; trackpads keep their native two-dimensional deltas.
      const mostlyVerticalWheel = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      if (mostlyVerticalWheel) tx -= e.deltaY;
      else { tx -= e.deltaX; ty -= e.deltaY; }
      apply();
      return;
    }
    // Plain wheel is semantic zoom, centered under the pointer.
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    zoomAt(e.clientX, e.clientY, Math.exp(-delta * 0.0018));
  }, { passive:false });

  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { spaceDown = true; e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomAt(innerWidth/2, innerHeight/2, 1.18); }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomAt(innerWidth/2, innerHeight/2, 1/1.18); }
    if (e.key === '0' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fitWorld(); }
    if (e.target.tagName !== 'INPUT' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'n' || e.key === 'N' || e.key === ']') { e.preventDefault(); navigateSpatial(1); }
      if (e.key === 'p' || e.key === 'P' || e.key === '[') { e.preventDefault(); navigateSpatial(-1); }
      if ((e.key === 'Enter' || e.key === 'i' || e.key === 'I') && selectedHunk) { e.preventDefault(); openInspector(selectedHunk); }
      if (e.key === 'Escape') { inspector.classList.remove('open'); inspector.setAttribute('aria-hidden','true'); }
    }
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });

  viewport.addEventListener('pointerdown', e => {
    const onHunk = e.target.closest('.hunk');
    const onPackageHeader = e.target.closest('.package-header');
    if ((onHunk || onPackageHeader) && e.button === 0 && !spaceDown) return;
    if (e.button === 0 || e.button === 1) {
      drag = true; lastX = e.clientX; lastY = e.clientY; viewport.classList.add('dragging'); viewport.setPointerCapture(e.pointerId); e.preventDefault();
    }
  });
  viewport.addEventListener('pointermove', e => {
    if (!drag) return;
    tx += e.clientX - lastX; ty += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; apply();
  });
  viewport.addEventListener('pointerup', e => { drag = false; viewport.classList.remove('dragging'); try { viewport.releasePointerCapture(e.pointerId); } catch {} });

  const hunks = [...document.querySelectorAll('.hunk')];
  const inspector = document.getElementById('inspector');
  const inspectorCode = document.getElementById('inspectorCode');
  let focusRaf = 0;

  function markSelected(el, auto = false) {
    if (!el) return;
    hunks.forEach(x => { x.classList.remove('selected'); x.classList.remove('auto-focus'); });
    el.classList.add(auto ? 'auto-focus' : 'selected');
    selectedHunk = el;
  }

  function nearestHunkToViewportCenter() {
    if (!hunks.length) return null;
    const vr = viewport.getBoundingClientRect();
    const cx = vr.left + vr.width / 2;
    const cy = vr.top + vr.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of hunks) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const dx = ex - cx, dy = ey - cy;
      const score = dx*dx + dy*dy;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function scheduleAutoFocus() {
    if (focusRaf) cancelAnimationFrame(focusRaf);
    focusRaf = requestAnimationFrame(() => {
      focusRaf = 0;
      if (scale < 0.46 || inspector.classList.contains('open')) return;
      const nearest = nearestHunkToViewportCenter();
      if (nearest) markSelected(nearest, true);
    });
  }

  function openInspector(el) {
    if (!el) return;
    markSelected(el, false);
    const file = el.closest('.file');
    const pkg = el.closest('.package');
    document.getElementById('inspectorFile').textContent = file?.querySelector('.file-header span:first-child')?.textContent || el.dataset.file;
    document.getElementById('inspectorMeta').textContent = (pkg?.dataset.package || '') + '  ·  ' + el.querySelector('.counts').textContent.trim();
    const source = el.querySelector('.source');
    inspectorCode.innerHTML = '<div class="hunk-title">' + escapeForClient(el.querySelector('.hunk-label').textContent) + '</div>' + (source?.innerHTML || '');
    const sameFile = hunks.filter(x => x.dataset.file === el.dataset.file);
    const idx = sameFile.indexOf(el);
    document.getElementById('hunkIndex').textContent = 'Change ' + (idx + 1) + ' of ' + sameFile.length;
    inspector.classList.add('open'); inspector.setAttribute('aria-hidden','false');
    inspectorCode.scrollTop = 0;
  }

  function escapeForClient(v) { const d=document.createElement('div'); d.textContent=v||''; return d.innerHTML; }

  function centerOnHunk(el) {
    if (!el) return;
    const vr = viewport.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    tx += (vr.left + vr.width/2) - (r.left + r.width/2);
    ty += (vr.top + vr.height/2) - (r.top + r.height/2);
    markSelected(el, true);
    apply();
  }

  function spatialHunks() {
    return hunks.slice().sort((a,b) => {
      const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
      const ay=ar.top+ar.height/2, by=br.top+br.height/2;
      if (Math.abs(ay-by) > 60) return ay-by;
      return (ar.left+ar.width/2) - (br.left+br.width/2);
    });
  }

  function navigateSpatial(delta) {
    const ordered = spatialHunks();
    if (!ordered.length) return;
    let idx = selectedHunk ? ordered.indexOf(selectedHunk) : -1;
    if (idx < 0) {
      const nearest = nearestHunkToViewportCenter();
      idx = Math.max(0, ordered.indexOf(nearest));
    }
    centerOnHunk(ordered[(idx + delta + ordered.length) % ordered.length]);
  }

  function siblingHunk(delta) {
    if (!selectedHunk) return;
    const sameFile = hunks.filter(x => x.dataset.file === selectedHunk.dataset.file);
    const idx = sameFile.indexOf(selectedHunk);
    const next = sameFile[(idx + delta + sameFile.length) % sameFile.length];
    openInspector(next);
  }

  const contextMenu = document.getElementById('contextMenu');
  let contextTarget = null;

  function postOpen(type, el) {
    if (!el) return;
    const fileEl = el.closest?.('.file') || el;
    const hunkEl = el.closest?.('.hunk');
    vscode.postMessage({
      type,
      file: hunkEl?.dataset.file || fileEl.dataset.file,
      oldFile: hunkEl?.dataset.oldFile || fileEl.dataset.oldFile,
      line:Number(hunkEl?.dataset.line || 1),
      status:hunkEl?.dataset.status || fileEl.dataset.status
    });
  }

  function hideContextMenu() {
    contextMenu?.classList.remove('open');
    contextTarget = null;
  }

  hunks.forEach(el => {
    // Single click only marks the hunk. Double-click now opens the current file;
    // the side-by-side diff is an explicit action instead of the default.
    el.addEventListener('click', e => { markSelected(el, false); e.stopPropagation(); });
    el.addEventListener('dblclick', e => { e.stopPropagation(); postOpen('openFile', el); });
    el.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      contextTarget = el;
      contextMenu.style.left = Math.min(e.clientX, innerWidth - 190) + 'px';
      contextMenu.style.top = Math.min(e.clientY, innerHeight - 90) + 'px';
      contextMenu.classList.add('open');
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') postOpen('openFile', el);
    });
  });

  document.querySelectorAll('.file-action').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      postOpen(btn.dataset.action === 'open-diff' ? 'openDiff' : 'openFile', btn.closest('.file'));
    });
  });
  contextMenu?.querySelectorAll('button').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      postOpen(btn.dataset.action === 'open-diff' ? 'openDiff' : 'openFile', contextTarget);
      hideContextMenu();
    };
  });
  window.addEventListener('pointerdown', e => { if (!e.target.closest('#contextMenu')) hideContextMenu(); });
  window.addEventListener('blur', hideContextMenu);
  document.getElementById('closeInspector').onclick = () => { inspector.classList.remove('open'); inspector.setAttribute('aria-hidden','true'); scheduleAutoFocus(); };
  document.getElementById('prevHunk').onclick = () => siblingHunk(-1);
  document.getElementById('nextHunk').onclick = () => siblingHunk(1);
  document.getElementById('openInspectorDiff').onclick = () => {
    if (!selectedHunk) return;
    vscode.postMessage({ type:'openDiff', file:selectedHunk.dataset.file, oldFile:selectedHunk.dataset.oldFile, line:Number(selectedHunk.dataset.line), status:selectedHunk.dataset.status });
  };

  function fitWorld() {
    const r = viewport.getBoundingClientRect();
    const w = world.scrollWidth + 180;
    const h = world.scrollHeight + 180;
    scale = clampScale(Math.min((r.width - 40) / w, (r.height - 40) / h, 0.82));
    tx = Math.max(10, (r.width - w * scale) / 2);
    ty = Math.max(10, (r.height - h * scale) / 2);
    apply();
  }

  document.getElementById('plus').onclick = () => zoomAt(innerWidth/2, innerHeight/2, 1.2);
  document.getElementById('minus').onclick = () => zoomAt(innerWidth/2, innerHeight/2, 1/1.2);
  document.getElementById('fit').onclick = fitWorld;
  document.getElementById('resetLayout').onclick = () => {
    packagePositions = {};
    document.querySelectorAll('.package').forEach(pkg => {
      const pos = autoPackagePositions[pkg.dataset.package];
      if (!pos) return;
      pkg.style.left = pos.x + 'px';
      pkg.style.top = pos.y + 'px';
      pkg.classList.remove('user-placed');
    });
    worldBounds();
    vscode.setState({ ...(vscode.getState() || {}), scale, tx, ty, packagePositions });
    fitWorld();
  };
  document.getElementById('repoButton').onclick = () => vscode.postMessage({ type:'chooseRepo' });
  document.getElementById('baseButton').onclick = () => vscode.postMessage({ type:'chooseBase' });
  document.getElementById('targetButton').onclick = () => vscode.postMessage({ type:'chooseTarget' });
  document.getElementById('refresh').onclick = () => vscode.postMessage({ type:'refresh' });

  const search = document.getElementById('search');
  const searchStatus = document.getElementById('searchStatus');
  let searchMatches = [];
  let searchIndex = -1;

  function clearSearchClasses() {
    document.querySelectorAll('.file').forEach(file => file.classList.remove('search-muted', 'search-hit', 'search-active'));
  }

  function updateSearch() {
    const q = search.value.trim().toLowerCase();
    clearSearchClasses();
    searchMatches = [];
    searchIndex = -1;
    searchStatus.classList.remove('no-match');

    if (!q) {
      searchStatus.textContent = '';
      return;
    }

    document.querySelectorAll('.file').forEach(file => {
      const haystack = ((file.closest('.package')?.dataset.package || '') + ' ' + file.textContent).toLowerCase();
      if (haystack.includes(q)) searchMatches.push(file);
    });

    if (!searchMatches.length) {
      // A miss should not make the entire mural disappear. Keep everything at
      // normal contrast and give an explicit zero-results state instead.
      searchStatus.textContent = 'No matches';
      searchStatus.classList.add('no-match');
      return;
    }

    const matchSet = new Set(searchMatches);
    document.querySelectorAll('.file').forEach(file => {
      file.classList.toggle('search-muted', !matchSet.has(file));
      file.classList.toggle('search-hit', matchSet.has(file));
    });
    searchStatus.textContent = searchMatches.length + ' match' + (searchMatches.length === 1 ? '' : 'es');
  }

  function focusSearchMatch(delta) {
    if (!searchMatches.length) return;
    searchIndex = (searchIndex + delta + searchMatches.length) % searchMatches.length;
    document.querySelectorAll('.file.search-active').forEach(x => x.classList.remove('search-active'));
    const file = searchMatches[searchIndex];
    file.classList.add('search-active');
    const target = file.querySelector('.hunk') || file;
    const vr = viewport.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    tx += (vr.left + vr.width/2) - (r.left + r.width/2);
    ty += (vr.top + vr.height/2) - (r.top + r.height/2);
    apply();
    searchStatus.textContent = (searchIndex + 1) + ' / ' + searchMatches.length;
  }

  search.addEventListener('input', updateSearch);
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); focusSearchMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { search.value = ''; updateSearch(); search.blur(); }
  });

  function updateMinimap() {
    const mini = document.getElementById('minimap');
    const box = document.getElementById('miniViewport');
    if (!mini || !box) return;
    const innerW = 168, innerH = 98;
    const worldW = Math.max(world.scrollWidth, 1), worldH = Math.max(world.scrollHeight, 1);
    const sx = innerW / worldW, sy = innerH / worldH;
    const v = viewport.getBoundingClientRect();
    const left = Math.max(0, -tx / scale) * sx + 6;
    const top = Math.max(0, -ty / scale) * sy + 6;
    const width = Math.min(innerW, v.width / scale * sx);
    const height = Math.min(innerH, v.height / scale * sy);
    box.style.left = left + 'px'; box.style.top = top + 'px'; box.style.width = Math.max(8,width) + 'px'; box.style.height = Math.max(8,height) + 'px';
  }

  requestAnimationFrame(() => { freezePackageLayout(); apply(); if (!${data.preserveView ? 'true' : 'false'}) fitWorld(); });
} else {
  document.getElementById('repoButton').onclick = () => vscode.postMessage({ type:'chooseRepo' });
  document.getElementById('baseButton').onclick = () => vscode.postMessage({ type:'chooseBase' });
  document.getElementById('targetButton').onclick = () => vscode.postMessage({ type:'chooseTarget' });
  document.getElementById('refresh').onclick = () => vscode.postMessage({ type:'refresh' });
}
</script>
</body>
</html>`;
}


function renderHunkLines(lines, filePath = '') {
  const annotated = lines.map(line => ({ ...line }));

  // Git emits replacements as a run of removed lines followed by added lines.
  // Pair those lines so we can emphasize only the text that actually changed.
  for (let i = 0; i < annotated.length;) {
    if (annotated[i].type !== 'del') { i++; continue; }
    const delStart = i;
    while (i < annotated.length && annotated[i].type === 'del') i++;
    const addStart = i;
    while (i < annotated.length && annotated[i].type === 'add') i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let p = 0; p < pairs; p++) {
      const removed = annotated[delStart + p];
      const added = annotated[addStart + p];
      const spans = changedSpans(removed.text, added.text);
      removed.highlight = spans.old;
      added.highlight = spans.new;
    }
  }

  return annotated.map(line => {
    if (line.type === 'meta') {
      return `<div class="line meta"><span class="sign">·</span><span class="code">${escapeHtml(line.text)}</span></div>`;
    }
    const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
    const oldNo = line.oldLine == null ? '' : line.oldLine;
    const newNo = line.newLine == null ? '' : line.newLine;
    const code = line.highlight
      ? renderHighlightedText(line.text, line.highlight, line.type, filePath)
      : syntaxHighlight(line.text, filePath);
    return `<div class="line ${line.type}"><span class="ln old">${oldNo}</span><span class="ln new">${newNo}</span><span class="sign">${sign}</span><span class="code">${code}</span></div>`;
  }).join('');
}

function changedSpans(oldText, newText) {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;

  return {
    old: { start: prefix, end: oldText.length - suffix },
    new: { start: prefix, end: newText.length - suffix }
  };
}

function renderHighlightedText(text, span, type, filePath = '') {
  if (!span || span.end <= span.start) return syntaxHighlight(text, filePath);
  const cls = type === 'add' ? 'added' : 'removed';
  return syntaxHighlight(text.slice(0, span.start), filePath) +
    `<span class="intraline ${cls}">${syntaxHighlight(text.slice(span.start, span.end), filePath)}</span>` +
    syntaxHighlight(text.slice(span.end), filePath);
}

function syntaxHighlight(text, filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.java', '.kt', '.kts', '.groovy', '.scala', '.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
    return escapeHtml(text);
  }

  // A deliberately small, line-local lexer. It keeps the mural dependency-free
  // and cheap while providing editor-like visual scanning at readable zoom.
  const keywords = new Set([
    'abstract','assert','boolean','break','byte','case','catch','char','class','const','continue','default','do','double','else','enum','extends','final','finally','float','for','goto','if','implements','import','instanceof','int','interface','long','native','new','package','private','protected','public','return','short','static','strictfp','super','switch','synchronized','this','throw','throws','transient','try','void','volatile','while','record','sealed','permits','yield','var','true','false','null',
    'fun','val','when','object','data','override','open','internal','suspend','typealias','as','is','in',
    'function','let','const','async','await','export','from','of','typeof','delete','undefined'
  ]);

  let out = '';
  let i = 0;
  const isStart = c => /[A-Za-z_$]/.test(c);
  const isPart = c => /[A-Za-z0-9_$]/.test(c);
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      out += `<span class="tok-comment">${escapeHtml(text.slice(i))}</span>`;
      break;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === q) { j++; break; }
        j++;
      }
      out += `<span class="tok-string">${escapeHtml(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (c === '@' && isStart(text[i + 1] || '')) {
      let j = i + 2;
      while (j < text.length && isPart(text[j])) j++;
      out += `<span class="tok-annotation">${escapeHtml(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[0-9A-Fa-f_xXbBeE.+-]/.test(text[j])) j++;
      out += `<span class="tok-number">${escapeHtml(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (isStart(c)) {
      let j = i + 1;
      while (j < text.length && isPart(text[j])) j++;
      const word = text.slice(i, j);
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      let cls = '';
      if (keywords.has(word)) cls = 'tok-keyword';
      else if (/^[A-Z]/.test(word)) cls = 'tok-type';
      else if (text[k] === '(') cls = 'tok-call';
      out += cls ? `<span class="${cls}">${escapeHtml(word)}</span>` : escapeHtml(word);
      i = j;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

function groupBy(items, fn) {
  const map = new Map();
  for (const item of items) {
    const key = fn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function uniqueLines(text) {
  return [...new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
}

function isPathInside(filePath, rootPath) {
  const file = normalizePath(path.resolve(filePath));
  const root = normalizePath(path.resolve(rootPath)).replace(/\/$/, '');
  return file === root || file.startsWith(root + '/');
}

function normalizePath(p) {
  return path.resolve(p).toLowerCase();
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

function escapeAttr(value) { return escapeHtml(value); }

function friendlyError(err) {
  const stderr = err?.stderr?.trim();
  return stderr || err?.message || String(err);
}

module.exports = { activate, deactivate, parseDiff, packageFor };
