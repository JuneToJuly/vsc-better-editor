# Composite Gradle Test Launcher

Current version: **0.1.73**

Run and debug Java tests through a **root Gradle composite build**, even when the standard VS Code Java test runner cannot model the build correctly.

## Features

- Run the JUnit test method under the cursor.
- Debug the test method under the cursor and attach automatically.
- Run or debug the containing test class.
- CodeLens actions above detected JUnit tests.
- Repeat the last test with `Ctrl+Shift+R` (`Cmd+Shift+R` on macOS).
- Stop the current Gradle process.
- Map test source trees to tasks exposed by the root composite build.
- Use either an installed `gradle` command or a configured wrapper.
- Select a named folder in a multi-root VS Code workspace.

## Required extension

Install Microsoft **Debugger for Java**. Debug runs invoke its Java attach debugger.

## Composite-build configuration

The current Java file determines the test class and method. It does **not** determine the Gradle working directory. Gradle always runs from `compositeRoot`, where the root `settings.gradle` or `settings.gradle.kts` contains the `includeBuild(...)` declarations.

For a multi-root workspace containing a folder named `test-workspace`:

```json
{
  "compositeGradleTests.compositeRoot": "${workspaceFolder:test-workspace}",
  "compositeGradleTests.gradleExecutable": "gradle",

  "compositeGradleTests.projects": [
    {
      "sourceRoot": "my-lib/src/test/java",
      "task": ":my-lib:test"
    },
    {
      "sourceRoot": "test-gradle-projects/app/src/test/java",
      "task": ":test-gradle-projects:app:test"
    }
  ],

  "compositeGradleTests.defaultTask": "test",
  "compositeGradleTests.arguments": [
    "--console=plain"
  ],
  "compositeGradleTests.debugArguments": [
    "--debug-jvm"
  ],
  "compositeGradleTests.debugPort": 5005
}
```

Use the actual included-build task paths reported by your root composite build. You can inspect them with:

```text
gradle tasks --all
```

The mapping with the longest matching `sourceRoot` wins. Mapping paths are relative to `compositeGradleTests.compositeRoot`.

## Installed Gradle versus wrapper

The default is:

```json
"compositeGradleTests.gradleExecutable": "gradle"
```

This resolves Gradle through `PATH`. On Windows, the extension launches `gradle.bat` safely through `cmd.exe`, avoiding the `spawn EINVAL` error produced when a batch script is spawned as a native executable.

To use a wrapper instead:

```json
{
  "compositeGradleTests.gradleWrapper": "gradlew.bat"
}
```

`gradleWrapper` overrides `gradleExecutable` when it is non-empty.

## Commands

- `Composite Gradle: Run Test Under Cursor`
- `Composite Gradle: Debug Test Under Cursor`
- `Composite Gradle: Run Test Class`
- `Composite Gradle: Debug Test Class`
- `Composite Gradle: Repeat Last Test`
- `Composite Gradle: Stop Current Test`
- `Composite Gradle: Copy Last Command`

## How debugging works

A debug invocation runs a command equivalent to:

```text
gradle :includedBuild:project:test --tests fully.qualified.TestClass.testMethod --debug-jvm --console=plain
```

Gradle runs from the configured composite root. The extension watches for the JVM debug-listener message and attaches the Java debugger to the configured port, which defaults to `5005`.

## Known limitations

- Java document symbols must be available, normally from the Red Hat Java extension.
- Dynamic or generated test names may not match Gradle method filtering exactly.
- Overloaded test methods are filtered by method name.
- CodeLens detects common JUnit annotations in the eight lines preceding a method declaration. Configure `compositeGradleTests.testAnnotations` for custom annotations.


## 0.1.2

- Fixed test-method detection when the Java language server excludes annotations from document-symbol ranges or has not finished importing the project.
- Added a lightweight Java source fallback parser for JUnit methods, package-private tests, same-line annotations, nested classes, and CodeLens discovery.

## 0.1.3

- Automatically derives the composite task path from the test file.
- A test under `test-gradle-projects/app/src/test/java` resolves to `test-gradle-projects:app:test`.
- Deeper projects resolve similarly, such as `parent:sub-project:test`.
- Reads `rootProject.name` from the included build's `settings.gradle` or `settings.gradle.kts`; otherwise uses the included-build directory name.
- Uses the source-set name as the task for nonstandard source sets such as `src/integrationTest/java`.
- Explicit `projects` mappings still override automatic detection.

