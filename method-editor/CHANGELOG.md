## 0.7.0

- Reverted drill-in navigation to a single method editor surface.
- Ctrl+Enter now replaces the active method instead of creating editor groups.
- Removed the new-editor-group path, eliminating split/group prompts from method navigation.
- Back/Forward continues to walk method history.

## 0.6.0

- Ctrl+Enter now creates a brand-new editor group to the right for every followed method.
- Removed fixed group-2 reuse; each method in the investigation can remain visible.
- New group creation is direct and does not use a group-selection picker/modal.

## 0.5.0

- Fixed Ctrl+Enter source-position mapping by using exact character offsets instead of line arithmetic.
- Added Java method-range fallback parsing that correctly balances nested blocks such as switch expressions.
- Normalizes both DocumentSymbol and SymbolInformation results from language providers.
- Keeps JDT document symbols as the preferred method source and uses the parser only as a fallback.

## 0.4.0

- Ctrl+Enter now opens the called method directly in editor group 2.
- Removed the new-group command from drill-in navigation, eliminating group-selection/prompt UI.
- Reuses group 2 for subsequent called methods.

# Changelog

## 0.3.0

- `Ctrl+Enter` now keeps the caller open and opens the called method in a new editor group.
- Method Mode can grow into a multi-method workspace as calls are followed.
- Definition resolution now accepts both Location and LocationLink provider results.
- Sibling/history navigation still replaces only the active method pane.

## 0.2.0

- Added explicit Method Mode workflow and method history navigation.

## 0.9.0
- Replaced first-match method selection with an explicit MethodLocator model.
- JDT Method and Constructor symbols are authoritative when available.
- Cursor selection chooses the smallest/innermost enclosing executable declaration.
- Removed Function symbols from the Java method definition model (lambdas are not methods).
- Definition navigation resolves the innermost target method/constructor at the JDT destination.
- Java lexical parsing is now emergency fallback only and can discover nested local/anonymous-class methods.
