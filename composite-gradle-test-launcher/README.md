# Composite Gradle Test Launcher

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


## 0.1.19

- Increased gutter pass/fail marker visibility.
- Larger filled pass/fail indicators.
- Easier to distinguish the last executed test at a glance.

## 0.1.20

- Compressed the selected-run header with an inline status and duration.
- Reworked the result toolbar into compact native-style actions.
- Simplified recent-run rows and removed repeated status text.
- Removed duplicated class names from per-test results and failure headings.
- Added a compact vertical failure navigator for class runs.
- Reduced failure-card spacing and made captured output more terminal-like.
- Added subtle status-colored emphasis to the selected run.
- Increased last-run gutter markers to 12px for slightly better visibility.



## 0.1.21

- Replaced improvised toolbar glyphs with native-looking inline line icons.
- Reduced selected-history emphasis to preserve test status readability.
- Improved selected-run alignment and metadata spacing.
- Made failure navigation more obviously interactive.
- Simplified failure cards to a neutral frame with a focused red accent.
- Moved the class result summary above test output.


## 0.1.22

- Pinned the class result summary above failure details.
- Added more breathing room to the selected run, toolbar, history rows, sections, failure cards, and output.
- Preserved the compact developer-tool layout while improving scanability.

## 0.1.23

- Added a stronger GitHub-style visual boundary between recent runs and the selected result.
- Gave the selected result area its own editor-backed surface.
- Added a wide divider band so history and result content read as separate regions.
