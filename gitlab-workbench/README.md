## 0.13.0
- Rebuilt the merge request editor into a denser GitHub-style review workspace with a conversation timeline, compact metadata, merge/readiness summary, and improved Files Changed view.
- Reduced oversized bordered comment blocks and grouped replies into readable discussion threads.
- Kept general MR discussion separate from positioned native-diff review comments.

# GitLab Developer Workbench 0.3.0

Developer-first GitLab UI for VS Code, backed by `glab` with a deterministic demo backend.

## New: Review Explorer

Start a review from any merge request. A dedicated **Review Explorer** appears in the GitLab activity view while the native VS Code diff stays in the editor.

- Changed files grouped by directory/package path
- Reviewed / unreviewed icons
- Current-file indicator
- Per-file `+/-` counts
- Review progress (`3/6`)
- Click any file to jump directly to its native diff
- F7 / Shift+F7 for next / previous file
- Mark Reviewed advances to the next file
- Finish Review closes the review session
- Demo mode keeps reviewed state in memory

Use **GitLab Workbench: Choose Demo Scenario** → **Large Program** to stress-test 120 MRs across 30 repositories without a real GitLab project.

## Run

1. Unzip into your VS Code extensions development folder or open this folder in VS Code.
2. Press F5 to launch an Extension Development Host.
3. Open the GitLab Workbench activity icon.
4. Open an MR and choose **Start Review**.

`npm test` runs the lightweight backend smoke test.

## Managed GitLab projects (0.7.0)

Live mode no longer requires repositories to be cloned into the VS Code workspace. Run **GitLab Workbench: Add Project** and paste a GitLab project URL such as `https://gitlab.com/group/project`. The extension stores the URL in `gitlabWorkbench.managedProjects` and uses `glab api --hostname <host>` for merge requests, diffs, file contents, discussions, replies, approvals, and merges.

Local repository discovery is now optional (`gitlabWorkbench.discoverLocalRepositories`, default `false`). Checkout still requires a local clone; review operations do not.

## 0.10.0 review reliability

Review comments now use the MR's current `diff_refs` and each GitLab diff entry's real `old_path` / `new_path`. Before posting, the selected new-side line is validated against the MR patch. After posting, Workbench reloads discussions and verifies that GitLab returned the comment as a positioned discussion; it no longer silently treats a failed position as a general MR comment. Existing discussions also preserve new/old line metadata and resolvable/resolved state more accurately.

## People Board (v0.11)
The Issues view now defaults to a compact text Kanban layout: assignee → status → issues. Status is inferred from GitLab labels such as `blocked`, `in progress`/`wip`, `review`, and `todo`/`backlog`; issues without a workflow label appear under **Open / Unclassified**. Use **GitLab Workbench: Change Issue View** (or the layout toolbar button) to switch between **People Board** and the classic **Projects** grouping. Existing assignee filters still apply to either view.


## 0.12.0

- Rebuilt the merge request editor around a GitHub-style conversation view.
- Added Conversation and Files changed tabs.
- General MR discussions and replies are visible in the MR editor.
- Added a persistent MR comment composer for general discussion comments.
- Added review/pipeline/branch/thread summary sidebar.
- Files changed view shows per-file code discussion counts and opens native VS Code diffs.
- MR editor opens in the active editor group.

## v0.14.0 - Local review cache

Live merge-request reviews now prepare a local Git object store once when **Start Review** is selected. If a matching local checkout is available, Workbench reuses it; otherwise it creates a private bare clone under VS Code extension global storage using `glab repo clone -- --bare`. Base/head file contents are then read with local `git show` instead of GitLab API requests on every file navigation. GitLab remains the source for discussions and review mutations.

## v0.15.2 Java-aware reviews

Live MR reviews now materialize the MR HEAD as a detached Git worktree. The changed/right side of the VS Code diff is the real file from that worktree, so once JDT imports it normal Java navigation and completion can work there.

`GitLab Workbench: Prepare Java Review Root` asks once for your normal Fast Composite JDT root, generates a disposable review composite root from its settings file, rewrites literal `includeBuild(...)` paths to absolute paths, and substitutes the reviewed repository with the MR worktree when it can match the included build by directory name. If it cannot match it, the MR worktree is added as an included build and the output log says so.

GitLab Workbench does not modify Fast Composite JDT or its private state. It invokes Fast Composite JDT's existing public `Add Composite Root` / `Switch Composite Root` commands. Because those commands intentionally own their interactive root picker, the first registration requires selecting the generated review-root folder; GitLab Workbench copies that path to the clipboard before opening the command. Subsequent switching uses Fast Composite JDT's existing switch command.


## 0.15.2
Review Git caches, worktrees, and generated composite roots now live under `<workspace>/.glw`. Worktree creation is non-interactive, validates the target commit, logs the exact Git command, and times out instead of hanging indefinitely. Repository discovery ignores the Workbench directory.


## v0.15.2 review checkout

Live reviews now use a normal workspace-local Git clone under `.glw/r/<short-project-id>/<iid>` instead of a bare cache plus `git worktree`. The clone is reused, fetched, and detached at the exact MR head SHA. This directory is also the real-file/JDT review project used by the generated Fast Composite root.


## v0.15.6

Restores/preserves the exact v0.15.2 workspace-local `glab repo clone` execution path and adds clone subprocess boundary diagnostics (begin, return/error, elapsed time, stdout/stderr, and `.git` validation). Composite-root instrumentation from v0.15.4 remains in place.


### 0.15.6
Windows review clones now use the shorter `<workspace>/.glw/r/<short-project-id>/<iid>` review paths and enable Git for Windows `core.longpaths=true` for clone/fetch/checkout/reset operations. This avoids checkout failures on deep Java package paths while keeping review repositories workspace-local. Existing partial review clones are reused and repaired by the long-path-enabled reset path when possible.

## v0.15.8

Java review composite roots are now intentionally minimal. GitLab Workbench no longer asks for, copies, or rewrites the user's existing composite root. For an MR it generates only a disposable `settings.gradle` containing `includeBuild('<workspace review clone>')`, then launches Fast Composite JDT's existing Add Composite Root selector so the user can add/switch to that generated root.


## v0.15.8
- Standard review checkout is now the default; Fast Composite JDT root preparation is opt-in via `gitlabWorkbench.prepareCompositeRootOnStart`.
- The existing **Prepare Java Review Root** action remains available when Java/composite navigation is needed.
- Review diffs default to unified/inline mode via `gitlabWorkbench.unifiedDiff`.
