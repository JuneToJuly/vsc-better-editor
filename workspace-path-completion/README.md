# Workspace Path Completion

Autocomplete files and directories while typing string literals in VS Code.

## Java semantics

Java completion is intentionally based on the two ways files are normally loaded at runtime:

- **Resource** — files below a configured resource root are inserted relative to that classpath root.
- **Absolute** — every indexed file can be inserted using its absolute filesystem path.

For example, if the workspace contains:

```text
C:/dev/orders/src/main/resources/templates/invoice.html
```

generic Java string completion offers:

```text
/templates/invoice.html                         Resource
C:/dev/orders/src/main/resources/templates/invoice.html   Absolute
```

API context adjusts ranking and syntax:

```java
Order.class.getResource("/templates/invoice.html");
Order.class.getResourceAsStream("/templates/invoice.html");
Order.class.getClassLoader().getResource("templates/invoice.html");
Order.class.getClassLoader().getResourceAsStream("templates/invoice.html");
new File("C:/dev/orders/data/input.json");
Path.of("C:/dev/orders/data/input.json");
Paths.get("C:/dev/orders/data/input.json");
```

`Class.getResource*` prefers root-relative resource names beginning with `/`. `ClassLoader.getResource*` prefers classpath names without `/`. Filesystem APIs prefer absolute paths.

By default these resource roots are recognized across multi-project workspaces:

```json
"workspacePathCompletion.resourceRoots": [
  "**/src/main/resources",
  "**/src/test/resources"
]
```

Add custom Gradle resource roots to that setting when needed.

For non-Java languages the extension retains workspace-relative/current-file-relative completion behavior.


## Completion display

Absolute filesystem candidates intentionally separate **display text** from **inserted text**. The suggestion list shows the a shortened tail path with the filename at the end, while accepting it inserts the complete absolute path.

For example, a file at:

```text
C:/Users/me/work/orders/src/main/resources/config/fraud-rules.json
```

appears roughly as:

```text
…/src/main/resources/config/fraud-rules.json    Absolute
```

but inserts the full absolute path. Resource candidates continue to show their concise classpath-relative resource path directly.

## Completion behavior

Completion is available inside string literals. Typing letters, digits, `/`, `\\`, `.`, `-`, `_`, `@`, or `~` triggers the provider directly, so it does not depend on `editor.quickSuggestions.strings` being enabled. `Ctrl+Space` also invokes it normally.

Directories are completion candidates and accepting one retriggers suggestions so path traversal can continue.

## Indexing

The extension indexes workspace files once and rebuilds when files are created/deleted/renamed, workspace folders change, or relevant include/exclude settings change. Changes to both `files.exclude` and `search.exclude` always trigger a debounced rebuild. Rebuild requests that arrive while an index scan is already running are queued and coalesced instead of being dropped. It respects:

`build/` is intentionally **not** excluded by default because generated runtime artifacts (scripts, jars, configs, etc.) can be valid path-completion targets. If your VS Code `files.exclude` or `search.exclude` explicitly excludes build directories, that explicit setting is still respected.

- `files.exclude`
- `search.exclude`
- `workspacePathCompletion.exclude`
- `workspacePathCompletion.include`

Files do not need to belong to an active JDT project.

## Fuzzy ranking

`fzf` is optional. The default backend is `auto`: if `fzf` is available and the candidate set is large enough it is used as a first-pass filter, followed by the extension's path-aware ranking. Without `fzf`, the built-in matcher is used automatically.

```json
"workspacePathCompletion.rankingBackend": "auto"
```

Use `"internal"` to never invoke `fzf`.

## Commands

- **Workspace Path Completion: Rebuild Index**
- **Workspace Path Completion: Show Index Stats**


## Exclusion behavior

The index always respects `workspacePathCompletion.exclude` and VS Code `files.exclude`.

By default it **does not** apply `search.exclude`, because generated runtime files (for example files under Gradle `build/`) are often hidden from text search but still useful as path completions. To opt back into search exclusions:

```json
{
  "workspacePathCompletion.useSearchExclude": true
}
```

Changing this setting automatically rebuilds the index. Changes to `search.exclude` also trigger an index refresh even while this toggle is off; the patterns are simply ignored during filtering until the toggle is enabled.


## Fuzzy matching (0.3.4)

Ranking now follows one deterministic contract across all path completions:

- Query characters must occur in candidate order.
- Every matched character contributes a fixed positive score.
- Consecutive characters receive a strong bonus.
- Semantic boundaries are preferred: path separators, punctuation, whitespace, camelCase transitions, and letter/digit transitions.
- The first query character gets an amplified boundary bonus.
- Opening a gap costs more than extending the same gap.
- Shorter matching spans are preferred.
- Filename is the primary field; full runtime path is the secondary field.
- Java/API relevance only breaks close textual matches and cannot rescue a poor textual match.
- Final ties retain stable index order.

`fzf` is still detected for diagnostics/compatibility, but completion ranking no longer delegates to it. This guarantees identical fuzzy ordering on every machine.


## 0.3.4 completion refresh fix

Completion results are now returned as an incomplete VS Code `CompletionList`, so the provider is re-run as the query grows instead of letting VS Code only filter a stale capped result set. `filterText` is also filename-first to match the extension's primary-field fuzzy ranking.


## 0.3.4 indexing fix

VS Code `workspace.findFiles()` treats an `undefined` exclude argument as permission to apply its default search excludes. The extension now passes `null` so no hidden VS Code search exclusion is applied during enumeration. It then applies `workspacePathCompletion.exclude`, `files.exclude`, and (only when enabled) `search.exclude` itself. This makes `useSearchExclude: false` reliable for files such as Gradle build outputs.

A new **Workspace Path Completion: Diagnose Query** command reports whether a filename/query is actually present in the index and shows its fuzzy score.


## 0.3.4 — Bidirectional fuzzy matching

Filename/path fuzzy matching now works in both directions. A typed string may be a fuzzy subsequence of the candidate, or the candidate may be a fuzzy subsequence of a longer typed string. This means `testbuild.gradle` and `build.gradletest` can both suggest `build.gradle`. The same boundary, consecutive-run, gap, span, primary-field, and stable-order rules are used in both directions.


## 0.3.5 — Reverse-match coverage filtering

Reverse fuzzy matching now requires the candidate text to cover at least 60% of the typed query. This preserves useful filename matches such as `build.gradle` for both `testbuild.gradle` and `build.gradletest`, while removing weak partial reverse matches such as a `build/` directory for the query `build.gradletest`. Forward fuzzy matching is unchanged.

## 0.3.6 — Qualified reverse filename matching

Reverse filename matching no longer discards extra typed characters as noise. If the complete filename appears inside a longer query, any text before or after the filename becomes a qualifier and must fuzzy-match the file's directory/workspace context.

Examples for a real file named `build.gradle`:

- `build.gradle` -> normal primary filename match.
- `testbuild.gradle` -> the extra `test` must be explained by directory/workspace context (normal full-path forward matching may also satisfy this).
- `build.gradletest` -> `build.gradle` is the primary match and trailing `test` must match directory/workspace context.
- A plain `services/order-service/build.gradle` will therefore NOT match `build.gradletest` merely because `build.gradle` is contained in the query.

Directories do not use this reverse filename-qualifier behavior.
