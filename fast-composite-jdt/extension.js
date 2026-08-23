'use strict';

const vscode = require('vscode');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

let output;
let status;
let activeContext;

const MODEL_VERSION = 1;
const LEGACY_MODEL_FILE = 'composite-model.json';
const ROOTS_DIR = 'roots';
const ROOTS_STATE = 'compositeRoots';
const ACTIVE_ROOT_STATE = 'activeCompositeRoot';
const APPLIED_ROOT_STATE = 'appliedCompositeRoot';
const GENERATED_MARKER = '<!-- generated-by: fast-composite-jdt -->';
const GENERATED_PREFS_MARKER = '# generated-by: fast-composite-jdt';

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  output?.appendLine(line);
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function logTiming(label, ms) {
  log(`Timing · ${label.padEnd(28)} ${formatMs(ms)}`);
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function normalize(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return undefined;

  for (const folder of folders) {
    for (const name of ['settings.gradle', 'settings.gradle.kts']) {
      if (fs.existsSync(path.join(folder.uri.fsPath, name))) return folder.uri.fsPath;
    }
  }
  return folders[0].uri.fsPath;
}

function findCompositeRoot(start) {
  if (!start) return undefined;
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, 'settings.gradle')) || fs.existsSync(path.join(dir, 'settings.gradle.kts'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function wrapperFor(root) {
  const unix = path.join(root, 'gradlew');
  const win = path.join(root, 'gradlew.bat');
  if (process.platform === 'win32' && fs.existsSync(win)) return win;
  if (fs.existsSync(unix)) return unix;
  if (fs.existsSync(win)) return win;
  return 'gradle';
}

function legacyModelPath(context) {
  return path.join(context.globalStorageUri.fsPath, LEGACY_MODEL_FILE);
}

function rootKey(root) {
  return sha1(normalize(root)).slice(0, 16);
}

function modelPath(context, root) {
  return path.join(context.globalStorageUri.fsPath, ROOTS_DIR, `${rootKey(root)}.json`);
}

async function readCachedModel(context, root) {
  if (!root) return undefined;
  try {
    const parsed = JSON.parse(await fsp.readFile(modelPath(context, root), 'utf8'));
    if (parsed.modelVersion !== MODEL_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCachedModel(context, root, model) {
  const dir = path.join(context.globalStorageUri.fsPath, ROOTS_DIR);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(modelPath(context, root), JSON.stringify(model, null, 2));
}

function rootDisplayName(root) {
  const base = path.basename(root);
  return base || root;
}

function getRegisteredRoots(context) {
  const roots = context.workspaceState.get(ROOTS_STATE, []);
  const seen = new Set();
  return roots
    .map(r => typeof r === 'string' ? { path: r, name: rootDisplayName(r) } : r)
    .filter(r => r && r.path)
    .map(r => ({ path: normalize(r.path), name: r.name || rootDisplayName(r.path) }))
    .filter(r => {
      const key = process.platform === 'win32' ? r.path.toLowerCase() : r.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function setRegisteredRoots(context, roots) {
  await context.workspaceState.update(ROOTS_STATE, roots);
}

function getActiveRoot(context) {
  const active = context.workspaceState.get(ACTIVE_ROOT_STATE);
  return active ? normalize(active) : undefined;
}

async function setActiveRoot(context, root) {
  await context.workspaceState.update(ACTIVE_ROOT_STATE, root ? normalize(root) : undefined);
}

function getAppliedRoot(context) {
  const applied = context.workspaceState.get(APPLIED_ROOT_STATE);
  return applied ? normalize(applied) : undefined;
}

async function setAppliedRoot(context, root) {
  await context.workspaceState.update(APPLIED_ROOT_STATE, root ? normalize(root) : undefined);
}

function hasSettingsFile(root) {
  return !!root && (fs.existsSync(path.join(root, 'settings.gradle')) || fs.existsSync(path.join(root, 'settings.gradle.kts')));
}

async function ensureInitialRoot(context) {
  let roots = getRegisteredRoots(context);
  let active = getActiveRoot(context);

  // Migrate the original single-root cache from v0.1.x.
  if (!roots.length) {
    const detected = findCompositeRoot(workspaceRoot());
    if (detected) {
      roots = [{ path: normalize(detected), name: rootDisplayName(detected) }];
      await setRegisteredRoots(context, roots);
      active = roots[0].path;
      await setActiveRoot(context, active);

      try {
        const legacy = JSON.parse(await fsp.readFile(legacyModelPath(context), 'utf8'));
        if (legacy.modelVersion === MODEL_VERSION && normalize(legacy.compositeRoot) === active) {
          await writeCachedModel(context, active, legacy);
          log(`Migrated v0.1 cached model for ${active}.`);
        }
      } catch {}
    }
  }

  if (active && !roots.some(r => normalize(r.path) === normalize(active))) {
    active = undefined;
  }
  if (!active && roots.length) {
    active = roots[0].path;
    await setActiveRoot(context, active);
  }
  return active;
}

async function setJdtGradleImportDisabled() {
  const cfg = vscode.workspace.getConfiguration('fastCompositeJdt');
  if (!cfg.get('disableJdtGradleImport', true)) return;
  const javaCfg = vscode.workspace.getConfiguration('java');
  const current = javaCfg.get('import.gradle.enabled');
  if (current !== false) {
    await javaCfg.update('import.gradle.enabled', false, vscode.ConfigurationTarget.Workspace);
    log('Set java.import.gradle.enabled=false for this workspace.');
  }
}

async function runProcess(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const processStart = process.hrtime.bigint();
    log(`Executing: ${command} ${args.join(' ')}`);
    const child = cp.spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === 'win32'
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; output?.append(d.toString()); });
    child.stderr.on('data', d => { stderr += d; output?.append(d.toString()); });
    child.on('error', reject);
    child.on('close', code => {
      const ms = elapsedMs(processStart);
      logTiming('Gradle process', ms);
      if (code === 0) resolve({ stdout, stderr, elapsedMs: ms });
      else reject(new Error(`Gradle exited with code ${code}\n${stderr || stdout}`));
    });
  });
}

function eclipseProjectName(project, used) {
  // Use Gradle's build-tree project path as the canonical JDT name.
  // Examples:
  //   included build root :shared-model   -> shared-model
  //   included build root :platform       -> platform
  //   nested project      :services:api   -> services-api
  // This keeps the Java Projects view aligned with the task path a developer
  // would use from the composite root instead of generating build-project
  // duplicates such as shared-model-shared-model.
  let raw = project.buildTreePath || project.gradlePath || project.name || 'project';
  raw = raw.replace(/^:+/, '').replaceAll(':', '-');
  let candidate = raw.replace(/[^A-Za-z0-9_.-]/g, '-');
  if (!candidate) candidate = project.name || 'project';

  let n = candidate;
  let i = 2;
  while (used.has(n)) n = `${candidate}-${i++}`;
  used.add(n);
  return n;
}

function findSourcesJar(jarPath) {
  if (!jarPath.endsWith('.jar') || jarPath.endsWith('-sources.jar')) return undefined;
  const dir = path.dirname(jarPath);
  const name = path.basename(jarPath, '.jar') + '-sources.jar';
  const direct = path.join(dir, name);
  if (fs.existsSync(direct)) return direct;

  // Gradle module cache stores each artifact in a sibling hash directory.
  const versionDir = path.dirname(dir);
  try {
    for (const entry of fs.readdirSync(versionDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(versionDir, entry.name, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return undefined;
}

function relativeOrAbsolute(projectDir, target) {
  const rel = path.relative(projectDir, target);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return normalize(target).split(path.sep).join('/');
}

async function writeIfChanged(file, content) {
  try {
    if (await fsp.readFile(file, 'utf8') === content) return false;
  } catch {}
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  return true;
}

function buildProjectXml(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${GENERATED_MARKER}\n<projectDescription>\n\t<name>${xml(name)}</name>\n\t<comment></comment>\n\t<projects></projects>\n\t<buildSpec>\n\t\t<buildCommand>\n\t\t\t<name>org.eclipse.jdt.core.javabuilder</name>\n\t\t\t<arguments></arguments>\n\t\t</buildCommand>\n\t</buildSpec>\n\t<natures>\n\t\t<nature>org.eclipse.jdt.core.javanature</nature>\n\t</natures>\n</projectDescription>\n`;
}

function sourceEntry(projectDir, source) {
  const p = relativeOrAbsolute(projectDir, source.path);
  const out = source.output ? relativeOrAbsolute(projectDir, source.output) : undefined;
  const testAttr = source.test ? '\n\t\t<attributes><attribute name="test" value="true"/></attributes>\n\t' : '';
  if (testAttr) {
    return `\t<classpathentry kind="src" path="${xml(p)}"${out ? ` output="${xml(out)}"` : ''}>${testAttr}</classpathentry>`;
  }
  return `\t<classpathentry kind="src" path="${xml(p)}"${out ? ` output="${xml(out)}"` : ''}/>`;
}

function libEntry(projectDir, lib, attachSources) {
  const p = relativeOrAbsolute(projectDir, lib);
  const src = attachSources ? findSourcesJar(lib) : undefined;
  return `\t<classpathentry kind="lib" path="${xml(p)}"${src ? ` sourcepath="${xml(relativeOrAbsolute(projectDir, src))}"` : ''}/>`;
}

function projectEntry(name) {
  return `\t<classpathentry combineaccessrules="false" kind="src" path="/${xml(name)}"/>`;
}

function buildClasspath(project, projectByTreePath, attachSources) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', GENERATED_MARKER, '<classpath>'];

  const seenSources = new Set();
  for (const source of project.sources || []) {
    const key = normalize(source.path);
    if (seenSources.has(key) || !fs.existsSync(source.path)) continue;
    seenSources.add(key);
    lines.push(sourceEntry(project.directory, source));
  }

  const seenProjects = new Set();
  for (const dep of project.projectDependencies || []) {
    const local = projectByTreePath.get(dep.buildTreePath);
    if (!local || local.eclipseName === project.eclipseName || seenProjects.has(local.eclipseName)) continue;
    seenProjects.add(local.eclipseName);
    lines.push(projectEntry(local.eclipseName));
  }

  const localOutputs = new Set();
  for (const p of projectByTreePath.values()) {
    for (const s of p.sources || []) if (s.output) localOutputs.add(normalize(s.output));
  }

  const seenLibs = new Set();
  for (const lib of project.libraries || []) {
    if (!lib || !fs.existsSync(lib)) continue;
    const norm = normalize(lib);
    if (localOutputs.has(norm) || seenLibs.has(norm)) continue;
    seenLibs.add(norm);
    lines.push(libEntry(project.directory, norm, attachSources));
  }

  lines.push('\t<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>');
  const outputDir = project.defaultOutput || path.join(project.directory, 'build', 'fast-jdt-classes');
  lines.push(`\t<classpathentry kind="output" path="${xml(relativeOrAbsolute(project.directory, outputDir))}"/>`);
  lines.push('</classpath>', '');
  return lines.join('\n');
}

async function applyModel(model) {
  const used = new Set();
  for (const p of model.projects) p.eclipseName = eclipseProjectName(p, used);
  const byTreePath = new Map(model.projects.map(p => [p.buildTreePath, p]));
  const attachSources = vscode.workspace.getConfiguration('fastCompositeJdt').get('attachCachedSources', true);

  let changed = 0;
  for (const p of model.projects) {
    if (!fs.existsSync(p.directory)) continue;
    const projectFile = path.join(p.directory, '.project');
    const classpathFile = path.join(p.directory, '.classpath');
    const settingsFile = path.join(p.directory, '.settings', 'org.eclipse.jdt.core.prefs');

    changed += await writeIfChanged(projectFile, buildProjectXml(p.eclipseName)) ? 1 : 0;
    changed += await writeIfChanged(classpathFile, buildClasspath(p, byTreePath, attachSources)) ? 1 : 0;

    if (p.javaVersion) {
      const v = String(p.javaVersion);
      const prefs = `${GENERATED_PREFS_MARKER}\neclipse.preferences.version=1\norg.eclipse.jdt.core.compiler.codegen.targetPlatform=${v}\norg.eclipse.jdt.core.compiler.compliance=${v}\norg.eclipse.jdt.core.compiler.source=${v}\n`;
      changed += await writeIfChanged(settingsFile, prefs) ? 1 : 0;
    }
  }
  return changed;
}


async function removeOwnedGeneratedFile(file, marker) {
  try {
    const content = await fsp.readFile(file, 'utf8');
    if (!content.includes(marker)) {
      log(`Leaving non-owned metadata in place: ${file}`);
      return false;
    }
    await fsp.rm(file, { force: true });
    log(`Removed stale generated metadata: ${file}`);
    return true;
  } catch (e) {
    if (e && e.code !== 'ENOENT') log(`Could not remove stale metadata ${file}: ${e.message}`);
    return false;
  }
}

async function cleanupRemovedProjects(previousModel, nextModel) {
  if (!previousModel?.projects?.length) return 0;

  const nextDirs = new Set((nextModel?.projects || []).map(p => normalize(p.directory)));
  let changed = 0;

  for (const p of previousModel.projects) {
    const dir = normalize(p.directory);
    if (nextDirs.has(dir)) continue;

    log(`Project no longer in active composite; cleaning generated JDT metadata: ${dir}`);
    changed += await removeOwnedGeneratedFile(path.join(dir, '.project'), GENERATED_MARKER) ? 1 : 0;
    changed += await removeOwnedGeneratedFile(path.join(dir, '.classpath'), GENERATED_MARKER) ? 1 : 0;
    changed += await removeOwnedGeneratedFile(
      path.join(dir, '.settings', 'org.eclipse.jdt.core.prefs'),
      GENERATED_PREFS_MARKER
    ) ? 1 : 0;

    try {
      const settingsDir = path.join(dir, '.settings');
      if ((await fsp.readdir(settingsDir)).length === 0) await fsp.rmdir(settingsDir);
    } catch {}
  }

  return changed;
}

function projectTransition(previousModel, nextModel) {
  const previousByDir = new Map((previousModel?.projects || []).map(p => [normalize(p.directory), p]));
  const nextByDir = new Map((nextModel?.projects || []).map(p => [normalize(p.directory), p]));

  const added = [];
  const updated = [];
  const removed = [];

  for (const [dir, p] of nextByDir) {
    if (previousByDir.has(dir)) updated.push(p);
    else added.push(p);
  }
  for (const [dir, p] of previousByDir) {
    if (!nextByDir.has(dir)) removed.push(p);
  }
  return { added, updated, removed };
}

async function applyModelTransition(context, root, model, previousModelOverride) {
  let previousModel = previousModelOverride;
  if (!previousModel) {
    const appliedRoot = getAppliedRoot(context);
    if (appliedRoot) previousModel = await readCachedModel(context, appliedRoot);
  }

  const transition = projectTransition(previousModel, model);
  let changed = await cleanupRemovedProjects(previousModel, model);
  changed += await applyModel(model);
  await setAppliedRoot(context, root);
  return { changed, transition };
}

async function activateJavaExtension() {
  const javaExtension = vscode.extensions.getExtension('redhat.java');
  if (!javaExtension) {
    log('Red Hat Java extension is not installed in this extension host.');
    return false;
  }
  try {
    if (!javaExtension.isActive) {
      log('Activating Red Hat Java before project synchronization...');
      await javaExtension.activate();
    }
    return true;
  } catch (e) {
    log(`Could not activate Red Hat Java: ${e.message}`);
    return false;
  }
}

async function executeJdtCommand(command, ...args) {
  try {
    await vscode.commands.executeCommand(command, ...args);
    log(`Requested JDT synchronization via ${command}.`);
    return true;
  } catch (e) {
    log(`${command} unavailable/failed: ${e.message}`);
    return false;
  }
}

async function notifyJdtOfChanges(transition = { added: [], updated: [], removed: [] }) {
  // Keep JDT's Eclipse workspace project set aligned with the active composite.
  // JDT LS defines changeImportedProjects(toImport, toUpdate, toDelete), with file URIs.
  await activateJavaExtension();

  // JDT LS treats toImport as project *configuration file* URIs. For our
  // Eclipse-style projects that means the generated .project file, not the
  // project directory. toUpdate/toDelete, by contrast, are folder URIs.
  const toImport = (transition.added || []).map(p =>
    vscode.Uri.file(path.join(p.directory, '.project')).toString()
  );
  const toUpdate = (transition.updated || []).map(p => vscode.Uri.file(p.directory).toString());
  const toDelete = (transition.removed || []).map(p => vscode.Uri.file(p.directory).toString());

  if (toImport.length || toUpdate.length || toDelete.length) {
    log(`JDT project transition: +${toImport.length} ~${toUpdate.length} -${toDelete.length}`);
    const changed = await executeJdtCommand('java.project.changeImportedProjects', toImport, toUpdate, toDelete);
    if (!changed) {
      // Older clients may not expose changeImportedProjects; import is the safer fallback.
      await executeJdtCommand('java.project.import');
    }
  } else {
    await executeJdtCommand('java.project.import');
  }

  // changeImportedProjects is sufficient for normal add/update/remove synchronization.
  // Do not invoke java.projectConfiguration.update here: it is a user-facing command
  // that opens a project-selection picker during resync.
}

async function extractModel(context, root) {
  const extractionDir = path.join(context.globalStorageUri.fsPath, 'extract', rootKey(root));
  await fsp.rm(extractionDir, { recursive: true, force: true });
  await fsp.mkdir(extractionDir, { recursive: true });

  const initScript = path.join(context.extensionPath, 'gradle', 'fast-jdt-model.init.gradle');
  const wrapper = wrapperFor(root);
  const configuredArgs = vscode.workspace.getConfiguration('fastCompositeJdt').get('gradleArguments', ['--quiet', '--no-scan']);
  const args = ['--init-script', initScript, '__fastCompositeJdtExport', `-DfastCompositeJdt.outputDir=${extractionDir}`, ...configuredArgs];
  const gradleStart = process.hrtime.bigint();
  await runProcess(wrapper, args, root);
  const gradleMs = elapsedMs(gradleStart);

  const parseStart = process.hrtime.bigint();
  const files = (await fsp.readdir(extractionDir)).filter(f => f.endsWith('.json'));
  if (!files.length) throw new Error('Gradle completed but produced no Java project model files.');

  const builds = [];
  for (const file of files) {
    try { builds.push(JSON.parse(await fsp.readFile(path.join(extractionDir, file), 'utf8'))); }
    catch (e) { log(`Skipping invalid model ${file}: ${e.message}`); }
  }

  const projects = [];
  const seenDir = new Set();
  for (const build of builds) {
    for (const p of build.projects || []) {
      const dir = normalize(p.directory);
      if (seenDir.has(dir)) continue;
      seenDir.add(dir);
      projects.push({ ...p, directory: dir });
    }
  }

  if (!projects.length) throw new Error('No Java projects were discovered in the composite build.');
  const parseMs = elapsedMs(parseStart);
  return {
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    compositeRoot: normalize(root),
    builds: builds.map(b => ({ buildPath: b.buildPath, rootDir: b.rootDir, rootName: b.rootName })),
    projects,
    timings: { gradleMs, parseMs }
  };
}

async function resync(context, quiet = false) {
  const root = getActiveRoot(context) || await ensureInitialRoot(context);
  if (!root || !hasSettingsFile(root)) {
    if (!quiet) vscode.window.showErrorMessage('Fast Composite JDT: no active composite root. Add or switch a composite root first.');
    return;
  }

  status.text = '$(sync~spin) JDT Sync';
  status.tooltip = `Refreshing ${rootDisplayName(root)}`;
  const start = Date.now();
  try {
    const previousModel = await readCachedModel(context, root);
    const model = await extractModel(context, root);

    const metadataStart = process.hrtime.bigint();
    const { changed, transition } = await applyModelTransition(context, root, model, previousModel);
    const metadataMs = elapsedMs(metadataStart);

    const cacheStart = process.hrtime.bigint();
    await writeCachedModel(context, root, model);
    const cacheMs = elapsedMs(cacheStart);

    const jdtStart = process.hrtime.bigint();
    await notifyJdtOfChanges(transition);
    const jdtMs = elapsedMs(jdtStart);

    const ms = Date.now() - start;
    logTiming('Gradle extraction', model.timings?.gradleMs || 0);
    logTiming('Model parse / merge', model.timings?.parseMs || 0);
    logTiming('Metadata cleanup / write', metadataMs);
    logTiming('Cache write', cacheMs);
    logTiming('JDT synchronization', jdtMs);
    logTiming('Total resync', ms);
    status.text = `$(check) JDT: ${rootDisplayName(root)}`;
    status.tooltip = `${model.projects.length} projects · synced in ${(ms / 1000).toFixed(1)}s\n${root}`;
    log(`Resync complete [${rootDisplayName(root)}]: ${model.projects.length} Java projects, ${changed} metadata files changed, ${ms}ms.`);
    if (!quiet) vscode.window.showInformationMessage(`Fast Composite JDT: ${rootDisplayName(root)} · ${model.projects.length} projects synced in ${(ms / 1000).toFixed(1)}s.`);
  } catch (e) {
    status.text = '$(error) JDT Model';
    status.tooltip = String(e.message || e);
    log(`Resync failed [${root}]: ${e.stack || e}`);
    output.show(true);
    if (!quiet) vscode.window.showErrorMessage(`Fast Composite JDT resync failed: ${e.message}`);
  }
}

async function loadCached(context, root = getActiveRoot(context)) {
  if (!root) return false;
  const start = Date.now();
  const model = await readCachedModel(context, root);
  if (!model) return false;
  const { changed, transition } = await applyModelTransition(context, root, model);
  await notifyJdtOfChanges(transition);
  const ms = Date.now() - start;
  status.text = `$(check) JDT: ${rootDisplayName(root)}`;
  status.tooltip = `${model.projects.length} cached projects · loaded in ${ms}ms\n${root}`;
  log(`Loaded cached model [${rootDisplayName(root)}]: ${model.projects.length} projects in ${ms}ms; ${changed} metadata files changed. No Gradle invocation.`);
  return true;
}

async function addCompositeRoot(context) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Add Composite Root',
    title: 'Select a folder containing settings.gradle or settings.gradle.kts'
  });
  if (!picked?.length) return;
  const root = normalize(picked[0].fsPath);
  if (!hasSettingsFile(root)) {
    vscode.window.showErrorMessage('Fast Composite JDT: selected folder does not contain settings.gradle or settings.gradle.kts.');
    return;
  }

  let roots = getRegisteredRoots(context);
  const existing = roots.find(r => normalize(r.path) === root);
  if (!existing) {
    let name = rootDisplayName(root);
    const duplicateName = roots.some(r => r.name === name);
    if (duplicateName) name = `${name} (${path.dirname(root)})`;
    roots.push({ path: root, name });
    await setRegisteredRoots(context, roots);
  }

  const makeActive = await vscode.window.showQuickPick([
    { label: 'Add and switch to this root', value: true },
    { label: 'Add only', value: false }
  ], { title: `Composite root: ${root}` });
  if (makeActive?.value) {
    await switchToRoot(context, root);
  } else {
    vscode.window.showInformationMessage(`Fast Composite JDT: added ${rootDisplayName(root)}.`);
  }
}

async function switchToRoot(context, root) {
  root = normalize(root);
  if (!hasSettingsFile(root)) {
    vscode.window.showErrorMessage(`Fast Composite JDT: settings.gradle not found at ${root}.`);
    return;
  }
  await setActiveRoot(context, root);
  log(`Active composite root changed to: ${root}`);

  const cached = await loadCached(context, root);
  if (cached) {
    vscode.window.showInformationMessage(`Fast Composite JDT: switched to ${rootDisplayName(root)} from cache. No Gradle invocation.`);
    return;
  }

  status.text = `$(warning) JDT: ${rootDisplayName(root)}`;
  status.tooltip = `No cached model for ${root}. Run Resync Java Model.`;
  const choice = await vscode.window.showInformationMessage(
    `Fast Composite JDT: ${rootDisplayName(root)} has no cached Java model yet.`,
    'Resync Now'
  );
  if (choice === 'Resync Now') await resync(context, false);
}

async function switchCompositeRoot(context) {
  const roots = getRegisteredRoots(context);
  if (!roots.length) {
    await addCompositeRoot(context);
    return;
  }
  const active = getActiveRoot(context);
  const pick = await vscode.window.showQuickPick(roots.map(r => ({
    label: r.name,
    description: normalize(r.path) === normalize(active || '') ? '$(check) active' : undefined,
    detail: r.path,
    root: r.path
  })), { title: 'Switch Fast Composite JDT Root', placeHolder: 'Choose the Gradle composite configuration JDT should use' });
  if (pick) await switchToRoot(context, pick.root);
}

async function removeCompositeRoot(context) {
  const roots = getRegisteredRoots(context);
  if (!roots.length) return;
  const active = getActiveRoot(context);
  const pick = await vscode.window.showQuickPick(roots.map(r => ({
    label: r.name,
    description: normalize(r.path) === normalize(active || '') ? '$(check) active' : undefined,
    detail: r.path,
    root: r.path
  })), { title: 'Remove Fast Composite JDT Root' });
  if (!pick) return;

  const oldModel = await readCachedModel(context, pick.root);
  const remaining = roots.filter(r => normalize(r.path) !== normalize(pick.root));
  await setRegisteredRoots(context, remaining);

  if (normalize(active || '') === normalize(pick.root)) {
    const next = remaining[0]?.path;
    await setActiveRoot(context, next);
    if (next) {
      await loadCached(context, next);
    } else {
      await cleanupRemovedProjects(oldModel, { projects: [] });
      await setAppliedRoot(context, undefined);
      await notifyJdtOfChanges(projectTransition(oldModel, { projects: [] }));
      status.text = '$(circle-slash) JDT Model';
      status.tooltip = 'No composite root configured';
    }
  }
  await fsp.rm(modelPath(context, pick.root), { force: true });
  vscode.window.showInformationMessage(`Fast Composite JDT: removed ${pick.label}.`);
}

async function showStatus(context) {
  const roots = getRegisteredRoots(context);
  const active = getActiveRoot(context);
  if (!active) {
    vscode.window.showInformationMessage(`Fast Composite JDT: ${roots.length} registered roots, none active.`);
    return;
  }
  const model = await readCachedModel(context, active);
  if (!model) {
    vscode.window.showInformationMessage(`Fast Composite JDT: ${rootDisplayName(active)} is active but has no cached model. Run Resync Java Model.`);
    return;
  }
  const localDeps = model.projects.reduce((n, p) => n + (p.projectDependencies?.length || 0), 0);
  const jars = model.projects.reduce((n, p) => n + (p.libraries?.length || 0), 0);
  vscode.window.showInformationMessage(`Fast Composite JDT: ${rootDisplayName(active)} · ${model.projects.length} projects, ${localDeps} project refs, ${jars} classpath files · ${roots.length} registered roots.`);
}


function projectForActiveEditor(model) {
  const file = vscode.window.activeTextEditor?.document?.uri?.fsPath;
  if (!file) return undefined;
  const normalizedFile = normalize(file);
  return (model.projects || [])
    .filter(p => normalizedFile === normalize(p.directory) || normalizedFile.startsWith(normalize(p.directory) + path.sep))
    .sort((a, b) => normalize(b.directory).length - normalize(a.directory).length)[0];
}

function effectiveExternalLibraries(model, project) {
  const localOutputs = new Set();
  for (const p of model.projects || []) {
    for (const source of p.sources || []) {
      if (source.output) localOutputs.add(normalize(source.output));
    }
  }
  const seen = new Set();
  const result = [];
  for (const lib of project.libraries || []) {
    if (!lib) continue;
    const absolute = normalize(lib);
    if (localOutputs.has(absolute) || seen.has(absolute)) continue;
    seen.add(absolute);
    result.push(absolute);
  }
  return result;
}

function externalDependencyInfo(file) {
  const absolute = normalize(file);
  const parts = absolute.split(/[\\/]+/);
  const marker = parts.findIndex((part, i) => part === 'modules-2' && parts[i + 1] === 'files-2.1');
  if (marker >= 0 && parts.length > marker + 4) {
    const group = parts[marker + 2];
    const module = parts[marker + 3];
    const version = parts[marker + 4];
    return {
      label: `${group}:${module}:${version}`,
      coordinate: `${group}:${module}:${version}`,
      group,
      module,
      version,
      file: absolute
    };
  }
  return { label: path.basename(absolute), coordinate: undefined, file: absolute };
}

function assignEclipseNames(model) {
  const used = new Set();
  for (const p of model.projects || []) p.eclipseName = eclipseProjectName(p, used);
  return model;
}

function projectInspectorText(model, project) {
  assignEclipseNames(model);
  const byTreePath = new Map((model.projects || []).map(p => [p.buildTreePath, p]));
  const lines = [
    'FAST COMPOSITE JDT — MODEL INSPECTOR',
    '',
    `Project:          ${project.eclipseName || project.name}`,
    `Gradle project:   ${project.gradlePath || ':'}`,
    `Build path:       ${project.buildPath || ':'}`,
    `Build-tree path:  ${project.buildTreePath || project.gradlePath || ':'}`,
    `Directory:        ${project.directory}`,
    `Java version:     ${project.javaVersion || 'default JDT/JDK'}`,
    '',
    'SOURCE ROOTS'
  ];
  const sources = project.sources || [];
  if (!sources.length) lines.push('  (none)');
  for (const source of sources) {
    lines.push(`  ${source.test ? '[test] ' : '       '}${relativeOrAbsolute(project.directory, source.path)}`);
    if (source.output) lines.push(`         output → ${relativeOrAbsolute(project.directory, source.output)}`);
  }

  lines.push('', 'LOCAL PROJECT DEPENDENCIES');
  const locals = project.projectDependencies || [];
  if (!locals.length) lines.push('  (none)');
  for (const dep of locals) {
    const target = byTreePath.get(dep.buildTreePath);
    lines.push(`  ${target?.eclipseName || dep.projectName || dep.buildTreePath}`);
    lines.push('    Resolution:      LOCAL PROJECT');
    lines.push(`    Gradle path:     ${dep.projectPath || ':'}`);
    lines.push(`    Build-tree path: ${dep.buildTreePath}`);
    if (target) lines.push(`    Directory:       ${target.directory}`);
  }

  lines.push('', 'EXTERNAL COMPILE DEPENDENCIES');
  const external = effectiveExternalLibraries(model, project).map(externalDependencyInfo);
  if (!external.length) lines.push('  (none)');
  for (const dep of external) {
    lines.push(`  ${dep.label}`);
    lines.push('    Resolution: JAR');
    lines.push(`    File:       ${dep.file}`);
  }

  lines.push('', 'MODEL');
  lines.push(`  Generated: ${model.generatedAt || 'unknown'}`);
  lines.push(`  Root:      ${model.compositeRoot || 'unknown'}`);
  return lines.join('\n') + '\n';
}

async function pickModelProject(context, title) {
  const root = getActiveRoot(context);
  if (!root) {
    vscode.window.showInformationMessage('Fast Composite JDT: no active composite root.');
    return {};
  }
  const model = await readCachedModel(context, root);
  if (!model) {
    vscode.window.showInformationMessage('Fast Composite JDT: no cached model. Run Resync Java Model first.');
    return {};
  }
  assignEclipseNames(model);
  const current = projectForActiveEditor(model);
  const ordered = [...model.projects].sort((a, b) => {
    if (a === current) return -1;
    if (b === current) return 1;
    return (a.eclipseName || a.name).localeCompare(b.eclipseName || b.name);
  });
  const pick = await vscode.window.showQuickPick(ordered.map(p => ({
    label: p.eclipseName || p.name,
    description: p === current ? '$(file-code) current file' : p.gradlePath,
    detail: `${p.buildTreePath} · ${p.directory}`,
    project: p
  })), { title, placeHolder: 'Select a Java project' });
  return { model, project: pick?.project };
}

async function showInspectorDocument(content, title) {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
  log(`Opened model inspector: ${title}`);
}

async function inspectModel(context) {
  const { model, project } = await pickModelProject(context, 'Fast Composite JDT: Inspect Project Model');
  if (!model || !project) return;
  await showInspectorDocument(projectInspectorText(model, project), project.eclipseName || project.name);
}

async function inspectDependency(context) {
  const { model, project } = await pickModelProject(context, 'Fast Composite JDT: Inspect Dependency');
  if (!model || !project) return;
  assignEclipseNames(model);
  const byTreePath = new Map(model.projects.map(p => [p.buildTreePath, p]));
  const choices = [];
  for (const dep of project.projectDependencies || []) {
    const target = byTreePath.get(dep.buildTreePath);
    choices.push({
      label: target?.eclipseName || dep.projectName || dep.buildTreePath,
      description: 'LOCAL PROJECT',
      detail: dep.buildTreePath,
      kind: 'local', dep, target
    });
  }
  for (const file of effectiveExternalLibraries(model, project)) {
    const info = externalDependencyInfo(file);
    choices.push({
      label: info.label,
      description: 'JAR',
      detail: info.file,
      kind: 'jar', info
    });
  }
  const pick = await vscode.window.showQuickPick(choices, {
    title: `Dependencies · ${project.eclipseName || project.name}`,
    placeHolder: 'Select a dependency to inspect'
  });
  if (!pick) return;

  let lines;
  if (pick.kind === 'local') {
    lines = [
      'FAST COMPOSITE JDT — DEPENDENCY INSPECTOR', '',
      `From project:     ${project.eclipseName || project.name}`,
      `Dependency:       ${pick.target?.eclipseName || pick.dep.projectName || pick.dep.buildTreePath}`,
      'Resolution:       LOCAL PROJECT',
      `Gradle path:      ${pick.dep.projectPath || ':'}`,
      `Build-tree path:  ${pick.dep.buildTreePath}`,
      `Project directory:${pick.target ? ' ' + pick.target.directory : ' (not present in current model)'}`
    ];
  } else {
    lines = [
      'FAST COMPOSITE JDT — DEPENDENCY INSPECTOR', '',
      `From project: ${project.eclipseName || project.name}`,
      `Dependency:   ${pick.info.coordinate || pick.info.label}`,
      'Resolution:   JAR',
      `File:         ${pick.info.file}`
    ];
    if (pick.info.coordinate) {
      lines.splice(4, 0, `Coordinates:  ${pick.info.coordinate}`);
    }
  }
  await showInspectorDocument(lines.join('\n') + '\n', pick.label);
}

async function clearModel(context) {
  const active = getActiveRoot(context);
  if (!active) return;
  await fsp.rm(modelPath(context, active), { force: true });
  status.text = `$(warning) JDT: ${rootDisplayName(active)}`;
  status.tooltip = 'Active root has no cached model';
  vscode.window.showInformationMessage(`Fast Composite JDT: cached model cleared for ${rootDisplayName(active)}. Generated .project/.classpath files were left in place.`);
}

async function activate(context) {
  activeContext = context;
  output = vscode.window.createOutputChannel('Fast Composite JDT');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.command = 'fastCompositeJdt.switchRoot';
  status.text = '$(loading~spin) JDT Model';
  status.tooltip = 'Fast Composite JDT';
  status.show();

  context.subscriptions.push(output, status);
  context.subscriptions.push(vscode.commands.registerCommand('fastCompositeJdt.resync', () => resync(context, false)));
  context.subscriptions.push(vscode.commands.registerCommand('fastCompositeJdt.addRoot', () => addCompositeRoot(context)));
  context.subscriptions.push(vscode.commands.registerCommand('fastCompositeJdt.switchRoot', () => switchCompositeRoot(context)));
  context.subscriptions.push(vscode.commands.registerCommand('fastCompositeJdt.removeRoot', () => removeCompositeRoot(context)));
  context.subscriptions.push(vscode.commands.registerCommand('fastCompositeJdt.showStatus', () => showStatus(context)));
  context.subscriptions.push(vscode.commands.registerCommand('fastCompositeJdt.inspectModel', () => inspectModel(context)));
  context.subscriptions.push(vscode.commands.registerCommand('fastCompositeJdt.inspectDependency', () => inspectDependency(context)));
  context.subscriptions.push(vscode.commands.registerCommand('fastCompositeJdt.clearModel', () => clearModel(context)));

  await setJdtGradleImportDisabled();
  const root = await ensureInitialRoot(context);
  if (!root) {
    status.text = '$(warning) JDT Model';
    status.tooltip = 'No composite root configured';
    return;
  }

  const loaded = await loadCached(context, root);
  if (!loaded) {
    status.text = `$(warning) JDT: ${rootDisplayName(root)}`;
    status.tooltip = 'No cached model';
    if (vscode.workspace.getConfiguration('fastCompositeJdt').get('autoSyncOnFirstOpen', true)) {
      await resync(context, true);
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
