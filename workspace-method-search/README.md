# Workspace Method Search

## 0.8.0 reliability / branch reconciliation

- Fixed a `Cannot read properties of undefined (reading 'trim')` crash in UI refreshes by normalizing missing queries and replacing ambiguous positional `sendState` arguments with an options object.
- Every Method Search invocation now reconciles the currently included source-file set with the cached index.
- File size/mtime fingerprints detect same-path files changed by Git branch checkout or other external workspace changes.
- Added/removed/changed files are updated incrementally; unchanged files are not re-indexed.
- `files.exclude`, `search.exclude`, and Workspace Method Search include/exclude setting changes still trigger a full rebuild.

## 0.7.0 open-document index consistency

The incremental index now guards every per-file refresh with a generation token and document version, so an older JDT symbol response cannot overwrite a newer one. Opening Workspace Methods refreshes the currently active source document first, then other open source documents, before presenting cached results. Dirty documents also get retry protection against transient empty/partial symbol trees.


## 0.6.0 search eligibility fix

A result must now have at least one query term that fuzzy-matches the **bare method name**. Secondary fields (class/type, signature, parameters, file/path) can refine a query, but they can no longer make an unrelated method appear by themselves.

Examples:

- `reserve` can match `reserve`, `reserveAll`, or another legitimate fuzzy method-name match.
- `ord save` can match `OrderRepository.save` because `save` matches the method name and `ord` refines by class/type.
- `reserve` will **not** return `snapshot()` merely because characters happen to match somewhere in `services/order-service/...`.


Workspace-wide fuzzy method navigation for VS Code, implemented in JavaScript and modeled directly on the Recent Buffers interaction pattern.

## Usage

- `Ctrl+Shift+M` opens Workspace Methods in the active editor presentation.
- Type a method name, class name, parameter type, or path. Whitespace-separated terms are ANDed.
- `Ctrl+J` / `Ctrl+K` or arrow keys move selection.
- `Enter` closes the search and opens the selected method in the source editor group.
- `Esc` closes the search.

The extension uses VS Code document-symbol providers (JDT for Java) rather than regex parsing.

## Search ranking

Search fields are explicit; arbitrary language-server `symbol.detail` text is never indexed for matching.

Results are ranked in strict tiers:

1. bare method name
2. method signature/label
3. containing class/type
4. parameter text
5. file/path

The tier is evaluated before the fuzzy score. A result that matches the actual method name therefore cannot be pushed below a result that only matches a class, signature, parameter, or path. Exact method names rank above prefixes, and prefixes rank above ordinary fuzzy method-name matches.

## Index lifecycle

The full index is built lazily on first use during an extension-host session. After that it maintains itself incrementally:

- edited/saved source file: refresh that file only (edits are debounced)
- created file: index that file only
- deleted file: remove that file only
- renamed file: remove old + index new
- workspace folder changes: full rebuild
- `files.exclude`, `search.exclude`, include/exclude/kind/index configuration changes: full rebuild

`Workspace Method Search: Rebuild Index` remains available as a recovery command, but normal use should not require it.
