# Semantic Java Completion

## 0.10.5 — Preindexed method context

Completion now queries a prebuilt semantic index instead of discovering the current method from scratch while you type.

When you enter or move inside a Java method, the extension indexes the method's parameters, locals, catch/loop values, accessible fields, and their lexical validity ranges. It then prewarms the reachable member graph in the background to the configured receiver depth. Completion only fuzzy-filters graph nodes whose root value is legal at the current cursor position.

The workspace type/member cache is long-lived across file navigation. JDT/source resolution for a type is reused anywhere else in the same workspace, while edits invalidate only the affected file/context. Adding a declaration causes the containing context to be rebuilt after the structural edit; deleting or moving declarations removes/disables them on the same path.

Important implementation changes in 0.10.5:

- per-document method/scope index with lexical validity ranges;
- background prewarming on active-editor changes, cursor navigation, saves, and structural edits;
- method graphs contain all indexed roots but completion filters them by the values visible at the cursor;
- workspace-scoped type/member cache survives switching files;
- source edits invalidate only type entries originating from the edited Java file;
- shared resolved member objects are no longer mutated by observed-call snippet defaults;
- fixed JDT anchored type-navigation validation, which could prevent return types such as `Stream<E>` from resolving and break depth-2 chains;
- receiver roots default to 64 (configurable up to 200) so normal-sized methods are indexed comprehensively;
- verbose debugging remains off by default.

The intended result is that queries such as `save`, `add`, `getMessage`, and `filter` are memory/index lookups once a method has warmed. A depth-2 expression such as `events.stream().filter(...)` is stored as an actual graph edge, so the extension should never synthesize an invalid shortcut such as `events.filter(...)` unless that method genuinely exists on the resolved type.

## Features

- Intent-aware bare completion over values in lexical scope.
- Expected-type filtering/ranking inside arguments, assignments, and returns.
- Recursive receiver chains using JDT-backed type/member resolution.
- Fuzzy operation/receiver matching (`filterevent`, `reposave`, etc.).
- IntelliJ-style postfix completion and `..` command completion.
- Introduce Variable and Introduce Field from selection or cursor-expanded expressions.

## Installation

This extension is JavaScript-only and has no build step or runtime npm dependencies. Copy the extracted extension directory into your VS Code extensions directory and reload VS Code.

## Useful settings

```json
{
  "semanticJavaCompletion.enabled": true,
  "semanticJavaCompletion.receiverSearchDepth": 2,
  "semanticJavaCompletion.maxReceiverSeeds": 64,
  "semanticJavaCompletion.maxSuggestions": 20,
  "semanticJavaCompletion.debug": false
}
```

For diagnostics, run **Semantic Java Completion: Diagnose Current Completion** or enable `semanticJavaCompletion.debug` and inspect **Output → Semantic Java Completion**.

## 0.10.5 completion graph correction

- Completion candidates are now derived from the resolved Java type graph only.
  Calls already present elsewhere in the method/file no longer add members,
  alter ranking, or supply argument snippets.
- Bare intent search always queries the configured graph depth (hard-capped at 2).
  A strong depth-1 match can no longer prevent depth-2 candidates from being
  considered. For example, `filter` can discover
  `events.stream().filter(...)` even though `events.stream()` is itself a strong
  depth-1 candidate.
- The graph remains scope-filtered at the cursor, so locals that are not yet
  declared or are outside their lexical range remain unavailable.


## 0.10.5 fixed three-level completion index

- Replaced progressive/frontier graph traversal with a fixed per-method index:
  value (depth 0), direct member (depth 1), and one additional member hop (depth 2).
- Depth 2 is built directly from depth-1 return types and can never enqueue depth 3.
- Typing a receiver/value prefix such as `event`/`events` shows only that root's
  direct depth-1 API.
- Typing an operation such as `filter` searches terminal member names across both
  depth 1 and depth 2, so `events.stream().filter(...)` can surface directly.
- Existing calls in the method are not used as API candidates or snippet defaults.
- Diagnostic activation version is read from the installed package instead of a
  hard-coded string.

## 0.10.5 accessibility cleanup

- External receiver types now expose only Java-accessible members. Public members are always available; package-private/protected members are only included for same-package/current-type contexts; private members are only included for the current declaring type.
- This removes JDK implementation fields such as internal `String`/`Throwable` state from bare semantic completion without changing the fixed value/depth-1/depth-2 graph.

## 0.10.5 fuzzy terminal-match fix

- Fixed the graph scorer calling `fuzzyNameScore()` with its arguments reversed.
- Terminal member matching now correctly evaluates `candidate member name` against
  the `typed query`, e.g. `setStackTrace` against `failse`.
- Fixed depth-0 / depth-1 / depth-2 indexing architecture is unchanged.

## 0.10.5 receiver+method fuzzy ranking

- Strong receiver+method shorthand now outranks a weak typo-only terminal match.
- Example: `phtrim` strongly ranks `phase.trim()` instead of allowing unrelated
  `phase.split(...)` or depth-2 noise to win.
- Fixed depth-0 / depth-1 / depth-2 indexing and accessibility filtering are unchanged.

## 0.10.5 qualified type identity fix

- Unqualified implicit `java.lang` types now resolve to their real FQN.
  `String` is indexed as `java.lang.String`, `RuntimeException` as
  `java.lang.RuntimeException`, etc.
- Type/member caches are keyed by qualified type identity instead of only the
  simple source spelling. An unrelated class named `String` can no longer poison
  completion for `java.lang.String`.
- JDT/type-definition and workspace-symbol results are validated against the
  qualified identity before their members are accepted.
- The fixed value / depth-1 / depth-2 completion graph and fuzzy ranking are unchanged.

## 0.10.5 JDT document-symbol member indexing

- Resolved type documents now use the Java/JDT document-symbol provider to
  enumerate member names before falling back to declaration regex parsing.
- This fixes JDK/decompiled classes where the regex parser recognized only a
  small subset of the actual API, such as `java.lang.String` resolving only a
  handful of methods and omitting `trim()`.
- Parsed signatures and return types are still retained when available; document
  symbols guarantee member presence.
- The fixed value / depth-1 / depth-2 graph and fuzzy ranking are unchanged.

## 0.10.7 structured receiver+method fuzzy search

- Added an explicit receiver+terminal-method split scorer for shorthand such as
  `ptri -> phase.trim()`, `failse -> failure.setStackTrace()`, and
  `reposave -> repository.save()`.
- Strong structured shorthand is no longer pruned just because an unrelated
  terminal method happens to fuzzy-match the same letters.
- JDT document-symbol fallback now applies Java accessibility filtering before
  indexing symbols, preventing helpers such as private/package `safeTrim` and
  implementation fields from leaking back into completion.
- Fixed value / depth-1 / depth-2 indexing is unchanged.

## 0.10.7 conservative shorthand + symbol visibility repair

- Replaced fuzzy receiver/member splitting with strict prefix splitting.
  `ptri -> phase.trim()`, `failse -> failure.setStackTrace()`, and
  `reposave -> repository.save()` are supported, while unrelated candidates
  cannot manufacture structured matches.
- JDT document-symbol accessibility now inspects source lines around the symbol
  so public methods in JDK/decompiled classes are not accidentally discarded.
- Package-private/private JDK implementation helpers remain excluded.
- The fixed value / depth-1 / depth-2 graph is unchanged.
