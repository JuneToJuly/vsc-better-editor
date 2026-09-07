'use strict';

const vscode = require('vscode');
const semantic = require('./semantic');
const postfix = require('./postfix');
const commandCompletion = require('./commandCompletion');
const introduce = require('./introduce');
const scopeIndex = require('./scopeIndex');
const memberResolver = require('./memberResolver');

let output;
let semanticRefreshTimer;
const scopeGraphCache = new Map();
const documentIndexCache = new Map();
const prewarmGeneration = new Map();
let prewarmTimer;

const IDENTIFIER_TRIGGER_CHARACTERS = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  '_', '$'
];

function triggerKindName(kind) {
  if (kind === vscode.CompletionTriggerKind.Invoke) return 'Invoke';
  if (kind === vscode.CompletionTriggerKind.TriggerCharacter) return 'TriggerCharacter';
  if (kind === vscode.CompletionTriggerKind.TriggerForIncompleteCompletions) return 'Incomplete';
  return String(kind);
}

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }

function invalidateSemanticGraphForUri(uri, options = {}) {
  const prefix = `${uri}|`;
  for (const key of [...scopeGraphCache.keys()]) if (key.startsWith(prefix)) scopeGraphCache.delete(key);
  documentIndexCache.delete(uri);
  if (options.bumpGeneration !== false) prewarmGeneration.set(uri, (prewarmGeneration.get(uri) || 0) + 1);
}

function isSimpleIntentTypingChange(change) {
  return !!change && change.rangeLength === 0 && change.text.length === 1 && /[A-Za-z0-9_$]/.test(change.text);
}

function updateCachedIndexForSimpleInsert(document, change) {
  const uri = document.uri.toString();
  const entry = documentIndexCache.get(uri);
  if (!entry || !change || change.rangeLength !== 0 || !change.text) return;
  const at = change.rangeOffset;
  const delta = change.text.length;
  for (const method of entry.index.methods || []) {
    if (method.bodyEnd >= at) method.bodyEnd += delta;
    if (method.paramsEnd >= at) method.paramsEnd += delta;
  }
  for (const value of entry.index.declarations || []) {
    if ((value.scopeEnd ?? -1) >= at) value.scopeEnd += delta;
  }
  entry.index.textLength += delta;
  entry.text = document.getText();
}

function getDocumentIndex(document, includeFields = true) {
  const uri = document.uri.toString();
  let entry = documentIndexCache.get(uri);
  if (!entry || entry.includeFields !== includeFields) {
    const text = document.getText();
    entry = { includeFields, index: scopeIndex.buildDocumentIndex(text, { includeFields }), text };
    documentIndexCache.set(uri, entry);
  }
  return entry;
}

function getIndexedScopeContext(document, position, includeFields = true) {
  const entry = getDocumentIndex(document, includeFields);
  return scopeIndex.valuesAtCursor(entry.index, entry.text, document.offsetAt(position));
}

function getVisibleValuesCached(document, position, includeFields = true) {
  return getIndexedScopeContext(document, position, includeFields).visibleValues;
}

function graphSeedList(document, baseCandidates, maxSeeds) {
  return baseCandidates
    .filter(c => (c.kind === 'variable' || c.kind === 'field') && /^[A-Za-z_$][\w$]*$/.test(c.name) && c.type)
    .slice(0, maxSeeds)
    .map(c => ({
      expression: c.name, type: c.type, root: c.name,
      lineDistance: c.lineDistance || 0, nameOffset: c.nameOffset,
      anchorUri: document.uri.toString(),
      scopeStart: c.scopeStart ?? 0,
      scopeEnd: c.scopeEnd ?? document.getText().length,
      declarationOffset: c.nameOffset ?? c.offset ?? 0,
      typeOffset: c.typeOffset,
      rootKey: `${c.name}@${c.nameOffset ?? c.offset ?? 0}`
    }));
}

function graphCacheKey(document, baseCandidates, maxSeeds) {
  // A graph belongs to a method/scope context, not to one line. The seed signature
  // makes structural edits create a new graph while normal identifier typing reuses it.
  const methodStart = baseCandidates.find(c => Number.isFinite(c.methodStart))?.methodStart ?? 'file';
  const signature = baseCandidates.slice(0, maxSeeds).map(s => `${s.name}@${s.nameOffset ?? s.offset ?? 0}:${semantic.normalizeType(s.type)}`).join('|');
  return `${document.uri.toString()}|${methodStart}|${maxSeeds}|${signature}`;
}

function getGraphEntry(document, baseCandidates, maxSeeds) {
  const seeds = graphSeedList(document, baseCandidates, maxSeeds);
  const key = graphCacheKey(document, baseCandidates, maxSeeds);
  let entry = scopeGraphCache.get(key);
  if (!entry) {
    entry = {
      key,
      seeds,
      depth1: [],
      depth2: [],
      candidates: new Map(),
      built: false,
      buildPromise: null,
      buildMs: 0,
      hits: 0
    };
    scopeGraphCache.set(key, entry);
  } else {
    entry.hits++;
  }
  return entry;
}

