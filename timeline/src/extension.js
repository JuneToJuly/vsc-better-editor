const vscode = require('vscode');
const { GitRepository } = require('./git');
const {
  GitDocumentProvider,
  TimelineProvider
} = require('./timeline');
const { ReplayCodeLensProvider, ReplaySession } = require('./player');

let recordingPaused = false;
let snapshotQueue = Promise.resolve();

function activate(context) {
  const timelineProvider = new TimelineProvider();
  const treeView = vscode.window.createTreeView('xPlaneTimeline', {
    treeDataProvider: timelineProvider,
    showCollapseAll: false
  });
  const gitDocumentProvider = new GitDocumentProvider();
  const replaySession = new ReplaySession(async (repository, commit) => {
    const item = await timelineProvider.activateCommit(repository.root, commit.hash);
    if (!item) {
      return;
    }

    try {
      // VS Code does not always commit a TreeView selection when reveal() is
      // invoked from a diff/peek editor with focus:false. Briefly focus the
      // timeline, select the exact live item, then return focus to the editor.
      await vscode.commands.executeCommand('xPlaneTimeline.focus');
      await treeView.reveal(item, {
        select: true,
        focus: true,
        expand: false
      });
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    } catch {
      // Keep diff navigation usable even if the view is temporarily unavailable.
    }
  });
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );

  function updateStatus() {
    const enabled = vscode.workspace
      .getConfiguration('xPlaneTimeline')
      .get('enabled', true);

    if (!enabled) {
      statusItem.hide();
      return;
    }

    statusItem.text = recordingPaused
      ? '$(debug-pause) X-Plane: Paused'
      : '$(history) X-Plane: Recording';
    statusItem.tooltip = recordingPaused
      ? 'Resume save timeline recording'
      : 'Pause save timeline recording';
    statusItem.command = recordingPaused
      ? 'xPlaneTimeline.resume'
      : 'xPlaneTimeline.pause';
    statusItem.show();
  }

  context.subscriptions.push(
    timelineProvider,
    replaySession,
    treeView,
    statusItem,
    vscode.workspace.registerTextDocumentContentProvider(
      'x-plane-git',
      gitDocumentProvider
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'x-plane-git' },
      new ReplayCodeLensProvider(replaySession)
    ),
    vscode.commands.registerCommand('xPlaneTimeline.refresh', () => {
      timelineProvider.refresh();
    }),
    vscode.commands.registerCommand('xPlaneTimeline.openCurrent', () => {
      return vscode.commands.executeCommand('workbench.view.extension.xPlane');
    }),
    vscode.commands.registerCommand('xPlaneTimeline.pause', () => {
      recordingPaused = true;
      updateStatus();
    }),
    vscode.commands.registerCommand('xPlaneTimeline.resume', () => {
      recordingPaused = false;
      updateStatus();
    }),
    vscode.commands.registerCommand('xPlaneTimeline.openDiff', item => {
      return replaySession.open(item);
    }),
    vscode.commands.registerCommand('xPlaneTimeline.previousDiff', () => {
      return replaySession.previous();
    }),
    vscode.commands.registerCommand('xPlaneTimeline.nextDiff', () => {
      return replaySession.next();
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      return replaySession.updateContext(editor?.document.uri);
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (recordingPaused || document.uri.scheme !== 'file') {
        return;
      }

      const configuration = vscode.workspace.getConfiguration(
        'xPlaneTimeline',
        document.uri
      );
      if (!configuration.get('enabled', true)) {
        return;
      }

      snapshotQueue = snapshotQueue
        .then(async () => {
          const root = await GitRepository.findRoot(document.uri.fsPath);
          if (!root) {
            return;
          }

          timelineProvider.setRepositoryRoot(root);
          const repository = new GitRepository(root);
          const includeUntracked = configuration.get('includeUntracked', true);
          await repository.createSnapshot(document.uri.fsPath, includeUntracked);
          timelineProvider.refresh();
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(
            `X-Plane could not record this save: ${message}`
          );
        });
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('xPlaneTimeline')) {
        updateStatus();
        timelineProvider.refresh();
      }
    })
  );

  updateStatus();
  replaySession.updateContext(vscode.window.activeTextEditor?.document.uri);
}

function deactivate() {
  return snapshotQueue;
}

module.exports = { activate, deactivate };
