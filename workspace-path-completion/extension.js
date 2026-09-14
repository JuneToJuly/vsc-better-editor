const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

let index = [];
let indexGeneration = 0;
let rebuilding = false;
let rebuildTimer = undefined;
let pendingRebuildReason = undefined;
let output;
let fzfAvailable = undefined;

function cfg() {
  return vscode.workspace.getConfiguration('workspacePathCompletion');
}

function debug(message) {
  if (!cfg().get('debug', false)) return;
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function slash(p) {
  return p.replace(/\\/g, '/');
}

function workspaceRelative(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return slash(uri.fsPath);
  return slash(path.relative(folder.uri.fsPath, uri.fsPath));
}

function getWorkspaceRoots() {
  return (vscode.workspace.workspaceFolders || []).map(f => ({ name: f.name, uri: f.uri }));
}

function globToRegExp(glob) {
  // Deliberately small glob implementation for include/exclude filtering after findFiles.
  // Supports *, ** and ?. Paths are normalized to forward slashes.
  let s = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          s += '(?:.*/)?';
        } else {
          s += '.*';
        }
      } else {
        s += '[^/]*';
      }
    } else if (c === '?') {
      s += '[^/]';
    } else {
      s += c.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
    }
  }
  return new RegExp(s + '$', process.platform === 'win32' ? 'i' : '');
}

function compilePatterns(patterns) {
  return (patterns || []).map(p => {
    try { return globToRegExp(slash(p)); } catch { return null; }
  }).filter(Boolean);
}

function matchesAny(rel, regexes) {
  return regexes.some(r => r.test(rel));
}

function flattenExcludeObject(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => prefix + key);
}

function currentExcludePatterns() {
  const own = cfg().get('exclude', []);
  const filesExclude = flattenExcludeObject(vscode.workspace.getConfiguration('files').get('exclude', {}));
  const useSearchExclude = cfg().get('useSearchExclude', false);
  const searchExclude = useSearchExclude
    ? flattenExcludeObject(vscode.workspace.getConfiguration('search').get('exclude', {}))
    : [];
  return [...own, ...filesExclude, ...searchExclude];
}

async function rebuildIndex(reason = 'manual') {
  if (rebuilding) {
    pendingRebuildReason = pendingRebuildReason
      ? `${pendingRebuildReason},${reason}`
      : reason;
    debug(`index rebuild queued reason=${reason}`);
    return;
  }
  rebuilding = true;
  const generation = ++indexGeneration;
  const started = performance.now();
  try {
    const max = cfg().get('maxIndexedFiles', 200000);
    const includeRegex = compilePatterns(cfg().get('include', []));
    const excludeRegex = compilePatterns(currentExcludePatterns());
    const includeOnly = includeRegex.length > 0;

    const includePatterns = cfg().get('include', []);
    const searchInclude = includePatterns.length === 1
      ? includePatterns[0]
      : includePatterns.length > 1
        ? `{${includePatterns.join(',')}}`
        : '**/*';

    // IMPORTANT: pass null, not undefined and not our combined exclusion glob.
    // VS Code treats undefined as "use the default search excludes". That can
    // silently remove files (notably generated/build outputs) before this
    // extension ever gets a chance to apply useSearchExclude=false.
    //
    // We intentionally enumerate the include universe here and apply ALL
    // extension/files/search exclusion rules below in one deterministic place.
    const uris = await vscode.workspace.findFiles(searchInclude, null, max);
    if (generation !== indexGeneration) return;

    const map = new Map();
    for (const uri of uris) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) continue;
      const rel = slash(path.relative(folder.uri.fsPath, uri.fsPath));
      if (!rel || rel.startsWith('../')) continue;
      if (matchesAny(rel, excludeRegex)) continue;
      if (includeOnly && !matchesAny(rel, includeRegex)) continue;

      map.set(uri.toString(), {
        uri,
        workspaceFolder: folder,
        rel,
        basename: path.posix.basename(rel),
        dirname: path.posix.dirname(rel),
        kind: 'file'
      });
    }

    if (cfg().get('includeDirectories', true)) {
      const dirs = new Map();
      for (const entry of map.values()) {
        const parts = entry.rel.split('/');
        parts.pop();
        let acc = '';
        for (const part of parts) {
          acc = acc ? `${acc}/${part}` : part;
          const key = `${entry.workspaceFolder.uri.toString()}::${acc}`;
          if (!dirs.has(key)) {
            dirs.set(key, {
              uri: vscode.Uri.joinPath(entry.workspaceFolder.uri, ...acc.split('/')),
              workspaceFolder: entry.workspaceFolder,
              rel: acc + '/',
              basename: part + '/',
              dirname: path.posix.dirname(acc),
              kind: 'dir'
            });
          }
        }
      }
      for (const [key, dir] of dirs) map.set(`dir:${key}`, dir);
    }

    index = [...map.values()];
    debug(`index rebuilt reason=${reason} entries=${index.length} files=${uris.length} time=${(performance.now() - started).toFixed(1)}ms`);
  } catch (err) {
    output.appendLine(`Index rebuild failed: ${err && err.stack || err}`);
  } finally {
    rebuilding = false;

    // Configuration/file events can arrive while findFiles is still running.
    // Do not lose those requests; run one coalesced follow-up rebuild using the
    // latest configuration once the current rebuild finishes.
    if (pendingRebuildReason) {
      const queuedReason = pendingRebuildReason;
      pendingRebuildReason = undefined;
      scheduleRebuild(`queued:${queuedReason}`, 0);
    }
  }
}