async function ensureGraphDepth(document, baseCandidates, targetDepth, maxSeeds, token, cfg) {
  // The graph is deliberately fixed and flat:
  //   depth 0 = in-scope value
  //   depth 1 = value.member
  //   depth 2 = value.member.member
  // No frontier is retained and no recursive expansion beyond depth 2 is possible.
  targetDepth = Math.max(0, Math.min(2, Number(targetDepth) || 0));
  const entry = getGraphEntry(document, baseCandidates, maxSeeds);
  if (targetDepth <= 0 || entry.built) return entry;
  if (entry.buildPromise) {
    await entry.buildPromise;
    return entry;
  }

  entry.buildPromise = (async () => {
    const started = nowMs();
    const depth1 = [];
    const intermediates = [];
    const candidateMap = new Map();

    // Resolve every root independently enough to preserve its source anchor. The
    // member resolver caches by type/workspace, so repeated types remain cheap.
    const rootPairs = await Promise.all(entry.seeds.map(async seed => [
      seed,
      await memberResolver.resolveTypeMembers(document, semantic.normalizeType(seed.type), token, 0, new Set(), {
        anchorOffset: Number.isFinite(seed.typeOffset) ? seed.typeOffset : seed.nameOffset,
        anchorUri: seed.anchorUri
      })
    ]));
    if (token.isCancellationRequested) return;

    for (const [seed, resolved] of rootPairs) {
      for (const member of mergeResolvedAndObservedMembers(document, seed, resolved || [])) {
        if (member.isStatic) continue;
        const expression = `${seed.expression}.${member.name}${member.call || ''}`;
        const raw = makeGraphCandidate(document, seed, member, expression, 1);
        const id = graphMemberIdentity(seed.expression, member, seed.rootKey);
        const prev = candidateMap.get(id);
        if (!prev || raw.overloadPreference > (prev.overloadPreference || 0)) candidateMap.set(id, raw);
        depth1.push(raw);

        const canTraverse = member.kind === 'field' || (member.kind === 'method' && member.arity === 0);
        if (canTraverse && semantic.isTraversableType(member.type)) {
          intermediates.push({
            expression,
            type: member.type,
            root: seed.root,
            lineDistance: seed.lineDistance,
            nameOffset: member.typeOffset,
            typeOffset: member.typeOffset,
            anchorUri: member.sourceUri,
            scopeStart: seed.scopeStart,
            scopeEnd: seed.scopeEnd,
            declarationOffset: seed.declarationOffset,
            rootKey: seed.rootKey
          });
        }
      }
    }

    const depth2 = [];
    if (targetDepth >= 2 && intermediates.length && !token.isCancellationRequested) {
      // Depth 2 is built directly from the depth-1 intermediate nodes. These
      // results are never enqueued again, so depth 3 cannot exist by construction.
      const pairs = await Promise.all(intermediates.map(async state => [
        state,
        await memberResolver.resolveTypeMembers(document, semantic.normalizeType(state.type), token, 0, new Set(), {
          anchorOffset: Number.isFinite(state.typeOffset) ? state.typeOffset : state.nameOffset,
          anchorUri: state.anchorUri
        })
      ]));
      if (token.isCancellationRequested) return;

      for (const [state, resolved] of pairs) {
        for (const member of mergeResolvedAndObservedMembers(document, state, resolved || [])) {
          if (member.isStatic) continue;
          const expression = `${state.expression}.${member.name}${member.call || ''}`;
          const raw = makeGraphCandidate(document, state, member, expression, 2);
          const id = graphMemberIdentity(state.expression, member, state.rootKey);
          const prev = candidateMap.get(id);
          if (!prev || raw.overloadPreference > (prev.overloadPreference || 0)) candidateMap.set(id, raw);
          depth2.push(raw);
        }
      }
    }

    entry.depth1 = dedupeGraphCandidates(depth1);
    entry.depth2 = dedupeGraphCandidates(depth2);
    entry.candidates = candidateMap;
    entry.built = true;
    entry.depthBuilt = targetDepth >= 2 ? 2 : 1;
    entry.buildMs += nowMs() - started;
    debug(cfg, `GRAPH-FLAT key=${entry.key.slice(-80)} d1=${entry.depth1.length} d2=${entry.depth2.length} hits=${entry.hits} buildMs=${entry.buildMs.toFixed(1)}`);
  })();

  try { await entry.buildPromise; }
  finally { entry.buildPromise = null; }
  return entry;
}

function makeGraphCandidate(document, state, member, expression, depth) {
  return {
    name: expression,
    matchName: member.name,
    matchNames: [
      `${state.root}${member.name}`, `${state.expression}${member.name}`,
      `${state.root}.${member.name}`, `${state.expression}.${member.name}`,
      `${member.name}${state.root}`, `${member.name}${state.expression}`,
      `${member.name}.${state.root}`, `${member.name}.${state.expression}`
    ],
    insertText: expression,
    isSnippet: !!member.isSnippet,
    type: member.type,
    kind: member.kind === 'field' ? 'receiverField' : 'receiverMethod',
    root: state.root,
    lineDistance: state.lineDistance,
    receiverDepth: depth,
    baseScore: depth === 1 ? 90 : 0,
    overloadPreference: overloadUiPreference(member),
    scopeStart: state.scopeStart ?? 0,
    scopeEnd: state.scopeEnd ?? document.getText().length,
    declarationOffset: state.declarationOffset ?? 0,
    rootKey: state.rootKey
  };
}

function dedupeGraphCandidates(items) {
  const seen = new Map();
  for (const item of items) {
    const key = `${item.rootKey}|${canonicalExpression(item.name).replace(/\([^)]*\)$/,'()')}`;
    const prev = seen.get(key);
    if (!prev || item.overloadPreference > prev.overloadPreference) seen.set(key, item);
  }
  return [...seen.values()];
}

function structuredReceiverMemberScore(raw, query) {
  const q = String(query || '').trim().toLowerCase();
  const root = String(raw?.root || '').trim().toLowerCase();
  const member = String(raw?.matchName || '').trim().toLowerCase();
  if (q.length < 3 || !root || !member) return -1;

  let best = -1;

  // Structured shorthand is intentionally conservative:
  //   ptri     -> p + tri     -> phase.trim()
  //   phtrim   -> ph + trim   -> phase.trim()
  //   failse   -> fail + se   -> failure.setStackTrace()
  //   reposave -> repo + save -> repository.save()
  //
  // Both halves MUST be literal prefixes. Do not use generic fuzzy matching
  // here; fuzzy matching already exists elsewhere and using it for each half
  // manufactures bogus structure from unrelated candidates.
  for (let i = 1; i < q.length - 1; i++) {
    const left = q.slice(0, i);
    const right = q.slice(i);
    if (right.length < 2) continue;
    if (!root.startsWith(left)) continue;
    if (!member.startsWith(right)) continue;

    // Reward how much of both receiver and operation the user supplied.
    // Method text matters slightly more because it represents the intended action.
    const receiverCoverage = left.length / Math.max(1, root.length);
    const memberCoverage = right.length / Math.max(1, member.length);
    const score =
      700 +
      left.length * 45 +
      right.length * 85 +
      Math.round(receiverCoverage * 120) +
      Math.round(memberCoverage * 220);

    best = Math.max(best, score);
  }
  return best;
}

