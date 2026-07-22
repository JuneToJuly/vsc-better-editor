const path = require('node:path');
const vscode = require('vscode');
const { GitRepository } = require('./git');

class TimelineItem extends vscode.TreeItem {
  constructor(commit, repository) {
    const label = commit.savedFile ? path.basename(commit.savedFile) : commit.subject;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.commit = commit;
    this.repository = repository;
    this.contextValue = 'xPlaneSave';
    this.description = new Date(commit.timestamp * 1000).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    });

    const changedDescription = commit.changedFiles.length === 1
      ? commit.changedFiles[0]
      : `${commit.changedFiles.length} files changed`;

    this.tooltip = new vscode.MarkdownString([
      `**${commit.subject}**`,
      '',
      `Branch: \`${commit.branch || 'unknown'}\``,
      '',
      `Commit: \`${commit.hash.slice(0, 12)}\``,
      '',
      changedDescription
    ].join('\n'));

    this.iconPath = new vscode.ThemeIcon('history');
    this.command = {
      command: 'xPlaneTimeline.openDiff',
      title: 'Open Save Diff',
      arguments: [this]
    };
  }
}

class TimelineProvider {
  constructor() {
    this.changedEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changedEmitter.event;
    this.repositoryRoot = undefined;
    this.cachedItems = [];
  }

  setRepositoryRoot(root) {
    if (root) {
      this.repositoryRoot = root;
    }
  }

  refresh() {
    this.changedEmitter.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  async resolveRepositoryRoot() {
    const editor = vscode.window.activeTextEditor;
    const candidates = [];
    if (editor?.document.uri.scheme === 'file') {
      candidates.push(editor.document.uri.fsPath);
    }
    if (this.repositoryRoot) {
      candidates.push(this.repositoryRoot);
    }
    for (const folder of vscode.workspace.workspaceFolders || []) {
      candidates.push(folder.uri.fsPath);
    }

    for (const candidate of candidates) {
      const root = await GitRepository.findRoot(candidate);
      if (root) {
        this.repositoryRoot = root;
        return root;
      }
    }
    return undefined;
  }

  async getChildren() {
    const root = await this.resolveRepositoryRoot();
    if (!root) {
      // A refresh while a virtual X-Plane diff has focus must not visually
      // erase a timeline that was already loaded.
      return this.cachedItems;
    }

    try {
      const repository = new GitRepository(root);
      const maxEntries = vscode.workspace
        .getConfiguration('xPlaneTimeline')
        .get('maxVisibleEntries', 250);

      const commits = await repository.listTimeline(maxEntries);
      this.cachedItems = commits.map(commit => new TimelineItem(commit, repository));
      return this.cachedItems;
    } catch {
      return this.cachedItems;
    }
  }

  dispose() {
    this.changedEmitter.dispose();
  }
}

class GitDocumentProvider {
  async provideTextDocumentContent(uri) {
    const query = new URLSearchParams(uri.query);
    const root = query.get('root');
    const commit = query.get('commit');
    const file = query.get('file');

    if (!root || !commit || !file) {
      return '';
    }

    return new GitRepository(root).showFile(commit, file);
  }
}

function historicalUri(root, commit, file) {
  return vscode.Uri.from({
    scheme: 'x-plane-git',
    path: `/${file}`,
    query: new URLSearchParams({ root, commit, file }).toString()
  });
}

module.exports = {
  GitDocumentProvider,
  historicalUri,
  TimelineItem,
  TimelineProvider
};