function scheduleRebuild(reason, delay = 250) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = undefined;
    rebuildIndex(reason);
  }, delay);
}

function isBoundary(str, i) {
  if (i === 0) return true;
  const p = str[i - 1];
  const c = str[i];

  // Semantic/path boundaries from the shared fuzzy-match contract.
  if ('/\\-_.'.includes(p) || /\s/.test(p)) return true;
  if (/[a-z]/.test(p) && /[A-Z]/.test(c)) return true;
  if (/[A-Za-z]/.test(p) && /\d/.test(c)) return true;
  if (/\d/.test(p) && /[A-Za-z]/.test(c)) return true;
  return false;
}

// Shared fuzzy-match contract. Keep these deliberately simple and relative:
// matching is always positive; semantic boundaries and runs are valuable;
// opening a gap is expensive; extending an existing gap is cheaper.
const FUZZY = Object.freeze({
  MATCH: 16,
  BOUNDARY: 12,
  FIRST_BOUNDARY_EXTRA: 24,
  CONSECUTIVE: 18,
  GAP_START: 14,
  GAP_EXTEND: 2,
  SPAN_GAP: 1,
  PRIMARY_FIELD: 24,
  CLOSE_MATCH_BUCKET: 6,
  // Reverse matching is intentionally stricter than forward matching. It exists
  // to keep a complete filename relevant when the user types extra text around
  // it (testbuild.gradle / build.gradletest), not to admit tiny fragments such
  // as the directory 'build/' for a long filename query.
  MIN_REVERSE_COVERAGE: 0.60
});

