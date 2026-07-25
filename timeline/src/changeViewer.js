const crypto = require('node:crypto');
const path = require('node:path');
const vscode = require('vscode');

class ChangeViewer {
  constructor(context, activateCommit) {
    this.context = context;
    this.activateCommit = activateCommit;
    this.panel = undefined;
    this.repository = undefined;
    this.commits = [];
    this.currentIndex = -1;
    this.disposables = [];
  }

  async open(item) {
    if (!item?.repository || !item?.commit) {
      return;
    }

    const maxEntries = vscode.workspace
      .getConfiguration('xPlaneTimeline')
      .get('maxVisibleEntries', 250);

    const newestFirst = await item.repository.listTimeline(maxEntries);
    const commits = newestFirst.reverse();
    const currentIndex = commits.findIndex(commit => commit.hash === item.commit.hash);
    if (currentIndex < 0) {
      await vscode.window.showInformationMessage(
        'This save is no longer available in the visible X-Plane timeline.'
      );
      return;
    }

    this.repository = item.repository;
    this.commits = commits;
    this.currentIndex = currentIndex;

    if (!this.panel) {
      this.createPanel();
    } else {
      this.panel.reveal(vscode.ViewColumn.Active, true);
    }

    this.panel.title = `X-Plane Changes — ${path.basename(this.repository.root)}`;
    this.panel.webview.html = this.getHtml(this.panel.webview);
    await this.activateCurrentCommit();
  }

