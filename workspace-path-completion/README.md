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

Absolute filesystem candidates intentionally separate **display text** from **inserted text**. The suggestion list shows the filename first with a shortened parent-directory hint, while accepting it inserts the complete absolute path.

For example, a file at:

```text
C:/Users/me/work/orders/src/main/resources/config/fraud-rules.json
```

appears roughly as:

```text
fraud-rules.json    …/src/main/resources/config/    Absolute
```

but inserts the full absolute path. Resource candidates continue to show their concise classpath-relative resource path directly.

## Completion behavior

Completion is available inside string literals. Typing letters, digits, `/`, `\\`, `.`, `-`, `_`, `@`, or `~` triggers the provider directly, so it does not depend on `editor.quickSuggestions.strings` being enabled. `Ctrl+Space` also invokes it normally.

Directories are completion candidates and accepting one retriggers suggestions so path traversal can continue.

## Indexing

The extension indexes workspace files once and rebuilds when files are created/deleted/renamed, workspace folders change, or relevant include/exclude settings change. It respects:

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