function charsEqual(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Score the best ordered alignment of query inside candidate.
 *
 * This is dynamic programming rather than a greedy subsequence walk. That
 * matters for names such as OrderWorkflow: there can be several legal
 * alignments and we want the one with the strongest boundaries/consecutive
 * runs, not simply the first characters encountered.
 *
 * Runtime is O(query.length * candidate.length).
 */
function fuzzyScore(query, candidate) {
  if (!query) return 1;
  if (!candidate || query.length > candidate.length) return Number.NEGATIVE_INFINITY;

  const q = query;
  const n = candidate.length;
  const m = q.length;
  let previous = new Array(n).fill(Number.NEGATIVE_INFINITY);

  // First query character: every match gets the base score, with an amplified
  // bonus when it lands on a semantic boundary.
  for (let j = 0; j < n; j++) {
    if (!charsEqual(q[0], candidate[j])) continue;
    const boundary = isBoundary(candidate, j);
    previous[j] = FUZZY.MATCH
      + (boundary ? FUZZY.BOUNDARY + FUZZY.FIRST_BOUNDARY_EXTRA : 0);
  }

  for (let qi = 1; qi < m; qi++) {
    const current = new Array(n).fill(Number.NEGATIVE_INFINITY);

    // For a gapped transition k -> j (k <= j-2):
    //   prev[k] - GAP_START - GAP_EXTEND*(gap-1) - SPAN_GAP*gap
    // can be rearranged so the best eligible k is maintained incrementally.
    // This avoids an O(n^2) scan for each query character.
    let bestGapBase = Number.NEGATIVE_INFINITY;

    for (let j = 0; j < n; j++) {
      const newlyEligible = j - 2;
      if (newlyEligible >= 0 && Number.isFinite(previous[newlyEligible])) {
        const k = newlyEligible;
        const base = previous[k] + (FUZZY.GAP_EXTEND + FUZZY.SPAN_GAP) * k;
        if (base > bestGapBase) bestGapBase = base;
      }

      if (!charsEqual(q[qi], candidate[j])) continue;

      const matchBonus = FUZZY.MATCH + (isBoundary(candidate, j) ? FUZZY.BOUNDARY : 0);
      let best = Number.NEGATIVE_INFINITY;

      // Consecutive characters are strongly preferred.
      if (j > 0 && Number.isFinite(previous[j - 1])) {
        best = previous[j - 1] + FUZZY.CONSECUTIVE;
      }

      // A gap pays a large one-time opening cost and a smaller extension cost.
      if (Number.isFinite(bestGapBase)) {
        const gapTransition = bestGapBase
          - FUZZY.GAP_START
          - (FUZZY.GAP_EXTEND + FUZZY.SPAN_GAP) * (j - 2)
          - FUZZY.SPAN_GAP;
        if (gapTransition > best) best = gapTransition;
      }

      if (Number.isFinite(best)) current[j] = best + matchBonus;
    }

    previous = current;
  }

  let best = Number.NEGATIVE_INFINITY;
  for (const score of previous) if (score > best) best = score;
  return best;
}

/**
 * Match a user query against a file candidate.
 *
 * Normal fuzzy matching remains one-way: query -> candidate. Every query
 * character must be explained by the filename/path in order.
 *
 * We support one deliberate "reverse qualifier" form for filenames:
 *
 *   testbuild.gradle
 *   build.gradletest
 *
 * when the real filename is build.gradle. The filename itself must occur as a
 * contiguous substring of what the user typed. Any characters before/after
 * that filename are NOT discarded; each leftover qualifier must fuzzy-match
 * the file's directory/workspace context. This prevents every build.gradle in
 * the workspace from matching build.gradletest just because the filename is a
 * substring of the query.
 */
function qualifiedReversePrimaryScore(query, candidate) {
  const primary = candidate.entry.basename.replace(/\/$/, '');
  if (!query || !primary || query.length <= primary.length) {
    return { score: Number.NEGATIVE_INFINITY, direction: 'none', qualifiers: [] };
  }

  const qLower = query.toLowerCase();
  const pLower = primary.toLowerCase();
  const occurrences = [];
  let from = 0;
  while (from <= qLower.length - pLower.length) {
    const at = qLower.indexOf(pLower, from);
    if (at < 0) break;
    occurrences.push(at);
    from = at + 1;
  }
  if (!occurrences.length) {
    return { score: Number.NEGATIVE_INFINITY, direction: 'none', qualifiers: [] };
  }

  // Search only directory/workspace context here. Never allow the basename to
  // satisfy its own leftover qualifier.
  const dirname = candidate.entry.dirname && candidate.entry.dirname !== '.'
    ? candidate.entry.dirname
    : '';
  const contextParts = [candidate.entry.workspaceFolder.name, dirname].filter(Boolean);
  const secondaryContext = contextParts.join('/');
  if (!secondaryContext) {
    return { score: Number.NEGATIVE_INFINITY, direction: 'none', qualifiers: [] };
  }

  let best = Number.NEGATIVE_INFINITY;
  let bestQualifiers = [];

  for (const at of occurrences) {
    const before = query.slice(0, at);
    const after = query.slice(at + primary.length);
    const qualifiers = [before, after]
      .map(x => x.replace(/^[\s/\\._-]+|[\s/\\._-]+$/g, ''))
      .filter(Boolean);

    // A longer query with no meaningful leftover text is not a qualified
    // reverse match.
    if (!qualifiers.length) continue;

    let qualifierScore = 0;
    let valid = true;
    for (const qualifier of qualifiers) {
      const s = fuzzyScore(qualifier, secondaryContext);
      if (!Number.isFinite(s)) {
        valid = false;
        break;
      }
      qualifierScore += s;
    }
    if (!valid) continue;

    // Score the filename as the primary field, then add a smaller contribution
    // from the directory qualifiers. Exact/normal filename matches still win.
    const primaryScore = fuzzyScore(primary, primary);
    const score = primaryScore + FUZZY.PRIMARY_FIELD + Math.floor(qualifierScore * 0.35);
    if (score > best) {
      best = score;
      bestQualifiers = qualifiers;
    }
  }

  return Number.isFinite(best)
    ? { score: best, direction: 'qualified-reverse', qualifiers: bestQualifiers }
    : { score: Number.NEGATIVE_INFINITY, direction: 'none', qualifiers: [] };
}

/**
 * Filename is the primary field. The runtime path is the secondary field.
 * Strong filename hits beat weak directory-only hits. Normal fuzzy matching is
 * strictly query -> candidate; the only reverse behavior is the qualified
 * filename form above, where every extra typed character must be explained by
 * directory/workspace context.
 */
function textualScore(query, candidate) {
  if (!query) return { score: 1, field: 'primary', direction: 'forward' };

  const primary = candidate.entry.basename.replace(/\/$/, '');
  const primaryScore = fuzzyScore(query, primary);
  const pathScore = fuzzyScore(query, candidate.text);
  const qualifiedReverse = candidate.entry.kind === 'file'
    ? qualifiedReversePrimaryScore(query, candidate)
    : { score: Number.NEGATIVE_INFINITY, direction: 'none' };

  let bestScore = Number.NEGATIVE_INFINITY;
  let field = 'none';
  let direction = 'none';

  if (Number.isFinite(primaryScore)) {
    bestScore = primaryScore + FUZZY.PRIMARY_FIELD;
    field = 'primary';
    direction = 'forward';
  }
  if (Number.isFinite(pathScore) && pathScore > bestScore) {
    bestScore = pathScore;
    field = 'path';
    direction = 'forward';
  }
  if (Number.isFinite(qualifiedReverse.score) && qualifiedReverse.score > bestScore) {
    bestScore = qualifiedReverse.score;
    field = 'primary+path-qualifier';
    direction = qualifiedReverse.direction;
  }

  return { score: bestScore, field, direction };
}

function rankCandidates(query, candidates, maxResults) {
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const text = textualScore(query, c);
    if (!Number.isFinite(text.score)) continue;

    // Domain/API relevance is intentionally NOT part of the textual score.
    // It can only reorder candidates in the same narrow textual-quality bucket,
    // so it cannot rescue a poor fuzzy match over a materially better one.
    const bucket = Math.floor(text.score / FUZZY.CLOSE_MATCH_BUCKET);
    scored.push({ c, textScore: text.score, bucket, stableIndex: i });
  }

  scored.sort((a, b) => {
    if (b.bucket !== a.bucket) return b.bucket - a.bucket;
    if (b.c.weight !== a.c.weight) return b.c.weight - a.c.weight;
    if (b.textScore !== a.textScore) return b.textScore - a.textScore;
    return a.stableIndex - b.stableIndex;
  });

  return scored.slice(0, maxResults).map(x => x.c);
}

