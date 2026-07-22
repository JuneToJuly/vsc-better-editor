const vscode = require('vscode');
const { historicalUri } = require('./timeline');

class ReplaySession {
  constructor() {
    this.repository = undefined;
    this.commits = [];
    this.currentIndex = -1;
    this.changedEmitter = new vscode.EventEmitter();
    this.onDidChange = this.changedEmitter.event;
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
    await this.openCurrentDiff();
  }

  async previous() {
    if (!this.canGoPrevious()) {
      return;
    }

    this.currentIndex -= 1;
    await this.openCurrentDiff();
  }

  async next() {
    if (!this.canGoNext()) {
      return;
    }

    this.currentIndex += 1;
    await this.openCurrentDiff();
  }

  canGoPrevious() {
    return this.repository !== undefined && this.currentIndex > 0;
  }

  canGoNext() {
    return this.repository !== undefined
      && this.currentIndex >= 0
      && this.currentIndex < this.commits.length - 1;
  }

  isCurrentDiffUri(uri) {
    if (!uri || uri.scheme !== 'x-plane-git' || !this.repository) {
      return false;
    }

    const commit = this.commits[this.currentIndex];
    if (!commit) {
      return false;
    }

    const query = new URLSearchParams(uri.query);
    const uriCommit = query.get('commit');
    return query.get('root') === this.repository.root
      && (uriCommit === commit.hash || uriCommit === commit.parent);
  }

  isCurrentAfterUri(uri) {
    if (!this.isCurrentDiffUri(uri)) {
      return false;
    }

    const commit = this.commits[this.currentIndex];
    const query = new URLSearchParams(uri.query);
    return query.get('commit') === commit?.hash;
  }

  async updateContext(activeUri) {
    const active = this.isCurrentDiffUri(activeUri);
    await Promise.all([
      vscode.commands.executeCommand('setContext', 'xPlaneTimeline.replayDiffActive', active),
      vscode.commands.executeCommand(
        'setContext',
        'xPlaneTimeline.canPreviousDiff',
        active && this.canGoPrevious()
      ),
      vscode.commands.executeCommand(
        'setContext',
        'xPlaneTimeline.canNextDiff',
        active && this.canGoNext()
      )
    ]);
  }

  async openCurrentDiff() {
    const commit = this.commits[this.currentIndex];
    if (!this.repository || !commit || !commit.parent) {
      await vscode.window.showInformationMessage(
        'This save has no file diff to display.'
      );
      return;
    }

    const file = commit.savedFile || commit.changedFiles[0];
    if (!file) {
      await vscode.window.showInformationMessage(
        'This save has no file diff to display.'
      );
      return;
    }

    const before = historicalUri(this.repository.root, commit.parent, file);
    const after = historicalUri(this.repository.root, commit.hash, file);

    await vscode.commands.executeCommand(
      'vscode.diff',
      before,
      after,
      `${file} — Save ${this.currentIndex + 1} of ${this.commits.length}`,
      { preview: true }
    );

    await this.updateContext(after);
    this.changedEmitter.fire();
  }

  dispose() {
    this.changedEmitter.dispose();
  }
}

class ReplayCodeLensProvider {
  constructor(session) {
    this.session = session;
    this.onDidChangeCodeLenses = session.onDidChange;
  }

  provideCodeLenses(document) {
    // Only show the controls on the right-hand/current-save document. Showing
    // them on both sides of a diff would duplicate the navigation row.
    if (!this.session.isCurrentAfterUri(document.uri)) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);
    const lenses = [];

    if (this.session.canGoPrevious()) {
      lenses.push(new vscode.CodeLens(range, {
        title: '$(arrow-left) Previous Diff',
        command: 'xPlaneTimeline.previousDiff',
        tooltip: 'Open the preceding X-Plane save diff'
      }));
    }

    if (this.session.canGoNext()) {
      lenses.push(new vscode.CodeLens(range, {
        title: 'Next Diff $(arrow-right)',
        command: 'xPlaneTimeline.nextDiff',
        tooltip: 'Open the following X-Plane save diff'
      }));
    }

    return lenses;
  }
}

module.exports = { ReplayCodeLensProvider, ReplaySession };