function scoreGraphForIntent(entry, prefix, maxDepth, visibleRootDistances = null) {
  const q = String(prefix || '').trim();
  const qLower = q.toLowerCase();
  const roots = entry.seeds.filter(seed => !visibleRootDistances || visibleRootDistances.has(seed.rootKey));

  // If the query is just a root/value prefix (event -> events, events -> events),
  // show only that value's direct API. This prevents depth-2 chains from flooding
  // the list while the user is selecting a receiver.
  const rootPrefixMatches = roots.filter(seed => {
    const r = String(seed.root || '').toLowerCase();
    return qLower && r.startsWith(qLower) && qLower.length <= r.length;
  });
  if (rootPrefixMatches.length) {
    const allowed = new Set(rootPrefixMatches.map(r => r.rootKey));
    return entry.depth1
      .filter(raw => allowed.has(raw.rootKey))
      .map(raw => ({
        ...raw,
        lineDistance: visibleRootDistances?.get(raw.rootKey) ?? raw.lineDistance ?? 0,
        score: 1200 - Math.min(100, canonicalExpression(raw.name).length),
        filterAlias: raw.root,
        memberMatchScore: 0
      }))
      .sort(memberIntentSort);
  }

  const out = [];
  const pool = maxDepth >= 2 ? [...entry.depth1, ...entry.depth2] : entry.depth1;
  for (const raw of pool) {
    if (visibleRootDistances && !visibleRootDistances.has(raw.rootKey)) continue;
    const match = semantic.completionMatch(raw, q);
    if (match.score < 0) continue;
    const terminalScore = semantic.fuzzyNameScore(raw.matchName || '', q);
    const structuredScore = structuredReceiverMemberScore(raw, q);
    const distance = visibleRootDistances?.get(raw.rootKey) ?? raw.lineDistance ?? 80;
    const proximityBonus = Math.max(0, 40 - Math.min(40, distance));
    // Terminal member intent dominates for plain operation queries (filter,
    // save, trim). Structured receiver+member shorthand gets an even stronger
    // signal when the query clearly splits that way (ptri -> phase.trim()).
    const terminalBonus = terminalScore >= 500 ? 500 + terminalScore : 0;
    const structuredBonus = structuredScore >= 0 ? 700 + structuredScore : 0;
    out.push({
      ...raw,
      lineDistance: distance,
      score: match.score + terminalBonus + structuredBonus + proximityBonus + (raw.receiverDepth === 1 ? 30 : 0),
      filterAlias: structuredScore >= 0 ? `${raw.root}${raw.matchName}` : (terminalScore >= 0 ? raw.matchName : (match.target || raw.matchName)),
      memberMatchScore: terminalScore,
      structuredMatchScore: structuredScore
    });
  }
  return out.sort(memberIntentSort);
}

function pruneWeakIntentCandidates(candidates, prefix) {
  const q = String(prefix || '').trim();
  if (q.length < 3 || !candidates.length) return candidates;
  // Once at least one terminal member itself matches well, do not keep candidates
  // that only survived through a loose receiver/composite alias. This is what
  // keeps `filter` focused on actual filter(...) terminal operations.
  const strong = candidates.filter(c => (c.memberMatchScore ?? -1) >= 300 || (c.structuredMatchScore ?? -1) >= 0);
  return strong.length ? strong : candidates;
}

function balanceIntentRoots(candidates, limit) {
  if (!Number.isFinite(limit) || limit <= 0 || candidates.length <= 1) return candidates;
  const groups = new Map();
  for (const c of candidates) {
    const key = c.rootKey || c.root || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => (b[0]?.score || 0) - (a[0]?.score || 0));
  const out = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const group of orderedGroups) {
      if (round < group.length) { out.push(group[round]); added = true; if (out.length >= limit) break; }
    }
    if (!added) break;
  }
  return out;
}


function schedulePrewarm(editor, delay = 25) {
  if (!editor || editor.document.languageId !== 'java') return;
  if (prewarmTimer) clearTimeout(prewarmTimer);
  const uri = editor.document.uri.toString();
  const generation = prewarmGeneration.get(uri) || 0;
  const position = editor.selection.active;
  prewarmTimer = setTimeout(() => {
    prewarmTimer = undefined;
    warmCurrentContext(editor, position, generation).catch(() => {});
  }, delay);
}

async function warmCurrentContext(editor, expectedPosition, generation) {
  const active = vscode.window.activeTextEditor;
  if (!active || active.document.uri.toString() !== editor.document.uri.toString()) return;
  const document = active.document;
  const uri = document.uri.toString();
  if ((prewarmGeneration.get(uri) || 0) !== generation) return;
  const cfg = vscode.workspace.getConfiguration('semanticJavaCompletion', document.uri);
  if (!cfg.get('enabled', true)) return;

  const position = expectedPosition || active.selection.active;
  const scopeCtx = getIndexedScopeContext(document, position, cfg.get('includeFields', true));
  if (!scopeCtx.allValues.length) return;
  const fakeToken = { isCancellationRequested: false };
  const maxDepth = Math.max(1, cfg.get('receiverSearchDepth', 2));
  const maxSeeds = cfg.get('maxReceiverSeeds', 64);
  const started = nowMs();
  await ensureGraphDepth(document, scopeCtx.allValues, maxDepth, maxSeeds, fakeToken, cfg);
  if ((prewarmGeneration.get(uri) || 0) !== generation) return;
  debug(cfg, `PREWARM method=${scopeCtx.methodKey} values=${scopeCtx.allValues.length} depth=${maxDepth} ms=${(nowMs()-started).toFixed(1)}`);
}