function normalizeTyped(raw) {
  return raw.replace(/\\\\/g, '/').replace(/\\/g, '/');
}

function stringContext(document, position) {
  const line = document.lineAt(position.line).text;
  const left = line.slice(0, position.character);

  // Find the nearest unmatched single/double quote on this line.
  let quoteIndex = -1;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < left.length; i++) {
    const ch = left[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) {
      if (ch === quote) { quote = ''; quoteIndex = -1; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoteIndex = i;
    }
  }
  if (!quote || quoteIndex < 0) return null;

  const typed = left.slice(quoteIndex + 1);
  const start = new vscode.Position(position.line, quoteIndex + 1);
  return {
    typed,
    normalizedTyped: normalizeTyped(typed),
    range: new vscode.Range(start, position),
    line,
    beforeString: line.slice(0, quoteIndex)
  };
}

function javaApiMode(document, context) {
  if (document.languageId !== 'java') return 'generic';
  const b = context.beforeString;

  // ClassLoader resource names never start with '/'. Check this before the
  // broader getResource/getResourceAsStream match.
  if (/(?:getClassLoader\s*\(\s*\)|classLoader\b)[\s\S]*?\.\s*(?:getResource|getResourceAsStream)\s*\(\s*$/i.test(b)) {
    return 'classloader-resource';
  }
  if (/\.\s*(?:getResource|getResourceAsStream)\s*\(\s*$/.test(b)) {
    return 'class-resource';
  }
  if (/(?:new\s+File|Path\.of|Paths\.get)\s*\(\s*$/.test(b)) {
    return 'filesystem';
  }
  return 'generic';
}

let resourceRootCacheKey = '';
let resourceRootRegexes = [];

function configuredResourceRootRegexes() {
  const patterns = cfg().get('resourceRoots', [
    '**/src/main/resources',
    '**/src/test/resources'
  ]);
  const key = JSON.stringify(patterns);
  if (key !== resourceRootCacheKey) {
    resourceRootCacheKey = key;
    resourceRootRegexes = compilePatterns(patterns.map(p => slash(p).replace(/\/$/, '')));
  }
  return resourceRootRegexes;
}

function resourcePathForEntry(entry) {
  const rel = slash(entry.rel).replace(/\/$/, '');
  if (!rel) return null;
  const parts = rel.split('/');
  const regexes = configuredResourceRootRegexes();

  // Test each directory prefix against the configured resource-root globs.
  // This supports multi-project workspaces such as service-a/src/main/resources.
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (!matchesAny(prefix, regexes)) continue;
    let resource = parts.slice(i).join('/');
    if (!resource) return null;
    if (entry.kind === 'dir' && !resource.endsWith('/')) resource += '/';
    return resource;
  }
  return null;
}

function absolutePathForEntry(entry) {
  let absolute = slash(entry.uri.fsPath);
  if (entry.kind === 'dir' && !absolute.endsWith('/')) absolute += '/';
  return absolute;
}

function javaCandidateForms(entry, apiMode) {
  const forms = [];
  const resource = cfg().get('javaResourceAwareness', true) ? resourcePathForEntry(entry) : null;
  const absolute = absolutePathForEntry(entry);

  if (resource) {
    let resourceText;
    let weight;
    if (apiMode === 'classloader-resource') {
      resourceText = resource;
      weight = 100;
    } else {
      // Class.getResource uses '/' for a classpath-root-relative resource. For
      // generic strings we prefer that explicit root form as the safest Java
      // resource representation.
      resourceText = '/' + resource;
      weight = apiMode === 'class-resource' ? 100 : 75;
    }
    forms.push({
      text: resourceText,
      weight,
      semantic: 'Resource',
      label: resourceText,
      description: apiMode === 'classloader-resource' ? 'Resource • ClassLoader' : 'Resource'
    });
  }

  // Filesystem APIs should rank absolute paths first. Resource APIs still show
  // the absolute form as an escape hatch, but clearly below the resource name.
  const absoluteWeight = apiMode === 'filesystem' ? 100
    : (apiMode === 'class-resource' || apiMode === 'classloader-resource') ? 20
      : resource ? 55 : 85;
  forms.push({
    text: absolute,
    weight: absoluteWeight,
    semantic: 'Absolute',
    label: absolute,
    description: 'Absolute'
  });

  return forms;
}

function nonJavaCandidateForms(entry, document) {
  const forms = [];
  const rel = entry.rel;
  forms.push({ text: rel, weight: 35, label: rel, semantic: 'Workspace', description: 'Workspace' });

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder && folder.uri.toString() === entry.workspaceFolder.uri.toString()) {
    const currentDir = path.dirname(document.uri.fsPath);
    let relative = slash(path.relative(currentDir, entry.uri.fsPath));
    if (entry.kind === 'dir' && !relative.endsWith('/')) relative += '/';
    if (relative && relative !== '.') {
      const preferRelative = cfg().get('preferRelativeToCurrentFile', true);
      forms.push({ text: relative, weight: preferRelative ? 50 : 20, label: relative, semantic: 'Relative', description: 'Relative' });
    }
  }

  if ((vscode.workspace.workspaceFolders || []).length > 1) {
    const text = `${entry.workspaceFolder.name}/${rel}`;
    forms.push({ text, weight: 10, label: text, semantic: 'Workspace', description: entry.workspaceFolder.name });
  }
  return forms;
}

function candidateForms(entry, document, apiMode) {
  const forms = document.languageId === 'java'
    ? javaCandidateForms(entry, apiMode)
    : nonJavaCandidateForms(entry, document);

  const dedupe = new Map();
  for (const f of forms) {
    const prev = dedupe.get(f.text);
    if (!prev || prev.weight < f.weight) dedupe.set(f.text, f);
  }
  return [...dedupe.values()];
}


function compactParentPath(entry, maxChars = 44) {
  let parent = slash(path.dirname(entry.uri.fsPath));
  if (!parent || parent === '.' || parent === '/') return '';

  const parts = parent.split('/').filter(Boolean);
  if (!parts.length) return parent;

  // Keep the most useful information visible: the directories nearest the file.
  // Build from the end until the hint reaches the desired width, then prefix an ellipsis.
  const kept = [];
  let length = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const nextLength = length + part.length + (kept.length ? 1 : 0);
    if (kept.length && nextLength > maxChars) break;
    kept.unshift(part);
    length = nextLength;
  }

  let result = kept.join('/');
  if (kept.length < parts.length) result = `…/${result}`;
  return result ? `${result}/` : '';
}