  createPanel() {
    this.panel = vscode.window.createWebviewPanel(
      'xPlaneChangeViewer',
      'X-Plane Changes',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'media',
      'timeline.svg'
    );

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message)),
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.repository = undefined;
        this.commits = [];
        this.currentIndex = -1;
        while (this.disposables.length) {
          this.disposables.pop()?.dispose();
        }
      })
    );
  }

  async handleMessage(message) {
    if (!this.panel || !this.repository || !message) {
      return;
    }

    switch (message.type) {
      case 'ready':
        await this.postCurrent();
        break;
      case 'requestPatch':
        await this.sendPatch(message.index);
        break;
      case 'select':
        await this.select(message.index);
        break;
      case 'openDiff':
        await this.openNativeDiff(message.index);
        break;
      case 'jumpToHunk':
        await this.jumpToHunk(message.file, message.startLine, message.endLine, message.addedLines);
        break;
      default:
        break;
    }
  }

  async sendPatch(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.commits.length) {
      return;
    }

    const commit = this.commits[index];
    try {
      const patch = await this.repository.diffCommit(commit);
      await this.panel?.webview.postMessage({
        type: 'patch',
        index,
        patch: patch || 'No textual changes in this save.'
      });
    } catch (error) {
      await this.panel?.webview.postMessage({
        type: 'patch',
        index,
        patch: `Unable to load this change: ${error instanceof Error ? error.message : String(error)}`,
        error: true
      });
    }
  }

  async select(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.commits.length) {
      return;
    }

    if (this.currentIndex === index) {
      return;
    }

    this.currentIndex = index;
    await this.activateCurrentCommit();
    await this.postCurrent();
  }

  async activateCurrentCommit() {
    const commit = this.commits[this.currentIndex];
    if (this.repository && commit && this.activateCommit) {
      await this.activateCommit(this.repository, commit);
    }
  }

  async postCurrent() {
    await this.panel?.webview.postMessage({
      type: 'current',
      index: this.currentIndex
    });
  }

  async openNativeDiff(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.commits.length) {
      return;
    }

    const commit = this.commits[index];
    const file = commit.savedFile || commit.changedFiles[0];
    if (!commit.parent || !file) {
      return;
    }

    const { historicalUri } = require('./timeline');
    await vscode.commands.executeCommand(
      'vscode.diff',
      historicalUri(this.repository.root, commit.parent, file),
      historicalUri(this.repository.root, commit.hash, file),
      `${file} — Save ${index + 1} of ${this.commits.length}`,
      { preview: true }
    );
  }

  async jumpToHunk(file, startLine, endLine, addedLines) {
    if (!this.repository || typeof file !== 'string' || !file.trim()) {
      return;
    }

    const root = path.resolve(this.repository.root);
    const target = path.resolve(root, file);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      await vscode.window.showWarningMessage('X-Plane refused to open a file outside the repository.');
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const requestedStart = Number.isInteger(startLine) ? startLine : Number.parseInt(startLine, 10);
      const requestedEnd = Number.isInteger(endLine) ? endLine : Number.parseInt(endLine, 10);
      const fallbackStart = Number.isFinite(requestedStart) ? Math.max(0, requestedStart - 1) : 0;
      const fallbackEnd = Number.isFinite(requestedEnd) ? Math.max(fallbackStart, requestedEnd - 1) : fallbackStart;

      const normalizedAdded = Array.isArray(addedLines)
        ? addedLines.map(line => String(line)).filter(line => line.trim().length > 0)
        : [];

      let actualStart = Math.min(fallbackStart, Math.max(0, document.lineCount - 1));
      let actualEnd = Math.min(fallbackEnd, Math.max(0, document.lineCount - 1));

      if (normalizedAdded.length > 0) {
        const normalize = value => value.replace(/\s+/g, ' ').trim();
        const wanted = normalizedAdded.map(normalize);
        const candidates = [];

        for (let lineIndex = 0; lineIndex <= document.lineCount - wanted.length; lineIndex += 1) {
          let matches = true;
          for (let offset = 0; offset < wanted.length; offset += 1) {
            if (normalize(document.lineAt(lineIndex + offset).text) !== wanted[offset]) {
              matches = false;
              break;
            }
          }
          if (matches) {
            candidates.push(lineIndex);
          }
        }

        if (candidates.length > 0) {
          candidates.sort((left, right) => Math.abs(left - fallbackStart) - Math.abs(right - fallbackStart));
          actualStart = candidates[0];
          actualEnd = actualStart + wanted.length - 1;
        }
      }

      const startPosition = new vscode.Position(actualStart, 0);
      const endPosition = new vscode.Position(actualEnd, document.lineAt(actualEnd).text.length);
      const selection = new vscode.Selection(startPosition, endPosition);
      const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
      editor.selection = selection;
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    } catch (error) {
      await vscode.window.showInformationMessage(
        `Unable to open ${file} in the current workspace. It may have been renamed or deleted.`
      );
    }
  }

  getHtml(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const commits = this.commits.map((commit, index) => ({
      index,
      hash: commit.hash,
      shortHash: commit.hash.slice(0, 8),
      timestamp: commit.timestamp,
      savedFile: commit.savedFile || commit.changedFiles[0] || 'Project change',
      changedFiles: commit.changedFiles,
      subject: commit.subject
    }));
    const commitsJson = JSON.stringify(commits).replace(/</g, '\\u003c');
    const initialIndex = this.currentIndex;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>X-Plane Change Viewer</title>
  <style>
    :root { --card-width: 620px; --gap: 18px; --toolbar-height: 46px; --minimap-height: 48px; }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; overflow: hidden; }
    body {
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    .toolbar {
      height: var(--toolbar-height);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .toolbar button, .toolbar select {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 3px;
      padding: 5px 10px;
      cursor: pointer;
    }
    .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
    .toolbar button:disabled { opacity: .45; cursor: default; }
    .toolbar select {
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
    }
    #position { min-width: 145px; font-weight: 600; }
    .hint { opacity: .65; margin-left: auto; white-space: nowrap; }
    .minimap-shell {
      height: var(--minimap-height);
      padding: 8px 14px 7px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    #minimap {
      height: 100%;
      display: flex;
      align-items: flex-end;
      gap: 3px;
      overflow: hidden;
      cursor: pointer;
    }
    .mini-save {
      flex: 1 1 0;
      min-width: 3px;
      height: 20%;
      border-radius: 2px 2px 0 0;
      background: var(--vscode-descriptionForeground);
      opacity: .35;
      transition: height .12s, opacity .12s, box-shadow .12s;
    }
    .mini-save.loaded { opacity: .65; }
    .mini-save.current {
      opacity: 1;
      background: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    #viewport {
      height: calc(100% - var(--toolbar-height) - var(--minimap-height));
      overflow-x: auto;
      overflow-y: hidden;
      scroll-snap-type: x proximity;
      scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
    }
    #track {
      height: 100%;
      display: flex;
      align-items: stretch;
      gap: var(--gap);
      padding: 18px;
      width: max-content;
    }
    .save-card {
      flex: 0 0 var(--card-width);
      height: 100%;
      min-width: 340px;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
      overflow: hidden;
      scroll-snap-align: center;
      transition: border-color .1s, box-shadow .1s, transform .1s;
    }
    .save-card.current {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
      transform: translateY(-1px);
    }
    .save-header {
      flex: 0 0 auto;
      padding: 10px 13px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
      cursor: pointer;
    }
    .frame-top { display: flex; align-items: baseline; gap: 8px; }
    .save-number { font-weight: 750; font-size: 14px; }
    .save-time { margin-left: auto; opacity: .68; font-size: 12px; }
    .save-file {
      margin-top: 5px;
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .save-summary { margin-top: 6px; display: flex; gap: 10px; font-size: 12px; }
    .add-count { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .delete-count { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .hunk-count, .file-count { opacity: .72; }
    .current-badge { display: none; color: var(--vscode-testing-iconPassed); font-weight: 700; }
    .current .current-badge { display: inline; }
    .patch-wrap {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      background: var(--vscode-textCodeBlock-background);
    }
    .patch {
      margin: 0;
      min-width: max-content;
      padding: 8px 0 30px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.45;
      tab-size: 4;
    }
    .line {
      display: block;
      min-height: 1.45em;
      padding: 0 12px;
      white-space: pre;
    }
    .line.context { opacity: .32; }
    .line.add { background: var(--vscode-diffEditor-insertedLineBackground); }
    .line.delete { background: var(--vscode-diffEditor-removedLineBackground); }
    .line.hunk {
      display: block;
      padding-top: 5px;
      padding-bottom: 5px;
      opacity: .9;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-diffEditor-unchangedCodeBackground);
      font-size: .92em;
    }
    .hunk-actions {
      display: flex;
      align-items: center;
      min-height: 24px;
    }
    .jump-hunk {
      flex: 0 0 auto;
      border: 0;
      border-radius: 3px;
      padding: 2px 7px;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      cursor: pointer;
      font: inherit;
      font-size: .92em;
    }
    .jump-hunk:hover {
      color: var(--vscode-textLink-activeForeground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .hunk-context {
      display: block;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: .72;
    }
    .line.file-label {
      position: sticky;
      top: 0;
      z-index: 1;
      padding-top: 5px;
      padding-bottom: 5px;
      color: var(--vscode-textLink-foreground);
      font-weight: 700;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .loading, .empty { padding: 18px; opacity: .7; }
    .card-actions {
      flex: 0 0 auto;
      display: flex;
      gap: 8px;
      padding: 8px 11px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    .card-actions button {
      border: 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      cursor: pointer;
      padding: 3px 5px;
    }
    @media (max-width: 720px) {
      :root { --card-width: calc(100vw - 54px); }
      .hint { display: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="previous" title="Previous save">←</button>
    <button id="next" title="Next save">→</button>
    <span id="position"></span>
    <label for="width">Column width</label>
    <select id="width">
      <option value="440px">Compact</option>
      <option value="620px" selected>Readable</option>
      <option value="820px">Wide</option>
    </select>
    <button id="current">Jump to current</button>
    <span class="hint">Shift+wheel or drag horizontally · Arrow keys move through saves</span>
  </div>
  <div class="minimap-shell"><div id="minimap" aria-label="Timeline minimap"></div></div>
  <main id="viewport"><div id="track"></div></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const commits = ${commitsJson};
    let currentIndex = ${initialIndex};
    const loaded = new Set();
    const requested = new Set();
    const stats = new Map();
    const track = document.getElementById('track');
    const viewport = document.getElementById('viewport');
    const position = document.getElementById('position');
    const minimap = document.getElementById('minimap');

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function parsePatch(patch) {
      const lines = patch.split(/\\r?\\n/);
      const rendered = [];
      let additions = 0;
      let deletions = 0;
      let hunks = 0;
      let files = 0;
      let currentFile = '';
      let currentHunk = null;
      let currentNewLine = 1;

      for (const line of lines) {
        if (line.startsWith('diff --git ')) {
          const match = line.match(/^diff --git a\\/(.+?) b\\/(.+)$/);
          currentFile = match ? match[2] : '';
          files += 1;
          if (currentFile) rendered.push({ type: 'file-label', text: currentFile });
          continue;
        }
        if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
        if (line.startsWith('new file mode ') || line.startsWith('deleted file mode ') || line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ')) continue;
        if (line.startsWith('@@')) {
          hunks += 1;
          const match = line.match(/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@\\s?(.*)$/);
          const newLine = match ? Number(match[2]) : 1;
          const context = match?.[4] || '';
          rendered.push({ type: 'hunk', text: context, file: currentFile, line: newLine, addedLines: [] });
          continue;
        }
        if (line.startsWith('+')) {
          additions += 1;
          const currentHunk = [...rendered].reverse().find(item => item.type === 'hunk');
          if (currentHunk) currentHunk.addedLines.push(line.slice(1));
          rendered.push({ type: 'add', text: line });
          continue;
        }
        if (line.startsWith('-')) {
          deletions += 1;
          rendered.push({ type: 'delete', text: line });
          continue;
        }
        if (line.startsWith('\\ No newline at end of file')) continue;
        rendered.push({ type: 'context', text: line || ' ' });
      }

      return { rendered, additions, deletions, hunks, files };
    }

    function renderParsed(parsed) {
      if (!parsed.rendered.length) return '<div class="empty">No textual changes in this save.</div>';
      return parsed.rendered.map(item => {
        if (item.type === 'hunk' && item.file) {
          const startLine = item.startLine || item.line;
          const endLine = item.endLine || startLine;
          const lineLabel = startLine === endLine ? 'line ' + startLine : 'lines ' + startLine + '–' + endLine;
          const addedLines = encodeURIComponent(JSON.stringify(item.addedLines || []));
          return '<span class="line hunk">' +
            '<span class="hunk-actions"><button class="jump-hunk" data-file="' + escapeHtml(item.file) + '" data-start-line="' + startLine + '" data-end-line="' + endLine + '" data-added-lines="' + addedLines + '" title="Open the current workspace file and select this edit">↗ Jump to ' + lineLabel + '</button></span>' +
            (item.text ? '<span class="hunk-context">' + escapeHtml(item.text) + '</span>' : '') +
            '</span>';
        }
        return '<span class="line ' + item.type + '">' + escapeHtml(item.text || ' ') + '</span>';
      }).join('');
    }

    function updateSummary(index, parsed) {
      stats.set(index, parsed);
      const card = document.querySelector('.save-card[data-index="' + index + '"]');
      if (card) {
        card.querySelector('.add-count').textContent = '+' + parsed.additions;
        card.querySelector('.delete-count').textContent = '−' + parsed.deletions;
        card.querySelector('.hunk-count').textContent = parsed.hunks + (parsed.hunks === 1 ? ' hunk' : ' hunks');
      }
      const mini = document.querySelector('.mini-save[data-index="' + index + '"]');
      if (mini) {
        const magnitude = Math.max(1, parsed.additions + parsed.deletions);
        mini.style.height = Math.min(100, 18 + Math.log2(magnitude + 1) * 17) + '%';
        mini.classList.add('loaded');
        mini.title = 'Save ' + (index + 1) + ': +' + parsed.additions + ' −' + parsed.deletions + ', ' + parsed.hunks + ' hunks';
      }
    }

    function makeCard(commit) {
      const card = document.createElement('section');
      card.className = 'save-card';
      card.dataset.index = String(commit.index);
      const date = new Date(commit.timestamp * 1000);
      const filesText = commit.changedFiles.length === 1 ? '1 file' : commit.changedFiles.length + ' files';
      card.innerHTML = [
        '<header class="save-header">',
        '<div class="frame-top"><span class="save-number">Save ' + (commit.index + 1) + '</span><span class="current-badge">▶ current</span><span class="save-time">' + date.toLocaleTimeString() + '</span></div>',
        '<div class="save-file" title="' + escapeHtml(commit.savedFile) + '">' + escapeHtml(commit.savedFile) + '</div>',
        '<div class="save-summary"><span class="add-count">+…</span><span class="delete-count">−…</span><span class="hunk-count">… hunks</span><span class="file-count">' + filesText + '</span></div>',
        '</header>',
        '<div class="patch-wrap"><div class="loading">Loading code change…</div><pre class="patch" hidden></pre></div>',
        '<footer class="card-actions"><button class="open-diff">Open native diff</button></footer>'
      ].join('');
      card.querySelector('.save-header').addEventListener('click', () => select(commit.index, false));
      card.querySelector('.open-diff').addEventListener('click', event => {
        event.stopPropagation();
        vscode.postMessage({ type: 'openDiff', index: commit.index });
      });
      card.querySelector('.patch').addEventListener('click', event => {
        const button = event.target.closest('.jump-hunk');
        if (!button) return;
        event.stopPropagation();
        vscode.postMessage({
          type: 'jumpToHunk',
          file: button.dataset.file,
          startLine: Number(button.dataset.startLine),
          endLine: Number(button.dataset.endLine),
          addedLines: JSON.parse(decodeURIComponent(button.dataset.addedLines || '%5B%5D'))
        });
      });
      return card;
    }

    function makeMini(commit) {
      const mini = document.createElement('div');
      mini.className = 'mini-save';
      mini.dataset.index = String(commit.index);
      mini.title = 'Save ' + (commit.index + 1);
      mini.addEventListener('click', () => select(commit.index, true));
      return mini;
    }

    commits.forEach(commit => {
      track.appendChild(makeCard(commit));
      minimap.appendChild(makeMini(commit));
    });

    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        requestPatch(Number(entry.target.dataset.index));
      }
    }, { root: viewport, rootMargin: '0px 900px 0px 900px', threshold: 0.01 });
    document.querySelectorAll('.save-card').forEach(card => observer.observe(card));

    function requestPatch(index) {
      if (loaded.has(index) || requested.has(index)) return;
      requested.add(index);
      vscode.postMessage({ type: 'requestPatch', index });
    }

    function setCurrent(index, scroll) {
      if (!Number.isInteger(index) || index < 0 || index >= commits.length) return;
      currentIndex = index;
      document.querySelectorAll('.save-card.current').forEach(card => card.classList.remove('current'));
      document.querySelectorAll('.mini-save.current').forEach(item => item.classList.remove('current'));
      const card = document.querySelector('.save-card[data-index="' + index + '"]');
      const mini = document.querySelector('.mini-save[data-index="' + index + '"]');
      card?.classList.add('current');
      mini?.classList.add('current');
      position.textContent = 'Save ' + (index + 1) + ' of ' + commits.length;
      document.getElementById('previous').disabled = index <= 0;
      document.getElementById('next').disabled = index >= commits.length - 1;
      requestPatch(index);
      if (scroll) card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    function select(index, scroll = true) {
      setCurrent(index, scroll);
      vscode.postMessage({ type: 'select', index });
    }

    document.getElementById('previous').addEventListener('click', () => select(currentIndex - 1));
    document.getElementById('next').addEventListener('click', () => select(currentIndex + 1));
    document.getElementById('current').addEventListener('click', () => setCurrent(currentIndex, true));
    document.getElementById('width').addEventListener('change', event => {
      document.documentElement.style.setProperty('--card-width', event.target.value);
      setCurrent(currentIndex, false);
    });

    viewport.addEventListener('wheel', event => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        viewport.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    }, { passive: false });

    let scrollTimer;
    viewport.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const center = viewport.getBoundingClientRect().left + viewport.clientWidth / 2;
        let closestIndex = currentIndex;
        let closestDistance = Number.POSITIVE_INFINITY;
        document.querySelectorAll('.save-card').forEach(card => {
          const bounds = card.getBoundingClientRect();
          const distance = Math.abs((bounds.left + bounds.width / 2) - center);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestIndex = Number(card.dataset.index);
          }
        });
        if (closestIndex !== currentIndex) select(closestIndex, false);
      }, 140);
    });

    let dragging = false;
    let dragStart = 0;
    let scrollStart = 0;
    viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button, select')) return;
      dragging = true;
      dragStart = event.clientX;
      scrollStart = viewport.scrollLeft;
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener('pointermove', event => {
      if (dragging) viewport.scrollLeft = scrollStart - (event.clientX - dragStart);
    });
    viewport.addEventListener('pointerup', () => { dragging = false; });
    viewport.addEventListener('pointercancel', () => { dragging = false; });

    window.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); select(currentIndex - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); select(currentIndex + 1); }
      if (event.key === 'Home') { event.preventDefault(); select(0); }
      if (event.key === 'End') { event.preventDefault(); select(commits.length - 1); }
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'patch') {
        requested.delete(message.index);
        loaded.add(message.index);
        const card = document.querySelector('.save-card[data-index="' + message.index + '"]');
        const patch = card?.querySelector('.patch');
        const loading = card?.querySelector('.loading');
        const parsed = parsePatch(message.patch);
        updateSummary(message.index, parsed);
        if (patch) {
          patch.innerHTML = renderParsed(parsed);
          patch.hidden = false;
        }
        if (loading) loading.hidden = true;
      } else if (message.type === 'current') {
        setCurrent(message.index, false);
      }
    });

    setCurrent(currentIndex, false);
    requestAnimationFrame(() => setCurrent(currentIndex, true));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose() {
    this.panel?.dispose();
  }
}

module.exports = { ChangeViewer };
