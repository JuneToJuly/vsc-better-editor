const vscode = require('vscode');
const { GitRepository } = require('./git');
const {
  GitDocumentProvider,
  TimelineProvider
} = require('./timeline');
const { ReplayCodeLensProvider, ReplaySession } = require('./player');
const { ChangeViewer } = require('./changeViewer');

let recordingPaused = false;
let snapshotQueue = Promise.resolve();

function activate(context) {
  const timelineProvider = new TimelineProvider();
  const treeView = vscode.window.createTreeView('trackerTimeline', {
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
      await vscode.commands.executeCommand('trackerTimeline.focus');
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
  const changeViewer = new ChangeViewer(context, async (repository, commit) => {
    const item = await timelineProvider.activateCommit(repository.root, commit.hash);
    if (!item) {
      return;
    }

    try {
      await treeView.reveal(item, {
        select: true,
        focus: false,
        expand: false
      });
    } catch {
      // The viewer remains usable if the timeline view is hidden.
    }
  });
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );

  function updateStatus() {
    const enabled = vscode.workspace
      .getConfiguration('trackerTimeline')
      .get('enabled', true);

    if (!enabled) {
      statusItem.hide();
      return;
    }

    statusItem.text = recordingPaused
      ? '$(debug-pause) Tracker: Paused'
      : '$(history) Tracker: Recording';
    statusItem.tooltip = recordingPaused
      ? 'Resume save timeline recording'
      : 'Pause save timeline recording';
    statusItem.command = recordingPaused
      ? 'trackerTimeline.resume'
      : 'trackerTimeline.pause';
    statusItem.show();
  }

  context.subscriptions.push(
    timelineProvider,
    replaySession,
    changeViewer,
    treeView,
    statusItem,
    vscode.workspace.registerTextDocumentContentProvider(
      'tracker-git',
      gitDocumentProvider
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'tracker-git' },
      new ReplayCodeLensProvider(replaySession)
    ),
    vscode.commands.registerCommand('trackerTimeline.refresh', () => {
      timelineProvider.refresh();
    }),
    vscode.commands.registerCommand('trackerTimeline.openCurrent', () => {
      return vscode.commands.executeCommand('workbench.view.extension.tracker');
    }),
    vscode.commands.registerCommand('trackerTimeline.pause', () => {
      recordingPaused = true;
      updateStatus();
    }),
    vscode.commands.registerCommand('trackerTimeline.resume', () => {
      recordingPaused = false;
      updateStatus();
    }),
    vscode.commands.registerCommand('trackerTimeline.openViewer', async item => {
      const target = item || treeView.selection[0] || await timelineProvider.getDefaultItem();
      if (!target) {
        await vscode.window.showInformationMessage(
          'No Tracker saves are available for the current repository.'
        );
        return;
      }
      return changeViewer.open(target);
    }),
    vscode.commands.registerCommand('trackerTimeline.openDiff', item => {
      return replaySession.open(item);
    }),
    vscode.commands.registerCommand('trackerTimeline.previousDiff', () => {
      return replaySession.previous();
    }),
    vscode.commands.registerCommand('trackerTimeline.nextDiff', () => {
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
        'trackerTimeline',
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
            `Tracker could not record this save: ${message}`
          );
        });
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('trackerTimeline')) {
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