function completionPresentation(candidate) {
  if (candidate.semantic === 'Absolute') {
    // Keep the natural path reading order while avoiding the useless long prefix:
    //   …/nearest/parent/file.ext
    // The full absolute path remains candidate.text and is what gets inserted.
    const parent = compactParentPath(candidate.entry);
    return {
      label: `${parent}${candidate.entry.basename}`,
      labelDetail: '',
      description: 'Absolute'
    };
  }

  if (candidate.semantic === 'Resource') {
    return {
      label: candidate.text,
      labelDetail: '',
      description: candidate.description || 'Resource'
    };
  }

  return {
    label: candidate.label || candidate.text,
    labelDetail: '',
    description: candidate.description || candidate.semantic
  };
}

function checkFzfAvailable() {
  if (fzfAvailable !== undefined) return fzfAvailable;
  const exe = cfg().get('fzfPath', 'fzf');
  try {
    const result = cp.spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 500 });
    fzfAvailable = result.status === 0;
  } catch {
    fzfAvailable = false;
  }
  debug(`fzf available=${fzfAvailable}`);
  return fzfAvailable;
}

function rankWithFzf(query, candidates, limit) {
  if (!query || !candidates.length) return null;
  const exe = cfg().get('fzfPath', 'fzf');
  // Use numeric IDs so duplicate path forms remain safe and output parsing is trivial.
  const input = candidates.map((c, i) => `${i}\t${c.text}`).join('\n');
  try {
    const result = cp.spawnSync(exe, [
      '--filter', query,
      '--no-sort',
      '--tiebreak=begin,length,index',
      '--delimiter=\t',
      '--with-nth=2..'
    ], {
      input,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 1000,
      windowsHide: true
    });
    if (result.error) return null;
    const rows = (result.stdout || '').split(/\r?\n/).filter(Boolean).slice(0, limit);
    const ranked = [];
    for (const row of rows) {
      const tab = row.indexOf('\t');
      const id = Number(tab >= 0 ? row.slice(0, tab) : row);
      if (Number.isInteger(id) && candidates[id]) ranked.push(candidates[id]);
    }
    return ranked;
  } catch {
    return null;
  }
}