## Focused test results

Version 0.1.6 adds a dedicated results panel that opens when a test starts and updates when it finishes. It shows:

- The exact test filter and composite Gradle task
- Passed, failed, skipped, or running status
- Test duration
- Captured standard output and standard error
- Failure details and stack traces
- Run Again, Debug, Open Test, Copy Command, and Raw Gradle Output actions
- The last 30 test runs in workspace-local history

The extension injects a small Gradle init script at runtime so all included-build `Test` tasks report test events and standard streams. Disable this with:

```json
{
  "compositeGradleTests.enhancedTestLogging": false
}
```

Use **Composite Gradle: Show Test History** to reopen the panel. The raw Gradle output remains available through **Composite Gradle: Show Latest Test Result** or the panel's **Raw Gradle Output** button.


## Persistent results view

Version 0.1.6 adds a dedicated **Gradle Tests** Activity Bar view. It remains available beside the editor, shows the latest result and recent history, and provides working Run Again, Debug, Open Test, Copy Command, Raw Output, and Clear actions.


## 0.1.6

- Refined Activity Bar typography and layout.
- Console now contains only test standard output/error.
- Gradle test events and build lifecycle output are separated from test console output.
- Improved compact buttons, metadata, history rows, and failure presentation.

## 0.1.11

- Compact results toolbar instead of large full-width buttons.
- Run or debug the entire containing test class from class CodeLens, the editor context menu, or any result in the Gradle Tests panel.
- Class runs use the fully qualified class filter with the same composite task resolution as method runs.
- Deduplicated per-test result rows for class runs.
- Cleaner separation between test output, assertion failures, and Gradle metadata.


## Independent gutter icons

Version 0.1.11 does not register a VS Code TestController and does not use Test Explorer or the Java Test Runner. It uses ordinary editor gutter decorations. Hover the class or method icon to run or debug through the configured root composite Gradle build.

## 0.1.17 UI changes

- Recent runs are anchored at the top of the Gradle Tests view.
- Selecting a run displays its result and output below the history.
- Independent clickable `Run Test`, `Debug Test`, `Run Class`, and `Debug Class` editor actions are shown through CodeLens.
- The custom gutter remains a status marker and does not use VS Code Test Explorer or the Java Test Runner.
- Result actions now match the original scope: method runs rerun/debug the method; class runs rerun/debug the class.


## 0.1.17

- Removed editor gutter markers so old pass/fail state cannot become misleading.
- Class runs now preserve every failed test rather than only the first failure.
- Failures are grouped by test case, each with its own assertion summary, source location, user frames, and collapsible framework frames.

## 0.1.17

- Fixed individual-test failure locations by matching the concrete test class and Java source file before framework/package fallbacks.
- Handles Gradle module-qualified frames such as `app//my.lib.AppTest.testName(AppTest.java:19)`.


## 0.1.20

- Added a lightweight native Project Tests explorer without using VS Code's Testing API.
- Discovers annotated Java tests and groups them by Gradle task, class, and method.
- Shows latest known passed, failed, skipped, running, stale, and not-run states.
- Run, debug, or open tests directly from the tree.
- Added Refresh and Run Failed toolbar actions.

## 0.1.23

- Added **Open Last Run Test** to jump directly to the most recently executed test case.
- Java debugger attach configurations now include the owning Java project name so the Debug Console resolves the correct project context.


## 0.1.26

- Replaced the webview textarea evaluator with a real untitled Java editor.
- VSCodeVim, selections, undo/redo, syntax highlighting, and normal editor keybindings now work.
- Press `Ctrl+Enter` to evaluate the selection or the entire scratch document.
- Debug-adapter completions are surfaced through VS Code's native completion widget and replace only the identifier under the cursor.
- Evaluation output is written to the **Composite Gradle Evaluate** output channel.
- The attach debugger now asks the Java language server for the owning Java project name before falling back to Gradle path inference.


## 0.1.26

- Force Evaluate results output channel to open and receive focus after Ctrl+Enter.
- Show a status-bar preview for successful evaluations.
- Surface evaluation errors as visible notifications in addition to the output channel.


## 0.1.27

- Reworked Evaluate Expression output into a visible companion result panel.
- Tracks the debugger stopped thread before resolving the active stack frame.
- Ctrl+Enter now evaluates from the real Java scratch editor without relying on a fragile custom context key.
- Shows expression results, object fields, and errors directly beside the editor.