function activate(context) {
  output = vscode.window.createOutputChannel('Semantic Java Completion');
  context.subscriptions.push(output);
  output.appendLine(`[${new Date().toISOString()}] ACTIVATE semantic-java-completion ${context.extension?.packageJSON?.version || 'unknown'}`);

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.languageId !== 'java') return;
    const cfg = vscode.workspace.getConfiguration('semanticJavaCompletion', event.document.uri);
    if (!cfg.get('enabled', true)) return;

    // Bare identifier typing changes only the query, not the semantic graph. Keep
    // the expensive receiver/member index alive across s -> sa -> sav -> save.
    // Any other edit can alter scope or observed calls, so invalidate this file's
    // graph. Type/member metadata is retained until save because method-body edits
    // do not normally change a type declaration.
    const structuralEdit = event.contentChanges.some(change => !isSimpleIntentTypingChange(change));
    if (structuralEdit) {
      invalidateSemanticGraphForUri(event.document.uri.toString());
      memberResolver.invalidateSourceUri(event.document.uri.toString());
      debug(cfg, `CACHE context-invalidated uri=${event.document.uri.toString()}`);
    } else {
      for (const change of event.contentChanges) updateCachedIndexForSimpleInsert(event.document, change);
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) return;
    if (structuralEdit) schedulePrewarm(editor, 60);

    for (const change of event.contentChanges) {
      if (!change.text || change.text.length > 4 || change.text.includes('\n')) continue;
      const endOffset = change.rangeOffset + change.text.length;
      const end = event.document.positionAt(Math.min(endOffset, event.document.getText().length));
      const fullLine = event.document.lineAt(end.line).text;
      const lineBefore = fullLine.slice(0, end.character);
      const prefix = semantic.identifierPrefix(lineBefore);

      debug(cfg, `TEXT change=${JSON.stringify(change.text)} at=${end.line + 1}:${end.character + 1} prefix=${prefix || '-'} line=${JSON.stringify(lineBefore.trim())}`);

      // VS Code can keep JDT's existing suggestion widget alive and merely filter
      // that stale list as the user continues typing. CompletionList.isIncomplete
      // and trigger characters do not reliably cause extension providers to be
      // called again in that situation. For a bare Java identifier, explicitly
      // start a fresh *normal* completion session after each character. Closing
      // the stale widget first is important: triggerSuggest alone is a no-op when
      // the existing widget owns the session.
      if (change.text.length !== 1 || !/[A-Za-z0-9_$]/.test(change.text)) continue;
      if (prefix.length < Math.max(2, cfg.get('minimumPrefixLength', 1))) continue;
      const prefixStart = end.character - prefix.length;
      const beforePrefix = prefixStart > 0 ? fullLine[prefixStart - 1] : '';
      if (beforePrefix === '.') continue; // normal receiver/member completion belongs to JDT

      scheduleSemanticRefresh(editor, event.document, end, prefix, cfg);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (document.languageId !== 'java') return;
    invalidateSemanticGraphForUri(document.uri.toString());
    memberResolver.invalidateSourceUri(document.uri.toString());
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.toString() === document.uri.toString()) schedulePrewarm(editor, 20);
  }));

  context.subscriptions.push(vscode.workspace.onDidCreateFiles(() => { scopeGraphCache.clear(); documentIndexCache.clear(); memberResolver.clearCache(); }));
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles(() => { scopeGraphCache.clear(); documentIndexCache.clear(); memberResolver.clearCache(); }));
  context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => { scopeGraphCache.clear(); documentIndexCache.clear(); memberResolver.clearCache(); }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => schedulePrewarm(editor, 10)));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    if (event.textEditor.document.languageId !== 'java') return;
    schedulePrewarm(event.textEditor, 20);
  }));
  if (vscode.window.activeTextEditor?.document.languageId === 'java') schedulePrewarm(vscode.window.activeTextEditor, 10);

  // Recompute our semantic graph on every identifier character, not just when the
  // completion widget first opens. VS Code otherwise keeps filtering a stale list
  // while the user types `a` -> `ad` -> `add`. Registering identifier characters
  // as *our provider's* triggers makes the fuzzy search genuinely live without
  // recursively querying the completion pipeline or manually reopening the widget.
  const provider = vscode.languages.registerCompletionItemProvider(
    { language: 'java', scheme: '*' },
    { provideCompletionItems },
    '.',
    ...IDENTIFIER_TRIGGER_CHARACTERS
  );
  context.subscriptions.push(provider);

  context.subscriptions.push(vscode.commands.registerCommand('semanticJavaCompletion.introduceVariable', async () => {
    await runIntroduceFromEditor('variable');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('semanticJavaCompletion.introduceField', async () => {
    await runIntroduceFromEditor('field');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('semanticJavaCompletion.introduceAtRange', async (args) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'java' || !args) return;
    const document = editor.document;
    const start = Math.max(0, Math.min(args.startOffset, document.getText().length));
    const end = Math.max(start, Math.min(args.endOffset, document.getText().length));
    const target = args.target === 'field' ? 'field' : 'variable';
    await applyIntroduceEdit(editor, start, end, { target, suggestedName: args.name });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('semanticJavaCompletion.showDebugOutput', () => {
    output.show(true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('semanticJavaCompletion.diagnoseCurrentCompletion', async () => {
    await diagnoseCurrentCompletion();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('semanticJavaCompletion.showContext', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'java') return;
    const document = editor.document;
    const position = editor.selection.active;
    const postfixCtx = postfix.findPostfixContext(document.getText(), document.offsetAt(position));
    if (postfixCtx) {
      const matches = postfix.getTemplatesForContext(postfixCtx).map(t => t.label).join(', ') || 'none';
      vscode.window.showInformationMessage(`Postfix expression: ${postfixCtx.expression} • typed .${postfixCtx.keyword} • matches: ${matches}`);
      return;
    }
    const ctx = await buildContext(document, position);
    vscode.window.showInformationMessage(ctx
      ? `Expected ${ctx.expectedType || '?'}${ctx.parameterName ? ` (${ctx.parameterName})` : ''} via ${ctx.source}`
      : 'No semantic expected-type or postfix context detected at the cursor.');
  }));
}


function scheduleSemanticRefresh(editor, document, expectedPosition, expectedPrefix, cfg) {
  if (semanticRefreshTimer) clearTimeout(semanticRefreshTimer);
  semanticRefreshTimer = setTimeout(async () => {
    semanticRefreshTimer = undefined;
    const active = vscode.window.activeTextEditor;
    if (!active || active !== editor || active.document.uri.toString() !== document.uri.toString()) return;
    const position = active.selection.active;
    if (position.line !== expectedPosition.line || position.character !== expectedPosition.character) {
      debug(cfg, `REFRESH skip cursor-moved expected=${expectedPosition.line + 1}:${expectedPosition.character + 1} actual=${position.line + 1}:${position.character + 1}`);
      return;
    }
    const lineBefore = active.document.lineAt(position.line).text.slice(0, position.character);
    const prefix = semantic.identifierPrefix(lineBefore);
    if (prefix !== expectedPrefix) {
      debug(cfg, `REFRESH skip prefix-changed expected=${expectedPrefix} actual=${prefix || '-'}`);
      return;
    }
    try {
      debug(cfg, `REFRESH force-new-session prefix=${prefix} at=${position.line + 1}:${position.character + 1}`);
      await vscode.commands.executeCommand('hideSuggestWidget');
      // Let the old suggest session finish disposing before reopening. A single
      // event-loop turn is enough and avoids the old recursive-completion path.
      await new Promise(resolve => setTimeout(resolve, 0));
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
    } catch (error) {
      debug(cfg, `REFRESH failed ${error?.stack || error}`);
    }
  }, 8);
}

async function provideCompletionItems(document, position, token, completionContext) {
  const cfg = vscode.workspace.getConfiguration('semanticJavaCompletion', document.uri);
  const started = nowMs();
  const lineBeforeForTrace = document.lineAt(position.line).text.slice(0, position.character);
  const prefixForTrace = semantic.identifierPrefix(lineBeforeForTrace);
  debug(cfg, `PROVIDER enter kind=${triggerKindName(completionContext.triggerKind)} char=${JSON.stringify(completionContext.triggerCharacter || '')} at=${position.line + 1}:${position.character + 1} prefix=${prefixForTrace || '-'} line=${JSON.stringify(lineBeforeForTrace.trim())}`);
  if (!cfg.get('enabled', true)) { debug(cfg, 'PROVIDER disabled'); return undefined; }

  const commandItems = cfg.get('commandCompletion.enabled', true)
    ? provideCommandCompletionItems(document, position, cfg)
    : [];
  if (commandItems.length) { debug(cfg, `PROVIDER command-items=${commandItems.length} ms=${(nowMs()-started).toFixed(1)}`); return commandItems; }

  const postfixItems = cfg.get('postfix.enabled', true)
    ? providePostfixCompletionItems(document, position, cfg)
    : [];

  // Postfix / command sessions are self-contained. Avoid an unnecessary JDT signature-help round trip.
  if (postfixItems.length) { debug(cfg, `PROVIDER postfix-items=${postfixItems.length} ms=${(nowMs()-started).toFixed(1)}`); return postfixItems; }

  // Semantic completion may return a vscode.CompletionList, including an empty
  // *incomplete* list. Do not treat it like an array: CompletionList has `.items`,
  // not `.length`, and returning an empty incomplete list is intentional because
  // it tells VS Code to call us again as the prefix changes.
  const semanticResult = await provideSemanticCompletionItems(document, position, token, completionContext, cfg);
  const count = semanticResult && Array.isArray(semanticResult) ? semanticResult.length : (semanticResult?.items?.length || 0);
  const incomplete = !!semanticResult?.isIncomplete;
  debug(cfg, `PROVIDER semantic-items=${count} incomplete=${incomplete} cancelled=${token.isCancellationRequested} ms=${(nowMs()-started).toFixed(1)}`);
  return semanticResult;
}

function provideCommandCompletionItems(document, position, cfg) {
  const cursorOffset = document.offsetAt(position);
  const ctx = commandCompletion.findCommandContext(document.getText(), cursorOffset);
  if (!ctx) return [];
  const commands = commandCompletion.getCommands(ctx);
  debug(cfg, `command expression=${ctx.expression} prefix=${ctx.keyword || '-'} matches=${commands.map(c => c.key).join(',') || '-'}`);
  return commands.map((command, index) => {
    const item = new vscode.CompletionItem(command.label, vscode.CompletionItemKind.Snippet);
    item.detail = `${command.group} • ${command.detail}`;
    item.documentation = new vscode.MarkdownString(`Transforms \`${ctx.expression}..${command.key}\` using **${command.label}**.`);
    if (command.action === 'introduceVariable' || command.action === 'introduceField') {
      // Keep the expression in place, remove only the double-dot suffix, then
      // perform a real workspace edit. The refactor asks for a name before edit.
      item.range = new vscode.Range(document.positionAt(ctx.dotsOffset), position);
      item.insertText = '';
      item.command = {
        command: 'semanticJavaCompletion.introduceAtRange',
        title: command.action === 'introduceField' ? 'Introduce field' : 'Introduce variable',
        arguments: [{
          startOffset: ctx.replaceStart,
          endOffset: ctx.dotsOffset,
          name: command.suggestedName,
          target: command.action === 'introduceField' ? 'field' : 'variable'
        }]
      };
    } else {
      item.range = new vscode.Range(document.positionAt(ctx.replaceStart), position);
      item.insertText = new vscode.SnippetString(command.expand());
    }
    item.filterText = command.action ? `..${command.key}` : `${ctx.expression}..${command.key}`;
    item.sortText = `${command.group === 'Refactor' ? '000' : '100'}-command-${String(index).padStart(3, '0')}`;
    item.preselect = index === 0;
    item.keepWhitespace = true;
    return item;
  });
}

function providePostfixCompletionItems(document, position, cfg) {
  const cursorOffset = document.offsetAt(position);
  const ctx = postfix.findPostfixContext(document.getText(), cursorOffset);
  if (!ctx) return [];
  // A bare single dot belongs to Java/JDT. Do not put postfix templates in front
  // of normal members. Postfix items join only after the user starts typing the
  // postfix keyword; `..` is the always-available discovery surface.
  if (!ctx.keyword) return [];

  const disabled = new Set(cfg.get('postfix.disabledTemplates', []));
  const templates = postfix.getTemplatesForContext(ctx).filter(t => !disabled.has(t.key));
  const variants = [];
  for (const template of templates) {
    for (const key of [template.key, ...template.aliases]) {
      if (!ctx.keyword || key.toLowerCase().startsWith(ctx.keyword.toLowerCase())) {
        variants.push({ template, key });
      }
    }
  }
  debug(cfg, `postfix expression=${ctx.expression} prefix=.${ctx.keyword} matches=${variants.map(v => v.key).join(',') || '-'}`);

  return variants.map((variant, index) => makePostfixCompletion(document, position, ctx, variant.template, variant.key, index));
}

function makePostfixCompletion(document, position, ctx, template, key, index) {
  const item = new vscode.CompletionItem(`.${key}`, vscode.CompletionItemKind.Snippet);
  item.detail = `${template.detail}  • postfix template`;
  item.documentation = new vscode.MarkdownString(
    `Transforms \`${ctx.expression}.${key}\` using the **.${key}** postfix template.`
  );

  const start = document.positionAt(ctx.replaceStart);
  item.range = new vscode.Range(start, position);
  item.insertText = new vscode.SnippetString(template.expand(ctx));
  item.filterText = `${ctx.expression}.${key}`;
  // Postfix templates should remain available without crowding out JDT's normal
  // member/method completions. A late sort key keeps them below ordinary Java
  // suggestions; typing the postfix keyword still filters them naturally.
  item.sortText = `zzzzz-postfix-${String(index).padStart(3, '0')}`;
  item.preselect = false;
  item.keepWhitespace = true;
  return item;
}

async function provideSemanticCompletionItems(document, position, token, completionContext, cfg) {
  const lineBefore = document.lineAt(position.line).text.slice(0, position.character);
  const prefix = semantic.identifierPrefix(lineBefore);
  if (prefix.length < cfg.get('minimumPrefixLength', 1) && completionContext.triggerKind === vscode.CompletionTriggerKind.Invoke) {
    return undefined;
  }

  // Do not ask JDT signature help for every bare identifier. That round trip is
  // unnecessary for member-intent searches such as `getMe` and was the main
  // reason those suggestions could arrive late or not at all. Only resolve an
  // expected type when the syntax actually looks like an assignment/return or
  // an invocation argument.
  const textualCtx = semantic.inferExpectedTypeFromText(document.getText(), document.offsetAt(position));
  const ctx = textualCtx || (looksLikeInvocationArgument(document, position)
    ? await buildSignatureContext(document, position)
    : null);
  if (token.isCancellationRequested) return undefined;
  if (!ctx || !ctx.expectedType) {
    // Always participate alongside JDT. JDT remains responsible for ordinary
    // locals/members; this provider contributes composed reachable expressions
    // such as failure.getMessage() and request.lines().
    return provideMemberIntentCompletionItems(document, position, token, cfg, prefix);
  }
  ctx.prefix = prefix;

  const text = document.getText();
  const cursorOffset = document.offsetAt(position);
  const candidates = semantic.collectCandidates(text, cursorOffset, {
    includeFields: cfg.get('includeFields', true),
    includeMethods: cfg.get('includeMethods', true),
    includeConstruction: cfg.get('includeConstruction', true),
    expectedType: ctx.expectedType
  });
  const scopeCtx = getIndexedScopeContext(document, position, cfg.get('includeFields', true));
  const visibleValues = scopeCtx.visibleValues;
  const graphValues = scopeCtx.allValues;
  const receiverDepth = cfg.get('receiverSearchDepth', 2);
  if (receiverDepth > 0 && !token.isCancellationRequested) {
    const receiverCandidates = await collectReceiverExpressionCandidates(
      document,
      graphValues,
      ctx,
      receiverDepth,
      cfg.get('maxReceiverSeeds', 64),
      token,
      cfg,
      visibleValues
    );
    candidates.push(...receiverCandidates);
  }
  // JDT already owns ordinary locals, fields and current-class methods. Emitting
  // those here creates duplicate rows and makes cross-provider sorting impossible
  // to reason about. Only contribute expressions JDT normally cannot suggest as a
  // single completion item: reachable receiver chains and construction expressions.
  let ranked = semantic.rankCandidates(candidates, ctx)
    .filter(candidate => candidate.kind === 'receiverMethod' || candidate.kind === 'receiverField' || candidate.kind === 'constructor')
    .slice(0, cfg.get('maxSuggestions', 12));

  debug(cfg, `expected=${ctx.expectedType} param=${ctx.parameterName || '-'} source=${ctx.source} prefix=${prefix || '-'} candidates=${candidates.length} novel=${ranked.length}`);

  return new vscode.CompletionList(
    ranked.map((candidate, index) => makeSemanticCompletion(candidate, ctx, index)),
    true
  );
}

async function provideMemberIntentCompletionItems(document, position, token, cfg, prefix) {
  // IMPORTANT: keep this provider "incomplete" while the user is typing a bare
  // identifier. VS Code otherwise treats the first returned list as final and
  // only filters that stale list as `s -> sa -> sav -> save`, which means a
  // candidate that becomes relevant later (repository.save) may never be asked
  // for. For a one-character prefix we intentionally avoid the graph walk but
  // still return an empty incomplete list so VS Code re-queries us on the next
  // character.
  const minPrefix = Math.max(2, cfg.get('minimumPrefixLength', 1));
  if (!prefix) return new vscode.CompletionList([], true);
  if (prefix.length < minPrefix) return new vscode.CompletionList([], true);
  const cursorOffset = document.offsetAt(position);
  const scopeCtx = getIndexedScopeContext(document, position, true);
  const base = scopeCtx.visibleValues;
  const graphValues = scopeCtx.allValues;
  const candidates = await collectMemberIntentCandidates(
    document,
    graphValues,
    prefix,
    cfg.get('receiverSearchDepth', 2),
    cfg.get('maxReceiverSeeds', 64),
    token,
    cfg,
    base
  );
  if (token.isCancellationRequested) return new vscode.CompletionList([], true);

  const maxSuggestions = cfg.get('maxSuggestions', 20);
  const novel = balanceIntentRoots(candidates, maxSuggestions).slice(0, maxSuggestions);
  debug(cfg, `member-intent prefix=${prefix} seeds=${base.length} [${base.slice(0,12).map(x => `${x.name}:${x.type}`).join(', ')}] novel=${novel.length} [${novel.slice(0,12).map(x => `${x.name}{${x.score}}`).join(', ')}]`);
  const items = novel.map((candidate, index) => makeMemberIntentCompletion(document, position, candidate, prefix, index));
  // isIncomplete=true is the key to live fuzzy completion. It forces VS Code to
  // invoke this provider again as the prefix changes instead of merely filtering
  // the list returned for an earlier character.
  return new vscode.CompletionList(items, true);
}

function makeMemberIntentCompletion(document, position, candidate, prefix, index) {
  const item = new vscode.CompletionItem(candidate.name, vscode.CompletionItemKind.Method);
  const lineBefore = document.lineAt(position.line).text.slice(0, position.character);
  const isWholeStatement = /^\s*[A-Za-z_$][\w$]*$/.test(lineBefore);
  const inserted = candidate.insertText || candidate.name;
  const finalText = isWholeStatement ? `${inserted};` : inserted;
  item.insertText = candidate.isSnippet ? new vscode.SnippetString(finalText) : finalText;
  // Explicitly replace the bare intent prefix (`getM`) with the full reachable
  // expression. Relying on VS Code's default completion range is inconsistent
  // for items whose label starts with a different receiver (`failure.`).
  const start = new vscode.Position(position.line, Math.max(0, position.character - prefix.length));
  item.range = new vscode.Range(start, position);
  // We already performed our own fuzzy matching. VS Code applies a second filter
  // to returned completion items, so using `eventsadd` here would hide a valid
  // `add` -> `events.add(...)` result. Keep the item visible for the exact bare
  // intent that produced this completion session.
  // Let VS Code's own live filtering reinforce our semantic decision. Use the
  // best alias that matched this candidate (`save`, `repositorysave`, etc.)
  // instead of echoing the session prefix. This automatically removes stale
  // broad candidates as the user keeps typing.
  item.filterText = candidate.filterAlias || candidate.matchName || candidate.name;
  item.detail = `${candidate.type || '?'}  • reachable from ${candidate.root || 'in-scope value'}`;
  item.documentation = new vscode.MarkdownString(`Member-intent completion: \`${candidate.name}\` matches \`${prefix}\`.`);
  // No custom cross-provider sort key: let VS Code rank this alongside JDT by
  // the user's typed text. filterText carries the intent (e.g. getM).
  // Bare semantic intent is explicitly what the user typed for. Keep these
  // composed expressions ahead of unrelated JDT package/chain noise. This does
  // not affect normal `object.` member completion or postfix templates.
  item.sortText = `000-semantic-${String(index).padStart(3, '0')}`;
  item.preselect = false;
  item.commitCharacters = [';', ',', ')'];
  return item;
}

function methodSignatureKey(member) {
  if (!member || member.kind !== 'method') return '';
  const params = Array.isArray(member.paramTypes) ? member.paramTypes.map(t => semantic.normalizeType(t || '')) : [];
  if (params.length || member.arity === 0) return `${member.name}(${params.join(',')})`;
  return `${member.name}#${member.arity ?? ''}`;
}

function mergeResolvedAndObservedMembers(document, state, resolvedMembers) {
  // Completion describes what is legal from the receiver's resolved Java type.
  // Do NOT learn/rank members or argument snippets from calls that merely happen
  // to appear elsewhere in the current method/file. Existing code is evidence
  // about usage, not about the receiver's API, and made results depend on what
  // the user had already typed.
  return (resolvedMembers || []).map(m => ({
    ...m,
    paramTypes: Array.isArray(m.paramTypes) ? [...m.paramTypes] : m.paramTypes,
    observed: false,
    observedDefaults: false
  }));
}

async function collectMemberIntentCandidates(document, baseCandidates, prefix, maxDepth, maxSeeds, token, cfg, visibleValues = null) {
  maxDepth = Math.max(0, Math.min(2, Number(maxDepth) || 0));
  if (maxDepth <= 0) return [];

  // Build the complete configured shallow graph before scoring. Depth is capped
  // at two, so this stays bounded and (after prewarm) is normally a cache lookup.
  // Critically, do not let a strong depth-1 candidate suppress depth-2 intent:
  // typing `filter` must be able to discover `events.stream().filter(...)`.
  const entry = await ensureGraphDepth(document, baseCandidates, maxDepth, maxSeeds, token, cfg);
  if (token.isCancellationRequested) return [];

  const visibleRootDistances = visibleValues
    ? new Map(visibleValues.map(v => [`${v.name}@${v.nameOffset ?? v.offset ?? 0}`, v.lineDistance || 0]))
    : null;

  return pruneWeakIntentCandidates(
    scoreGraphForIntent(entry, prefix, maxDepth, visibleRootDistances),
    prefix
  );
}

function canonicalExpression(expression) {
  return String(expression || '').replace(/\s+/g, '').replace(/;$/, '');
}

function graphMemberIdentity(receiverExpression, member, rootKey = '') {
  const receiver = canonicalExpression(receiverExpression);
  // Completion is method-intent oriented, not overload oriented. Once the user
  // chooses `events.add(...)`, normal snippet/tab completion handles the args.
  // Keep overloads internally in the resolver, but collapse them to one UI row.
  if (member?.kind === 'method') return `${rootKey}|${receiver}.method:${member.name}`;
  return `${rootKey}|${receiver}.${member?.kind || 'field'}:${member?.name || ''}:${semantic.canonicalType(member?.type || '')}`;
}

function overloadUiPreference(member) {
  if (!member || member.kind !== 'method') return 0;
  // Completion is API/type driven. Prefer the least noisy overload only; code
  // already present in the method must not influence ranking or snippet args.
  const arity = Number.isFinite(member.arity) ? member.arity : 99;
  return Math.max(0, 30 - Math.min(30, arity * 5));
}

function memberIntentSort(a, b) {
  // Prefer the strongest semantic match, then shallower and simpler chains.
  // When `filter` finds both stream() and parallelStream(), the ordinary stream
  // chain is the less surprising default unless the query explicitly names
  // `parallel`.
  return b.score - a.score ||
    a.receiverDepth - b.receiverDepth ||
    canonicalExpression(a.name).length - canonicalExpression(b.name).length ||
    a.name.localeCompare(b.name);
}


async function collectReceiverExpressionCandidates(document, visibleValues, ctx, maxDepth, maxSeeds, token, cfg, activeVisibleValues = null) {
  maxDepth = Math.max(0, Math.min(2, Number(maxDepth) || 0));
  if (maxDepth <= 0) return [];

  // Expected-type completion queries the same prebuilt fixed graph. No progressive
  // expansion: depth 1 and depth 2 already exist in the method context.
  const entry = await ensureGraphDepth(document, visibleValues, maxDepth, maxSeeds, token, cfg);
  if (token.isCancellationRequested) return [];

  const visibleRootDistances = activeVisibleValues ? new Map(activeVisibleValues.map(v => [`${v.name}@${v.nameOffset ?? v.offset ?? 0}`, v.lineDistance || 0])) : null;
  const pool = maxDepth >= 2 ? [...entry.depth1, ...entry.depth2] : entry.depth1;
  return pool
    .filter(c => (!visibleRootDistances || visibleRootDistances.has(c.rootKey)) && semantic.typeCompatibility(c.type, ctx.expectedType) > 0)
    .map(c => ({ ...c, lineDistance: visibleRootDistances?.get(c.rootKey) ?? c.lineDistance ?? 0 }));
}

function looksLikeInvocationArgument(document, position) {
  const text = document.getText(new vscode.Range(new vscode.Position(Math.max(0, position.line - 8), 0), position));
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '<') angle++;
    else if (ch === '>') angle = Math.max(0, angle - 1);
  }
  if (paren <= 0) return false;
  const before = document.lineAt(position.line).text.slice(0, position.character);
  // Avoid treating control-structure headers as method-call argument contexts.
  if (/^\s*(if|for|while|switch|catch|synchronized)\b/.test(before)) return false;
  return true;
}

async function buildSignatureContext(document, position) {
  try {
    const help = await vscode.commands.executeCommand(
      'vscode.executeSignatureHelpProvider',
      document.uri,
      position,
      '('
    );
    if (help && help.signatures && help.signatures.length) {
      const signature = help.signatures[help.activeSignature || 0];
      const activeParameter = help.activeParameter == null ? 0 : help.activeParameter;
      let parsed = null;

      const parameter = signature.parameters && signature.parameters[activeParameter];
      if (parameter && typeof parameter.label === 'string') {
        parsed = semantic.parseSignatureParameter(`x(${parameter.label})`, 0);
      }
      if (!parsed) parsed = semantic.parseSignatureParameter(signature.label, activeParameter);

      if (parsed && parsed.type) {
        return {
          expectedType: parsed.type,
          parameterName: parsed.name || '',
          source: 'signature-help',
          signature: signature.label,
          activeParameter
        };
      }
    }
  } catch (err) {
    // JDT can still be starting; no expected-type augmentation is better than
    // stalling the normal completion list.
  }
  return null;
}

async function buildContext(document, position) {
  const textual = semantic.inferExpectedTypeFromText(document.getText(), document.offsetAt(position));
  if (textual) return textual;
  if (!looksLikeInvocationArgument(document, position)) return null;
  return buildSignatureContext(document, position);
}

function makeSemanticCompletion(candidate, ctx, index) {
  const label = candidate.name;
  const item = new vscode.CompletionItem(
    label,
    (candidate.kind === 'method' || candidate.kind === 'receiverMethod') ? vscode.CompletionItemKind.Method :
      (candidate.kind === 'field' || candidate.kind === 'receiverField') ? vscode.CompletionItemKind.Field :
      candidate.kind === 'constructor' ? vscode.CompletionItemKind.Constructor : vscode.CompletionItemKind.Variable
  );
  item.insertText = candidate.isSnippet ? new vscode.SnippetString(candidate.insertText || candidate.name) : (candidate.insertText || candidate.name);
  item.filterText = candidate.filterText || (candidate.matchNames && candidate.matchNames[0]) || candidate.name;
  item.detail = `${candidate.type}  • expected ${ctx.expectedType}`;
  item.documentation = new vscode.MarkdownString(
    `Semantic match for expected type \`${ctx.expectedType}\`.` +
    (ctx.parameterName ? ` Parameter: \`${ctx.parameterName}\`.` : '')
  );
  // Let VS Code merge/rank this naturally with JDT.
  item.sortText = undefined;
  // Never steal selection from JDT. If JDT already has the obvious local value,
  // it should remain selected; our expression is an augmentation of that list.
  item.preselect = false;
  item.commitCharacters = [',', ')'];
  return item;
}



async function diagnoseCurrentCompletion() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'java') {
    vscode.window.showWarningMessage('Open a Java editor before running completion diagnostics.');
    return;
  }
  const document = editor.document;
  const position = editor.selection.active;
  const cfg = vscode.workspace.getConfiguration('semanticJavaCompletion', document.uri);
  const lineBefore = document.lineAt(position.line).text.slice(0, position.character);
  const prefix = semantic.identifierPrefix(lineBefore);
  const cursorOffset = document.offsetAt(position);
  const text = document.getText();
  const fakeToken = { isCancellationRequested: false };

  output.appendLine('');
  output.appendLine('================ COMPLETION DIAGNOSTIC ================');
  output.appendLine(`time=${new Date().toISOString()}`);
  output.appendLine(`file=${document.uri.toString()}`);
  output.appendLine(`position=${position.line + 1}:${position.character + 1}`);
  output.appendLine(`lineBefore=${JSON.stringify(lineBefore)}`);
  output.appendLine(`prefix=${JSON.stringify(prefix)}`);
  output.appendLine(`settings enabled=${cfg.get('enabled', true)} minPrefix=${cfg.get('minimumPrefixLength', 1)} depth=${cfg.get('receiverSearchDepth', 2)} maxSeeds=${cfg.get('maxReceiverSeeds', 64)} maxSuggestions=${cfg.get('maxSuggestions', 20)}`);

  const textualCtx = semantic.inferExpectedTypeFromText(text, cursorOffset);
  const invocationLike = looksLikeInvocationArgument(document, position);
  let signatureCtx = null;
  if (!textualCtx && invocationLike) signatureCtx = await buildSignatureContext(document, position);
  const ctx = textualCtx || signatureCtx;
  output.appendLine(`context=${ctx ? JSON.stringify(ctx) : 'none'} invocationLike=${invocationLike}`);

  const visible = scopeIndex.collectVisibleValues(text, cursorOffset, { includeFields: true });
  output.appendLine(`visible-values=${visible.length}`);
  visible.slice(0, 50).forEach((v, i) => {
    output.appendLine(`  [${i}] ${v.kind} ${v.name} : ${v.type} offset=${v.offset} depth=${v.scopeDepth ?? '-'} distance=${v.lineDistance ?? '-'}`);
  });

  const maxSeeds = cfg.get('maxReceiverSeeds', 64);
  const seeds = visible
    .filter(c => (c.kind === 'variable' || c.kind === 'field') && /^[A-Za-z_$][\w$]*$/.test(c.name) && c.type)
    .slice(0, maxSeeds);
  output.appendLine(`receiver-seeds=${seeds.length}`);
  for (const seed of seeds) {
    const t0 = nowMs();
    let members = [];
    let error = null;
    try { members = await memberResolver.resolveTypeMembers(document, seed.type, fakeToken, 0, new Set(), { anchorOffset: Number.isFinite(seed.typeOffset) ? seed.typeOffset : seed.nameOffset, anchorUri: seed.anchorUri }); }
    catch (e) { error = e; }
    const observed = memberResolver.observedMembersForReceiver(text, seed.name);
    const merged = mergeResolvedAndObservedMembers(document, { expression: seed.name, type: seed.type, root: seed.name }, members);
    output.appendLine(`SEED ${seed.name}:${seed.type} resolved=${members.length} observed=${observed.length} merged=${merged.length} ms=${(nowMs()-t0).toFixed(1)}${error ? ` ERROR=${error.stack || error.message || error}` : ''}`);
    const scored = merged.map(m => {
      const expression = `${seed.name}.${m.name}${m.call || ''}`;
      const candidate = {
        name: expression,
        matchName: m.name,
        matchNames: [`${seed.name}${m.name}`, `${seed.name}.${m.name}`]
      };
      return { m, expression, score: semantic.completionMatchScore(candidate, prefix) };
    }).filter(x => x.score >= 0).sort((a,b) => b.score-a.score).slice(0,20);
    for (const x of scored) output.appendLine(`    score=${x.score} ${x.expression} -> ${x.m.type || '?'}${x.m.observed ? ' [observed]' : ''}`);
    if (prefix && !scored.length) {
      const named = merged.filter(m => m.name.toLowerCase().includes(prefix.toLowerCase()) || prefix.toLowerCase().includes(m.name.toLowerCase())).slice(0,10);
      for (const m of named) output.appendLine(`    near-name(no fuzzy match) ${seed.name}.${m.name}${m.call || ''} -> ${m.type || '?'}`);
    }
  }

  const t1 = nowMs();
  const graph = await collectMemberIntentCandidates(document, visible, prefix, cfg.get('receiverSearchDepth', 2), maxSeeds, fakeToken, cfg, visible);
  output.appendLine(`graph-results=${graph.length} ms=${(nowMs()-t1).toFixed(1)}`);
  graph.slice(0, 40).forEach((c, i) => output.appendLine(`  RESULT[${i}] score=${c.score} depth=${c.receiverDepth} ${c.name} -> ${c.type || '?'}`));
  output.appendLine('=======================================================');
  output.show(true);
}

function debug(cfg, message) {
  if (!cfg.get('debug', false)) return;
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function deactivate() {}

module.exports = { activate, deactivate };