async function provideCompletionItems(document, position, token) {
  const settings = cfg();
  if (!settings.get('enabled', true)) return undefined;
  const languages = settings.get('languages', []);
  if (languages.length && !languages.includes(document.languageId)) return undefined;

  const context = stringContext(document, position);
  if (!context) return undefined;
  if (token.isCancellationRequested) return undefined;

  const started = performance.now();
  const apiMode = javaApiMode(document, context);
  const query = context.normalizedTyped;
  const maxResults = settings.get('maxResults', 60);

  let candidates = [];
  for (const entry of index) {
    for (const form of candidateForms(entry, document, apiMode)) {
      candidates.push({ entry, ...form });
    }
  }

  // Always apply the shared deterministic fuzzy-match contract. fzf remains
  // detectable for compatibility/diagnostics, but it no longer controls ranking:
  // an external fuzzy implementation cannot guarantee this extension's scoring
  // invariants (especially primary-field priority and domain tie-breaking).
  const ranked = rankCandidates(query, candidates, maxResults);
  const useFzf = false;

  const seen = new Set();
  const items = [];
  for (let i = 0; i < ranked.length; i++) {
    const c = ranked[i];
    if (seen.has(c.text)) continue;
    seen.add(c.text);

    const presentation = completionPresentation(c);
    const item = new vscode.CompletionItem(
      {
        label: presentation.label,
        detail: presentation.labelDetail,
        description: presentation.description
      },
      c.entry.kind === 'dir' ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
    );
    // The visible label is intentionally concise. The inserted value remains the
    // full runtime-meaningful path (absolute filesystem path or resource path).
    item.insertText = c.text;
    item.range = context.range;
    // Our matcher is authoritative. This provider returns a query-specific,
    // already-filtered CompletionList and marks it incomplete so VS Code asks
    // us again as the user types. Setting filterText to the exact current query
    // prevents VS Code's separate fuzzy filter from discarding candidates that
    // our contract intentionally accepts (for example both testbuild.gradle and
    // build.gradletest for query build.gradle).
    item.filterText = query || c.entry.basename || c.text;
    item.sortText = String(i).padStart(5, '0');
    item.detail = `${c.semantic} • ${c.entry.kind === 'dir' ? 'Directory' : 'File'} • ${c.entry.workspaceFolder.name}`;
    item.documentation = new vscode.MarkdownString(`**${c.semantic}**\n\nWorkspace file: \`${c.entry.rel}\``);
    if (c.entry.kind === 'dir') {
      // Keep the completion UI open after accepting a directory.
      item.command = { command: 'editor.action.triggerSuggest', title: 'Continue path completion' };
    }
    items.push(item);
  }

  debug(`complete lang=${document.languageId} query=${JSON.stringify(query)} candidates=${candidates.length} returned=${items.length} apiMode=${apiMode} backend=contract time=${(performance.now() - started).toFixed(1)}ms`);
  // Our candidate set is query-dependent and capped by maxResults. Mark the
  // list incomplete so VS Code invokes the provider again as the user types
  // instead of only re-filtering a stale earlier result set locally.
  return new vscode.CompletionList(items, true);
}