## 0.1.28

- Fixed evaluation failures caused by passing a guessed Java project name to the debugger.
- The attach configuration now includes `projectName` only when explicitly configured or positively resolved by the Java language server.
- Added `compositeGradleTests.javaProjectName` as an exact-name override.
- Evaluate Expression now works directly in the paused frame without generated import lines.


## 0.1.29

- Refined Evaluate into a compact debugger-style layout.
- Added paused frame context, aligned name/value/type columns, and lazy object expansion.
- Added persistent evaluation history that can restore expressions to the scratch editor.
- Reduced the scratch editor instructions to a single line.


## 0.1.30

- Keeps the Evaluate scratch editor above the result view in a consistent vertical layout.
- Selecting evaluation history replaces the existing scratch document contents without opening another editor.

## 0.1.31

- Test Explorer, Open Last Test, result-source, and failure-source navigation now share one configurable open behavior.
- Navigation defaults to a replaceable preview editor in the first editor group.
- Set `compositeGradleTests.navigationOpenMode` to `preview`, `pinned`, or `side`.
- Evaluate scratch editors and explicit editing workflows remain pinned.


## 0.1.32 — Executed code and affected tests

- Added Run Test/Class with Executed Code commands.
- Captures JaCoCo XML per run and shows hit production lines in Test Results.
- Clicking a hit line opens the source and temporarily highlights all lines hit in that file.
- Production-file edits create an Affected Tests group based on prior per-test execution data.
- Added Run Affected Tests.
- Regular runs remain unchanged unless `compositeGradleTests.captureExecutedCode` is enabled.

Executed-code capture uses Gradle's JaCoCo plugin and may require the build environment to resolve JaCoCo artifacts.


## 0.1.33

- Fixed Gradle configuration failures in executed-code runs by resolving JaCoCo classes only after the plugin is applied.
- Improved missing-report guidance to direct users to the exact raw Gradle error.


## Affected tests

Affected Tests uses previously captured JaCoCo execution data. A test appears when a production file it previously executed is edited during the current VS Code session. Use the inline clear action on the Affected Tests row to dismiss the pending affected-test list without deleting coverage history.


## 0.1.47 Flow capture foundation

Capture Flow injects a packaged Byte Buddy Java agent into the forked test JVM, records ordered method entry/exit events, and exposes an ordered replay panel. Byte Buddy is resolved only for opt-in flow runs.


## 0.1.49

Flow capture now uses Byte Buddy 1.17.7, which supports Java 25, matching the API used by the packaged agent.

## Dependency versions and offline repositories

Code Flow and Code Report resolve their instrumentation dependencies through Gradle. The versions are configurable:

```json
{
  "compositeGradleTests.byteBuddyVersion": "1.18.7",
  "compositeGradleTests.jacocoVersion": "0.8.14",
  "compositeGradleTests.dependencyRepository": "file:///opt/offline-maven"
}
```

`dependencyRepository` may be a Maven repository URL or a local repository path. When it is set, the generated Gradle init scripts add that repository before resolving Byte Buddy and JaCoCo. The repository must use normal Maven coordinates:

- `net.bytebuddy:byte-buddy:<byteBuddyVersion>`
- `org.jacoco:org.jacoco.agent:<jacocoVersion>`
- `org.jacoco:org.jacoco.ant:<jacocoVersion>`

The complete flow-agent source is included under `flow-agent/`. The runtime JAR remains a thin agent JAR; Byte Buddy is resolved separately using the configured version.

## Call-site replay

Code Flow records the live JVM caller stack frame for every method entry. The replay expands nested calls into explicit call-site, method entry, method return, and caller-resume steps. Caller source is resolved from the fully qualified class name, including `src/test` for the initiating test method.

## Flow snapshots after return

Code Flow captures the instrumented receiver (`this`) both when a method is entered and when it exits. Return and caller-resume replay steps display the post-method receiver snapshot together with the return value or thrown exception. This makes mutations performed by the method visible after control returns.


## Replay readability (0.1.81)

- Coverage uses subtle gutter emphasis instead of full-width green blocks.
- Unexecuted context is dimmed so the active path is easier to scan.
- Call-tree boundaries have clearer hierarchy and reduced visual weight.
- State comparison becomes responsive at narrower editor widths.
- Changed values receive stronger, localized emphasis.