async function diagnoseQuery() {
  const query = await vscode.window.showInputBox({
    prompt: 'Filename or fuzzy query to diagnose',
    placeHolder: 'build.gradletest'
  });
  if (query === undefined) return;

  const q = normalizeTyped(query);
  const matches = [];
  for (const entry of index) {
    const basename = entry.basename.replace(/\/$/, '');
    const basenameScoreRaw = fuzzyScore(q, basename);
    const relScore = fuzzyScore(q, entry.rel);

    // Diagnose the same qualified-reverse behavior used by completion. Use a
    // lightweight candidate wrapper because only entry metadata is required.
    const qualified = entry.kind === 'file'
      ? qualifiedReversePrimaryScore(q, { entry })
      : { score: Number.NEGATIVE_INFINITY, direction: 'none', qualifiers: [] };

    const basenameScore = Number.isFinite(basenameScoreRaw)
      ? basenameScoreRaw
      : qualified.score;
    const basenameDirection = Number.isFinite(basenameScoreRaw)
      ? 'forward'
      : qualified.direction;

    if (Number.isFinite(basenameScore) || Number.isFinite(relScore)) {
      matches.push({
        entry, basenameScore, relScore,
        basenameDirection,
        relDirection: Number.isFinite(relScore) ? 'forward' : 'none',
        qualifiers: qualified.qualifiers || []
      });
    }
  }

  matches.sort((a, b) => {
    const as = Math.max(Number.isFinite(a.basenameScore) ? a.basenameScore + FUZZY.PRIMARY_FIELD : -Infinity, a.relScore);
    const bs = Math.max(Number.isFinite(b.basenameScore) ? b.basenameScore + FUZZY.PRIMARY_FIELD : -Infinity, b.relScore);
    return bs - as;
  });

  output.show(true);
  output.appendLine('');
  output.appendLine(`=== Diagnose query ${JSON.stringify(query)} ===`);
  output.appendLine(`index entries=${index.length} fuzzy matches=${matches.length}`);
  for (const m of matches.slice(0, 100)) {
    output.appendLine(`${m.entry.kind.padEnd(4)} basenameScore=${String(m.basenameScore).padEnd(8)}(${m.basenameDirection}) relScore=${String(m.relScore).padEnd(8)}(${m.relDirection})${m.qualifiers && m.qualifiers.length ? ` qualifiers=${JSON.stringify(m.qualifiers)}` : ''} ${m.entry.rel}`);
  }
  if (!matches.length) {
    output.appendLine('No indexed entry matches this query. Reverse filename qualifiers must also match directory/workspace context.');
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('Workspace Path Completion');
  context.subscriptions.push(output);

  const selector = { scheme: 'file' };
  // Trigger directly on normal path/query characters so completion works even when
  // editor.quickSuggestions.strings is disabled (the common VS Code default).
  const triggerCharacters = [
    ...'abcdefghijklmnopqrstuvwxyz',
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ...'0123456789',
    '/', '\\', '.', '-', '_', '@', '~'
  ];
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    selector,
    { provideCompletionItems },
    ...triggerCharacters
  ));

  context.subscriptions.push(vscode.commands.registerCommand('workspacePathCompletion.rebuildIndex', async () => {
    await rebuildIndex('command');
    vscode.window.showInformationMessage(`Workspace Path Completion indexed ${index.length} entries.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('workspacePathCompletion.showStats', () => {
    const files = index.filter(x => x.kind === 'file').length;
    const dirs = index.length - files;
    vscode.window.showInformationMessage(`Workspace Path Completion: ${files} files, ${dirs} directories, fzf=${checkFzfAvailable() ? 'available' : 'not found'}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('workspacePathCompletion.diagnoseQuery', diagnoseQuery));

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate(() => scheduleRebuild('create', 400));
  watcher.onDidDelete(() => scheduleRebuild('delete', 400));
  context.subscriptions.push(watcher);

  context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => scheduleRebuild('rename', 250)));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRebuild('workspace-folders', 100)));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    const ownChanged = e.affectsConfiguration('workspacePathCompletion');
    const filesExcludeChanged = e.affectsConfiguration('files.exclude');
    const searchExcludeChanged = e.affectsConfiguration('search.exclude');

    // Always react to both VS Code exclusion settings. search.exclude only
    // affects filtering when useSearchExclude=true, but rebuilding here makes
    // the index lifecycle predictable when users switch project/exclude presets.
    if (ownChanged || filesExcludeChanged || searchExcludeChanged) {
      fzfAvailable = undefined;
      const changed = [
        ownChanged ? 'workspacePathCompletion' : '',
        filesExcludeChanged ? 'files.exclude' : '',
        searchExcludeChanged ? 'search.exclude' : ''
      ].filter(Boolean).join('+');
      debug(`configuration changed: ${changed}`);
      scheduleRebuild(`configuration:${changed}`, 250);
    }
  }));

  rebuildIndex('activate');
}

function deactivate() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
}

module.exports = { activate, deactivate };
