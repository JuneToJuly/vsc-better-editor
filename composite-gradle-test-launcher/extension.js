'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

let output;
let runningProcess;
let lastInvocation;
let statusItem;
let extensionContext;
let resultsViewProvider;
let executedCodePanel;
let flowReplayPanel;
let testHistory = [];
let codeLensProviderInstance;
let projectTestsProvider;
let debugEvaluatePanel;
let debugEvaluateScratchUri;
let debugEvaluateSession;
let debugEvaluateFrameId;
let debugEvaluateOutput;
let debugEvaluateResultPanel;
let debugEvaluateStoppedThreadId;
let debugEvaluateCurrentFrame;
let debugEvaluateHistory = [];
let debugEvaluateCurrentModel;
let coverageIndex = {};
const changedProductionPaths = new Set();
const changedProductionMethods = new Map();
let executedLineDecoration;
let lastPassedDecoration;
let lastFailedDecoration;
const invalidatedSourcePaths = new Set();
const latestResults = new Map();

async function activate(context) {
  extensionContext = context;
  testHistory = context.workspaceState.get('testHistory', []);
  debugEvaluateHistory = context.workspaceState.get('debugEvaluateHistory', []);
  coverageIndex = context.workspaceState.get('coverageIndex', {});
  output = vscode.window.createOutputChannel('Composite Gradle Tests');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  statusItem.command = 'compositeGradleTests.stop';
  debugEvaluateOutput = vscode.window.createOutputChannel('Composite Gradle Evaluate');
  context.subscriptions.push(output, debugEvaluateOutput, statusItem);

  register(context, 'compositeGradleTests.runMethod', () => launchFromEditor('method', false));
  register(context, 'compositeGradleTests.debugMethod', () => launchFromEditor('method', true));
  register(context, 'compositeGradleTests.runClass', () => launchFromEditor('class', false));
  register(context, 'compositeGradleTests.debugClass', () => launchFromEditor('class', true));
  register(context, 'compositeGradleTests.runMethodWithReport', () => launchFromEditor('method', false, undefined, 'report'));
  register(context, 'compositeGradleTests.runClassWithReport', () => launchFromEditor('class', false, undefined, 'report'));
  register(context, 'compositeGradleTests.runMethodWithFlow', () => launchFromEditor('method', false, undefined, 'flow'));
  register(context, 'compositeGradleTests.runClassWithFlow', () => launchFromEditor('class', false, undefined, 'flow'));
  register(context, 'compositeGradleTests.repeatLast', repeatLast);
  register(context, 'compositeGradleTests.openLastTest', openLastTest);
  register(context, 'compositeGradleTests.stop', stopCurrent);
  register(context, 'compositeGradleTests.copyLastCommand', copyLastCommand);
  register(context, 'compositeGradleTests.showResults', () => showResultsView());
  register(context, 'compositeGradleTests.showHistory', () => showResultsView());
  register(context, 'compositeGradleTests.clearHistory', clearHistory);
  register(context, 'compositeGradleTests.addTest', addTestCase);
  register(context, 'compositeGradleTests.evaluateExpression', () => showDebugEvaluateWindow());
  register(context, 'compositeGradleTests.evaluateCurrentExpression', evaluateCurrentExpression);

  resultsViewProvider = new CompositeGradleResultsViewProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'compositeGradleTests.resultsView',
    resultsViewProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  ));

  codeLensProviderInstance = new CompositeGradleCodeLensProvider();
  context.subscriptions.push(codeLensProviderInstance);
  context.subscriptions.push(vscode.languages.registerCodeLensProvider(
    { language: 'java', scheme: 'file' },
    codeLensProviderInstance
  ));
  lastPassedDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'resources', 'last-passed.svg'),
    gutterIconSize: '8px'
  });
  lastFailedDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'resources', 'last-failed.svg'),
    gutterIconSize: '8px'
  });
  executedLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });
  context.subscriptions.push(lastPassedDecoration, lastFailedDecoration, executedLineDecoration);

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    codeLensProviderInstance.refresh();
    refreshLastRunDecorations();
  }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    if (event.textEditor.document.languageId === 'java') codeLensProviderInstance.refresh();
  }));
  context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
    if (event.session.type !== 'java') return;
    if (event.event === 'stopped') {
      debugEvaluateSession = event.session;
      debugEvaluateStoppedThreadId = event.body?.threadId;
    } else if (event.event === 'continued' || event.event === 'terminated') {
      debugEvaluateStoppedThreadId = undefined;
    }
  }));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
    if (debugEvaluateSession?.id === session.id) {
      debugEvaluateSession = undefined;
      debugEvaluateFrameId = undefined;
      debugEvaluateStoppedThreadId = undefined;
      renderDebugEvaluateResult({ status: 'idle', message: 'The debug session ended.' });
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async event => {
    if (event.document.languageId === 'java') {
      const changedPath = normalizePath(event.document.uri.fsPath);
      invalidatedSourcePaths.add(changedPath);
      if (/\/src\/main\/(?:java|kotlin)\//.test(changedPath)) {
        changedProductionPaths.add(changedPath);
        await recordModifiedMethods(event);
      }
      codeLensProviderInstance.refresh();
      refreshLastRunDecorations();
      projectTestsProvider?.refreshStatuses();
    }
  }));
  refreshLastRunDecorations();
}

function register(context, command, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(command, async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[error] ${message}`);
      vscode.window.showErrorMessage(`Composite Gradle Tests: ${message}`);
    }
  }));
}

async function launchFromEditor(scope, debug, providedTarget, analysisMode = 'normal') {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'java') {
    throw new Error('Open a Java test file first.');
  }

  const target = providedTarget || await resolveTestTarget(editor.document, editor.selection.active, scope);
  if (!target) {
    throw new Error(scope === 'method'
      ? 'No test method was found at the cursor.'
      : 'No containing Java class was found.');
  }

  const invocation = await createInvocation(editor.document.uri, target, debug);
  if (analysisMode === 'report') { invocation.captureCoverage = true; invocation.captureFlow = false; invocation.analysisMode = 'report'; }
  if (analysisMode === 'flow') { invocation.captureCoverage = false; invocation.captureFlow = true; invocation.analysisMode = 'flow'; }
  if (analysisMode === 'analyze') { await executeCombinedAnalysis(invocation); return; }
  await executeInvocation(invocation);
}

async function repeatLast() {
  if (!lastInvocation) {
    throw new Error('No test has been run yet.');
  }
  await executeInvocation({ ...lastInvocation });
}

async function showNavigationDocument(document, position, resourceUri) {
  const config = vscode.workspace.getConfiguration('compositeGradleTests', resourceUri || document.uri);
  const mode = String(config.get('navigationOpenMode', 'preview'));
  const options = {
    preserveFocus: false,
    preview: mode !== 'pinned'
  };

  if (mode === 'side') {
    options.viewColumn = vscode.ViewColumn.Beside;
  } else {
    options.viewColumn = vscode.ViewColumn.One;
  }

  const editor = await vscode.window.showTextDocument(document, options);
  if (position) {
    const line = Math.max(0, Math.min(position.line, document.lineCount - 1));
    const character = Math.max(0, Math.min(position.character || 0, document.lineAt(line).text.length));
    const target = new vscode.Position(line, character);
    editor.selection = new vscode.Selection(target, target);
    editor.revealRange(document.lineAt(line).range, vscode.TextEditorRevealType.InCenter);
  }
  return editor;
}

async function openLastTest() {
  const result = testHistory[0];
  const invocation = result?.invocation || lastInvocation;
  const sourcePath = result?.sourcePath || invocation?.sourcePath;
  if (!sourcePath) {
    throw new Error('No previously run test source is available.');
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  let line = Number.isInteger(invocation?.targetLine) ? invocation.targetLine : undefined;
  let character = Number.isInteger(invocation?.targetCharacter) ? invocation.targetCharacter : 0;
  if (!Number.isInteger(line)) {
    const target = await findTargetByFilter(document, result?.filter || invocation?.filter, invocation?.scope);
    line = target?.range?.start?.line || 0;
    character = target?.range?.start?.character || 0;
  }
  const position = new vscode.Position(Math.max(0, Math.min(line, document.lineCount - 1)), Math.max(0, character));
  await showNavigationDocument(document, position, vscode.Uri.file(sourcePath));
}

async function copyLastCommand() {
  if (!lastInvocation) {
    throw new Error('No test command is available yet.');
  }
  await vscode.env.clipboard.writeText(formatCommand(lastInvocation.executable, lastInvocation.args));
  vscode.window.showInformationMessage('Copied the last Composite Gradle command.');
}

async function stopCurrent() {
  if (!runningProcess) {
    vscode.window.showInformationMessage('No Composite Gradle test is running.');
    return;
  }
  terminateProcessTree(runningProcess);
}

async function createInvocation(documentUri, target, debug) {
  const config = vscode.workspace.getConfiguration('compositeGradleTests', documentUri);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
  if (!workspaceFolder) {
    throw new Error('The test file is not inside an open workspace folder.');
  }

  const rootSetting = config.get('compositeRoot', config.get('root', '${workspaceFolder}'));
  const root = resolveCompositeRoot(rootSetting, workspaceFolder);
  const executable = resolveGradleExecutable(
    root,
    config.get('gradleExecutable', 'gradle'),
    config.get('gradleWrapper', '')
  );
  const task = resolveTask(documentUri.fsPath, root, config);
  // Make the command independent of the caller's current working directory.
  // This is especially important for copied commands run from a PowerShell prompt.
  const args = ['--project-dir', root, task, '--tests', target.filter, ...config.get('arguments', ['--console=plain'])];

  if (config.get('enhancedTestLogging', true)) {
    const initScript = ensureTestLoggingInitScript();
    args.push('--init-script', initScript);
  }

  if (debug) {
    args.push(...config.get('debugArguments', ['--debug-jvm']));
  }

  return {
    executable,
    args,
    cwd: root,
    debug,
    debugPort: config.get('debugPort', 5005),
    displayName: target.displayName,
    filter: target.filter,
    task,
    projectName: String(config.get('javaProjectName', '') || '').trim() || await resolveJavaProjectNameFromJavaExtension(documentUri.fsPath),
    showOutput: config.get('showOutput', false),
    documentUri: documentUri.toString(),
    sourcePath: documentUri.fsPath,
    scope: target.scope || (target.filter === target.classFilter ? 'class' : 'method'),
    classFilter: target.classFilter || target.filter,
    classDisplayName: target.classDisplayName || target.displayName,
    targetLine: target.range?.start?.line,
    targetCharacter: target.range?.start?.character,
    captureCoverage: config.get('captureExecutedCode', false)
  };
}


async function addTestCase() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'java') {
    throw new Error('Open a Java source or test file first.');
  }

  const sourceDocument = editor.document;
  const parsed = await parseJavaDocument(sourceDocument);
  const cursor = editor.selection.active;
  const activeClass = parsed.classes
    .filter(clazz => clazz.range.contains(cursor))
    .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0] || parsed.classes[0];
  if (!activeClass) throw new Error('No Java class was found in the current file.');

  const activeMethod = parsed.methods
    .filter(method => method.parentClass === activeClass && method.range.contains(cursor))
    .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];

  const defaultDescription = activeMethod
    ? humanizeMethodName(activeMethod.name)
    : `Tests ${humanizeTypeName(activeClass.name)}`;
  const description = await vscode.window.showInputBox({
    title: 'Add Test',
    prompt: 'Describe the test behavior. This text is used for @DisplayName.',
    value: defaultDescription,
    valueSelection: [0, defaultDescription.length],
    validateInput: value => value.trim() ? undefined : 'Enter a test description.'
  });
  if (description === undefined) return;

  const displayName = description.trim();
  const methodName = toJavaMethodName(displayName);
  if (!methodName) throw new Error('The description could not be converted into a Java method name.');

  const testUri = resolveTestFileUri(sourceDocument.uri, activeClass.name);
  let testDocument;
  try {
    testDocument = await vscode.workspace.openTextDocument(testUri);
  } catch {
    await createTestFile(testUri, parsed.packageName, activeClass.name);
    testDocument = await vscode.workspace.openTextDocument(testUri);
  }

  let text = testDocument.getText();
  if (new RegExp(`\\bvoid\\s+${escapeRegExp(methodName)}\\s*\\(`).test(text)
      || text.includes(`@DisplayName(${JSON.stringify(displayName)})`)) {
    const choice = await vscode.window.showWarningMessage(
      `A test named "${displayName}" already appears to exist.`,
      'Open Existing', 'Create Anyway'
    );
    if (!choice) return;
    if (choice === 'Open Existing') {
      const existingEditor = await vscode.window.showTextDocument(testDocument);
      const match = text.match(new RegExp(`\\b${escapeRegExp(methodName)}\\s*\\(`));
      if (match) {
        const position = testDocument.positionAt(match.index);
        existingEditor.selection = new vscode.Selection(position, position);
        existingEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
      return;
    }
  }

  await ensureJUnitImports(testDocument);
  testDocument = await vscode.workspace.openTextDocument(testUri);
  text = testDocument.getText();
  const classClose = findLastClassClosingBrace(text);
  if (classClose < 0) throw new Error('Could not find the test class closing brace.');

  const indent = detectMemberIndent(text);
  const bodyIndent = indent + detectIndentUnit(text);
  const method = [
    '',
    `${indent}@Test`,
    `${indent}@DisplayName(${JSON.stringify(displayName)})`,
    `${indent}void ${methodName}() {`,
    `${bodyIndent}// Arrange`,
    '',
    `${bodyIndent}// Act`,
    '',
    `${bodyIndent}// Assert`,
    `${indent}}`,
    ''
  ].join(testDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');

  const edit = new vscode.WorkspaceEdit();
  edit.insert(testUri, testDocument.positionAt(classClose), method);
  if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not insert the test method.');

  // Keep the developer in the source file. Format the created/updated test
  // document through the provider without opening or revealing it.
  const updated = await vscode.workspace.openTextDocument(testUri);
  const formatEdits = await vscode.commands.executeCommand(
    'vscode.executeFormatDocumentProvider',
    testUri,
    { tabSize: editor.options.tabSize || 4, insertSpaces: editor.options.insertSpaces !== false }
  );
  if (Array.isArray(formatEdits) && formatEdits.length) {
    const formatWorkspaceEdit = new vscode.WorkspaceEdit();
    formatWorkspaceEdit.set(testUri, formatEdits);
    await vscode.workspace.applyEdit(formatWorkspaceEdit);
  }
  await updated.save();
  projectTestsProvider?.refresh();
  vscode.window.showInformationMessage(`Created test: ${displayName}`);
}

function resolveTestFileUri(sourceUri, className) {
  const sourcePath = sourceUri.fsPath;
  const normalized = sourcePath.replace(/\\/g, '/');
  if (/\/src\/(test|integrationTest|functionalTest)\/java\//.test(normalized)) {
    return sourceUri;
  }
  const replaced = normalized.replace(/\/src\/main\/java\//, '/src/test/java/');
  if (replaced !== normalized) {
    const directory = path.dirname(replaced);
    return vscode.Uri.file(path.join(directory, `${className}Test.java`));
  }
  return vscode.Uri.file(path.join(path.dirname(sourcePath), `${className}Test.java`));
}

async function createTestFile(testUri, packageName, className) {
  await fs.promises.mkdir(path.dirname(testUri.fsPath), { recursive: true });
  const eol = require('os').EOL;
  const contents = [
    packageName ? `package ${packageName};` : '',
    packageName ? '' : null,
    'import org.junit.jupiter.api.DisplayName;',
    'import org.junit.jupiter.api.Test;',
    '',
    `class ${className}Test {`,
    '',
    '}',
    ''
  ].filter(line => line !== null).join(eol);
  await fs.promises.writeFile(testUri.fsPath, contents, { flag: 'wx' });
}

async function ensureJUnitImports(document) {
  let text = document.getText();
  const missing = [];
  if (!/^\s*import\s+org\.junit\.jupiter\.api\.Test\s*;/m.test(text)) missing.push('import org.junit.jupiter.api.Test;');
  if (!/^\s*import\s+org\.junit\.jupiter\.api\.DisplayName\s*;/m.test(text)) missing.push('import org.junit.jupiter.api.DisplayName;');
  if (!missing.length) return;

  const packageMatch = text.match(/^\s*package\s+[\w.]+\s*;\s*/m);
  const imports = [...text.matchAll(/^\s*import\s+[^;]+;\s*$/gm)];
  const offset = imports.length
    ? imports[imports.length - 1].index + imports[imports.length - 1][0].length
    : packageMatch ? packageMatch.index + packageMatch[0].length : 0;
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const prefix = imports.length ? eol : (packageMatch ? eol : '');
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, document.positionAt(offset), `${prefix}${missing.join(eol)}${eol}`);
  if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not add JUnit imports.');
}

function findLastClassClosingBrace(text) {
  for (let index = text.length - 1; index >= 0; index--) if (text[index] === '}') return index;
  return -1;
}

function detectMemberIndent(text) {
  const match = text.match(/\n([ \t]+)(?:@|(?:public|protected|private|static|final|void)\b)/);
  return match ? match[1] : '    ';
}

function detectIndentUnit(text) {
  return /\n\t+\S/.test(text) ? '\t' : '    ';
}

function humanizeTypeName(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function humanizeMethodName(value) {
  const words = String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'New test';
}

function toJavaMethodName(value) {
  const words = String(value).normalize('NFKD').replace(/[^A-Za-z0-9_$]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  let result = words[0].toLowerCase() + words.slice(1).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('');
  if (/^\d/.test(result)) result = `test${result}`;
  return result.replace(/[^A-Za-z0-9_$]/g, '');
}

function resolveCompositeRoot(configuredRoot, owningWorkspaceFolder) {
  const expanded = expandWorkspaceFolder(String(configuredRoot || '${workspaceFolder}'), owningWorkspaceFolder);
  const root = path.resolve(expanded);
  if (!fs.existsSync(root)) {
    throw new Error(`Composite Gradle root does not exist: ${root}`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Composite Gradle root is not a directory: ${root}`);
  }
  return root;
}

function resolveGradleExecutable(root, configuredExecutable, configuredWrapper) {
  if (configuredWrapper && configuredWrapper.trim()) {
    const candidate = path.isAbsolute(configuredWrapper)
      ? configuredWrapper
      : path.resolve(root, configuredWrapper);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Configured Gradle wrapper does not exist: ${candidate}`);
    }
    return candidate;
  }

  const value = String(configuredExecutable || 'gradle').trim();
  if (!value) return 'gradle';

  const looksLikePath = path.isAbsolute(value) || value.includes('/') || value.includes('\\');
  if (!looksLikePath) return value;

  const candidate = path.isAbsolute(value) ? value : path.resolve(root, value);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Configured Gradle executable does not exist: ${candidate}`);
  }
  return candidate;
}

function resolveTask(filePath, root, config) {
  const normalizedFile = normalizePath(path.resolve(filePath));
  const mappings = config.get('projects', []);
  let best;

  // Explicit mappings remain the highest-priority escape hatch for unusual
  // Gradle layouts, renamed projects, or custom test tasks.
  for (const mapping of mappings) {
    if (!mapping || typeof mapping.sourceRoot !== 'string' || typeof mapping.task !== 'string') continue;
    const sourceRoot = normalizePath(path.resolve(root, mapping.sourceRoot));
    if (isPathInside(normalizedFile, sourceRoot) && (!best || sourceRoot.length > best.sourceRoot.length)) {
      best = { sourceRoot, task: mapping.task };
    }
  }

  if (best) return best.task;

  if (config.get('autoDetectTask', true)) {
    const detected = resolveAutomaticCompositeTask(filePath, root, config.get('defaultTask', 'test'));
    if (detected) return detected;
  }

  return config.get('defaultTask', 'test');
}

function resolveAutomaticCompositeTask(filePath, compositeRoot, defaultTask) {
  const absoluteFile = path.resolve(filePath);
  const absoluteRoot = path.resolve(compositeRoot);
  const projectDirectory = findProjectDirectoryFromSourcePath(absoluteFile);
  if (!projectDirectory) return undefined;

  const includedBuild = findIncludedBuild(projectDirectory, absoluteRoot);
  if (!includedBuild) return undefined;

  const relativeProject = path.relative(includedBuild.root, projectDirectory);
  if (relativeProject.startsWith('..') || path.isAbsolute(relativeProject)) return undefined;

  const sourceSet = findSourceSetName(absoluteFile, projectDirectory);
  const taskName = sourceSet && sourceSet !== 'test' ? sourceSet : String(defaultTask || 'test');
  const projectParts = relativeProject === ''
    ? []
    : relativeProject.split(path.sep).filter(Boolean);

  return [includedBuild.name, ...projectParts, taskName].filter(Boolean).join(':');
}

function findProjectDirectoryFromSourcePath(filePath) {
  const parts = path.resolve(filePath).split(path.sep);
  // Use the deepest src segment so generated/nested directory names do not
  // accidentally select an outer project.
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index] === 'src' && index > 0) {
      return parts.slice(0, index).join(path.sep) || path.parse(filePath).root;
    }
  }
  return undefined;
}

function resolveJavaProjectName(filePath, task) {
  const projectDirectory = findProjectDirectoryFromSourcePath(filePath);
  if (projectDirectory) return path.basename(projectDirectory);
  const parts = String(task || '').split(':').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

function findSourceSetName(filePath, projectDirectory) {
  const relative = path.relative(projectDirectory, filePath).split(path.sep);
  const srcIndex = relative.indexOf('src');
  return srcIndex >= 0 && relative[srcIndex + 1] ? relative[srcIndex + 1] : undefined;
}

function findIncludedBuild(startDirectory, compositeRoot) {
  const project = path.resolve(startDirectory);
  const root = path.resolve(compositeRoot);

  // The root settings file is the authority for a composite build. Matching an
  // includeBuild path avoids mistaking a nested subproject/settings file for
  // the included build root (for example lib/myrootproject/mysubproject).
  const configured = readIncludedBuilds(root)
    .filter(item => isPathInside(normalizePath(project), normalizePath(item.root)))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (configured) return configured;

  // Fallback for settings files that construct includeBuild paths dynamically:
  // choose the outermost settings-bearing ancestor below the composite root.
  const candidates = [];
  let current = project;
  while (isPathInside(normalizePath(current), normalizePath(root)) && current !== root) {
    if (hasGradleSettings(current)) candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const includedRoot = candidates[candidates.length - 1];
  if (!includedRoot) return undefined;
  return {
    root: includedRoot,
    name: readGradleBuildName(includedRoot) || path.basename(includedRoot)
  };
}

function readIncludedBuilds(compositeRoot) {
  const settingsFile = ['settings.gradle', 'settings.gradle.kts']
    .map(name => path.join(compositeRoot, name))
    .find(candidate => fs.existsSync(candidate));
  if (!settingsFile) return [];
  let text;
  try { text = fs.readFileSync(settingsFile, 'utf8'); } catch (_) { return []; }

  const results = [];
  const pattern = /includeBuild\s*(?:\(\s*)?["']([^"']+)["']\s*\)?\s*(?:\{([\s\S]*?)\})?/g;
  let match;
  while ((match = pattern.exec(text))) {
    const includedRoot = path.resolve(compositeRoot, match[1]);
    const body = match[2] || '';
    const alias = body.match(/name\s*=\s*["']([^"']+)["']/)?.[1];
    results.push({
      root: includedRoot,
      name: alias || readGradleBuildName(includedRoot) || path.basename(includedRoot)
    });
  }
  return results;
}

function hasGradleSettings(directory) {
  return fs.existsSync(path.join(directory, 'settings.gradle'))
    || fs.existsSync(path.join(directory, 'settings.gradle.kts'));
}

function readGradleBuildName(buildRoot) {
  const settingsFile = ['settings.gradle', 'settings.gradle.kts']
    .map(name => path.join(buildRoot, name))
    .find(candidate => fs.existsSync(candidate));
  if (!settingsFile) return undefined;

  try {
    const text = fs.readFileSync(settingsFile, 'utf8');
    const match = text.match(/\brootProject\.name\s*=\s*["']([^"']+)["']/);
    return match ? match[1].trim() : undefined;
  } catch (_) {
    return undefined;
  }
}

function isPathInside(file, directory) {
  return file === directory || file.startsWith(`${directory}/`);
}


function refreshRuntimeInitScripts(invocation) {
  const args = Array.isArray(invocation.args) ? [...invocation.args] : [];
  const refreshed = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--init-script' && index + 1 < args.length) {
      const scriptValue = String(args[index + 1] || '');
      const basename = path.basename(scriptValue).toLowerCase();
      if (basename === 'composite-test-logging.init.gradle' || basename === 'composite-test-flow.init.gradle') {
        index += 1;
        continue;
      }
    }
    refreshed.push(arg);
  }

  const loggingEnabled = !!invocation.captureCoverage
    || refreshed.some(arg => String(arg).startsWith('-Dcgtl.coverageDir='))
    || args.some((arg, index) => arg === '--init-script'
      && path.basename(String(args[index + 1] || '')).toLowerCase() === 'composite-test-logging.init.gradle');
  if (loggingEnabled) {
    const loggingScript = ensureTestLoggingInitScript();
    if (!fs.existsSync(loggingScript)) throw new Error(`Failed to create Gradle logging init script: ${loggingScript}`);
    refreshed.push('--init-script', loggingScript);
  }

  const flowEnabled = !!invocation.captureFlow
    || refreshed.some(arg => String(arg).startsWith('-Dcgtl.flow.output='));
  if (flowEnabled) {
    const flowScript = ensureFlowInitScript();
    if (!fs.existsSync(flowScript)) throw new Error(`Failed to create Gradle flow init script: ${flowScript}`);
    refreshed.push('--init-script', flowScript);
  }

  return { ...invocation, args: refreshed };
}

async function executeInvocation(invocation) {
  // Init scripts live in VS Code global storage, which can be cleared independently
  // of saved/repeated invocations. Recreate them immediately before spawning Gradle
  // and replace any stale paths retained by Repeat Last or a copied invocation.
  invocation = refreshRuntimeInitScripts(invocation);

  if (runningProcess) {
    const choice = await vscode.window.showWarningMessage(
      'A Composite Gradle test is already running.',
      'Stop and Run New Test',
      'Cancel'
    );
    if (choice !== 'Stop and Run New Test') return;
    terminateProcessTree(runningProcess);
    await delay(250);
  }

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // Code Report and Code Flow are deliberately isolated. JaCoCo and the flow
  // agent both transform application classes and must never run together.
  if (invocation.captureFlow) {
    invocation.captureCoverage = false;
    invocation.coverageDir = undefined;
    invocation.args = (invocation.args || []).filter(arg => !String(arg).startsWith('-Dcgtl.coverageDir='));
  } else if (invocation.captureCoverage) {
    invocation.captureFlow = false;
    invocation.flowFile = undefined;
    invocation.flowDir = undefined;
    invocation.args = (invocation.args || []).filter(arg => !String(arg).startsWith('-Dcgtl.flow.'));
  }
  if (invocation.captureCoverage) {
    const coverageDir = path.join(extensionContext.globalStorageUri.fsPath, 'coverage', runId);
    fs.mkdirSync(coverageDir, { recursive: true });
    const argsWithoutOldCoverage = invocation.args.filter(arg => !String(arg).startsWith('-Dcgtl.coverageDir='));
    // -D is a global Gradle option. Keep it before the task selector; Gradle 9 may
    // otherwise interpret it as another task name (especially in copied commands).
    const taskIndex = argsWithoutOldCoverage.indexOf(invocation.task);
    const coverageArg = `-Dcgtl.coverageDir=${coverageDir}`;
    const argsWithCoverage = [...argsWithoutOldCoverage];
    argsWithCoverage.splice(taskIndex >= 0 ? taskIndex : 0, 0, coverageArg);
    invocation = { ...invocation, coverageDir, args: argsWithCoverage };
  }
  if (invocation.captureFlow) {
    const flowDir = path.join(extensionContext.globalStorageUri.fsPath, 'flow', runId);
    fs.mkdirSync(flowDir, { recursive: true });
    const flowFile = path.join(flowDir, 'flow.jsonl');
    const agentJar = path.join(extensionContext.extensionPath, 'resources', 'cgtl-flow-agent.jar');
    if (!fs.existsSync(agentJar)) throw new Error('The packaged flow agent could not be found.');
    ensureFlowInitScript();
    const flowArgs = invocation.args.filter(arg => !String(arg).startsWith('-Dcgtl.flow.'));
    const taskIndex = flowArgs.indexOf(invocation.task);
    const testPackage = String(invocation.classFilter || invocation.filter || '').split('.').slice(0, -1).join('.');
    flowArgs.splice(taskIndex >= 0 ? taskIndex : 0, 0, `-Dcgtl.flow.output=${flowFile}`, `-Dcgtl.flow.agent=${agentJar}`, `-Dcgtl.flow.packages=${testPackage}`);
    invocation = { ...invocation, flowDir, flowFile, captureFlow: true, args: flowArgs };
  }
  lastInvocation = invocation;
  output.clear();
  output.appendLine(`> ${formatCommand(invocation.executable, invocation.args)}`);
  output.appendLine(`cwd: ${invocation.cwd}`);
  output.appendLine('');
  if (invocation.showOutput) output.show(true);

  const runningResult = {
    id: runId,
    displayName: invocation.displayName,
    filter: invocation.filter,
    task: invocation.task,
    command: formatCommand(invocation.executable, invocation.args),
    cwd: invocation.cwd,
    debug: invocation.debug,
    status: 'running',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    output: '',
    sourcePath: invocation.sourcePath,
    documentUri: invocation.documentUri,
    invocation: sanitizeInvocation(invocation)
  };
  showResultsView(runningResult);

  statusItem.text = `$(sync~spin) Gradle: ${invocation.displayName}`;
  statusItem.tooltip = 'Click to stop the current Composite Gradle test';
  statusItem.show();

  const startedAt = Date.now();
  let debuggerStarted = false;
  let combinedDebugBuffer = '';
  let rawOutput = '';

  output.appendLine(`executable: ${invocation.executable}`);
  output.appendLine(`task: ${invocation.task}`);

  const spawnSpec = createSpawnSpec(invocation.executable, invocation.args);
  const child = cp.spawn(spawnSpec.command, spawnSpec.args, {
    cwd: invocation.cwd,
    env: process.env,
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32'
  });
  runningProcess = child;

  const consume = async data => {
    const text = data.toString();
    rawOutput += text;
    output.append(text);
    combinedDebugBuffer = (combinedDebugBuffer + text).slice(-8000);
    if (invocation.debug && !debuggerStarted && isDebugReady(combinedDebugBuffer, invocation.debugPort)) {
      debuggerStarted = true;
      await attachDebugger(invocation);
    }
  };

  child.stdout.on('data', consume);
  child.stderr.on('data', consume);

  child.on('error', error => {
    rawOutput += `\n[process error] ${error.message}\n`;
    output.appendLine(`\n[process error] ${error.message}`);
  });

  child.on('close', async code => {
    const durationMs = Date.now() - startedAt;
    const seconds = (durationMs / 1000).toFixed(1);
    output.appendLine(`\n[finished] Exit code ${code} after ${seconds}s`);
    if (runningProcess === child) runningProcess = undefined;
    statusItem.hide();

    const parsed = parseGradleTestOutput(rawOutput, invocation, code);
    const rawFlowEvents = invocation.flowFile ? collectFlowEvents(invocation.flowFile) : [];
    if (invocation.flowFile) {
      const flowCounts = rawFlowEvents.reduce((counts, event) => { const kind = event.event || 'unknown'; counts[kind] = (counts[kind] || 0) + 1; return counts; }, {});
      output.appendLine(`[CGTL FLOW] Captured events: enter=${flowCounts.enter || 0}, line=${flowCounts.line || 0}, exit=${flowCounts.exit || 0}`);
    }
    const flowEvents = rawFlowEvents.length ? await enrichFlowEvents(rawFlowEvents, invocation.sourcePath || runningResult?.sourcePath) : [];
    const executedCode = invocation.coverageDir
      ? await collectExecutedCode(invocation.coverageDir)
      : await executedCodeFromFlow(flowEvents, invocation.sourcePath || runningResult?.sourcePath);
    const result = {
      ...runningResult,
      status: parsed.status,
      durationMs,
      finishedAt: new Date().toISOString(),
      summary: parsed.summary,
      testOutput: parsed.testOutput,
      failure: parsed.failure,
      failures: parsed.failures,
      events: parsed.events,
      executedCode,
      flowEvents,
      flowCaptured: !!invocation.flowFile,
      coverageCaptured: !!invocation.coverageDir,
      analysisMode: invocation.captureFlow ? 'flow' : (invocation.coverageDir ? 'report' : 'normal'),
      output: rawOutput,
      exitCode: code
    };

    if (!invocation._suppressRecord) {
      await recordResult(result);
      if (result.coverageCaptured && executedCode.length) await updateCoverageIndex(result);
      showResultsView(result);
      latestResults.set(invocation.filter, result);
    }
    if (typeof invocation._onComplete === 'function') invocation._onComplete(result);

    if (parsed.status === 'passed') {
      vscode.window.setStatusBarMessage(`$(testing-passed-icon) ${invocation.displayName} passed (${seconds}s)`, 5000);
    } else if (parsed.status === 'failed') {
      vscode.window.setStatusBarMessage(`$(testing-failed-icon) ${invocation.displayName} failed (${seconds}s)`, 8000);
    } else if (code !== null) {
      vscode.window.showErrorMessage(`${invocation.displayName} could not be completed. See test results.`);
    }
  });
}


function sanitizeInvocation(invocation) {
  const copy = { ...invocation, args: [...(invocation.args || [])] };
  delete copy._onComplete;
  delete copy._suppressRecord;
  return copy;
}

function executeInvocationAndWait(invocation) {
  return new Promise((resolve, reject) => {
    executeInvocation({ ...invocation, _suppressRecord: true, _onComplete: resolve }).catch(reject);
  });
}

async function createAnalysisFingerprint(invocation) {
  const files = await vscode.workspace.findFiles('**/src/{main,test}/{java,kotlin}/**/*.{java,kt}', '**/{build,bin,.gradle,node_modules,out}/**', 2000);
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(String(invocation.task || ''));
  hash.update(String(invocation.filter || ''));
  for (const uri of files.sort((a,b)=>a.fsPath.localeCompare(b.fsPath))) {
    try {
      const stat = fs.statSync(uri.fsPath);
      hash.update(normalizePath(uri.fsPath));
      hash.update(String(stat.size));
      hash.update(String(stat.mtimeMs));
    } catch (_) {}
  }
  return hash.digest('hex');
}

async function executeCombinedAnalysis(baseInvocation) {
  const fingerprintBefore = await createAnalysisFingerprint(baseInvocation);
  vscode.window.setStatusBarMessage('$(sync~spin) Composite Gradle: generating code report…');
  const reportInvocation = { ...baseInvocation, captureCoverage: true, captureFlow: false, analysisMode: 'report' };
  const report = await executeInvocationAndWait(reportInvocation);
  if (report.status !== 'passed') {
    await recordResult(report); showResultsView(report); return;
  }
  const fingerprintMiddle = await createAnalysisFingerprint(baseInvocation);
  if (fingerprintMiddle !== fingerprintBefore) throw new Error('Source files changed during Code Report. Run Analyze again.');
  vscode.window.setStatusBarMessage('$(sync~spin) Composite Gradle: capturing code flow…');
  const flowInvocation = { ...baseInvocation, captureCoverage: false, captureFlow: true, analysisMode: 'flow' };
  const flow = await executeInvocationAndWait(flowInvocation);
  const fingerprintAfter = await createAnalysisFingerprint(baseInvocation);
  if (fingerprintAfter !== fingerprintBefore) throw new Error('Source files changed during Code Flow. Run Analyze again.');
  const combined = {
    ...flow,
    id: `${Date.now()}-analysis-${Math.random().toString(16).slice(2)}`,
    displayName: flow.displayName || report.displayName,
    status: flow.status === 'passed' && report.status === 'passed' ? 'passed' : (flow.status === 'failed' || report.status === 'failed' ? 'failed' : flow.status),
    durationMs: Number(report.durationMs || 0) + Number(flow.durationMs || 0),
    startedAt: report.startedAt,
    finishedAt: flow.finishedAt,
    executedCode: report.executedCode || [],
    flowEvents: flow.flowEvents || [],
    coverageCaptured: true,
    flowCaptured: true,
    analysisMode: 'analyze',
    analysisFingerprint: fingerprintBefore,
    reportRunId: report.id,
    flowRunId: flow.id,
    output: `[CODE REPORT]\n${report.output || ''}\n\n[CODE FLOW]\n${flow.output || ''}`,
    command: `${report.command}\n${flow.command}`,
    invocation: sanitizeInvocation(baseInvocation)
  };
  await recordResult(combined);
  if (combined.executedCode.length) await updateCoverageIndex(combined);
  latestResults.set(combined.filter, combined);
  showResultsView(combined);
  vscode.window.setStatusBarMessage(`$(check) Analysis complete: ${combined.displayName}`, 5000);
}

function dependencyResolutionSettings() {
  const config = vscode.workspace.getConfiguration('compositeGradleTests');
  return {
    byteBuddyVersion: String(config.get('byteBuddyVersion', '1.18.7') || '1.18.7').trim(),
    jacocoVersion: String(config.get('jacocoVersion', '0.8.14') || '0.8.14').trim(),
    repository: String(config.get('dependencyRepository', '') || '').trim()
  };
}

function gradleString(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function ensureTestLoggingInitScript() {
  const dependencySettings = dependencyResolutionSettings();
  if (!extensionContext) throw new Error('Extension context is unavailable.');
  const directory = extensionContext.globalStorageUri.fsPath;
  fs.mkdirSync(directory, { recursive: true });
  const scriptPath = path.join(directory, 'composite-test-logging.init.gradle');
  const contents = `
def cgtlCoverageDir = System.getProperty("cgtl.coverageDir")
def cgtlJacocoVersion = ${gradleString(dependencySettings.jacocoVersion)}
def cgtlDependencyRepository = ${gradleString(dependencySettings.repository)}
allprojects { project ->
    def cgtlReportProvider = null

    if (cgtlCoverageDir) {
        // Plugin application and report-task registration must happen in the
        // normal project configuration context. Gradle forbids creating tasks
        // while a TaskCollection.configureEach callback is being executed.
        if (cgtlDependencyRepository) {
            project.repositories.maven { repository ->
                repository.url = project.uri(cgtlDependencyRepository)
            }
        }
        project.pluginManager.apply("jacoco")
        def jacocoPluginExtension = project.extensions.findByName("jacoco")
        if (jacocoPluginExtension != null) {
            jacocoPluginExtension.toolVersion = cgtlJacocoVersion
        }

        def reportClass = Class.forName(
            "org.gradle.testing.jacoco.tasks.JacocoReport",
            true,
            project.plugins.findPlugin("jacoco").class.classLoader
        )
        cgtlReportProvider = project.tasks.register("cgtlJacocoReport", reportClass) { reportTask ->
            def reportSafeProject = project.path.replaceAll("[^A-Za-z0-9_-]", "_")
            def reportCoverageDir = System.getProperty("cgtl.coverageDir")
            def projectExecutionDir = project.file("\${reportCoverageDir}/\${reportSafeProject}")
            reportTask.group = "verification"
            reportTask.description = "Generates Composite Gradle Test Launcher execution data."

            // Do not pass a Test task collection to executionData. JacocoReport
            // traverses that collection with TaskCollection.all(), which Gradle 9
            // forbids while the report task itself is being realized as a finalizer.
            // Reading the known per-project .exec directory is configuration-safe.
            reportTask.executionData.from(project.fileTree(projectExecutionDir) {
                include "*.exec"
            })

            // Resolve source sets lazily so this also works when the Java plugin
            // is applied after this initialization script configures the project.
            reportTask.sourceDirectories.from(project.provider {
                def sourceSets = project.extensions.findByName("sourceSets")
                def mainSourceSet = sourceSets == null ? null : sourceSets.findByName("main")
                return mainSourceSet == null ? [] : mainSourceSet.allSource.srcDirs
            })
            reportTask.classDirectories.from(project.provider {
                def sourceSets = project.extensions.findByName("sourceSets")
                def mainSourceSet = sourceSets == null ? null : sourceSets.findByName("main")
                return mainSourceSet == null ? [] : mainSourceSet.output
            })

            reportTask.reports {
                xml.required.set(true)
                xml.outputLocation.set(project.file("\${reportCoverageDir}/\${reportSafeProject}.xml"))
                html.required.set(false)
                csv.required.set(false)
            }
            reportTask.onlyIf { reportTask.executionData.files.any { it.exists() } }
        }
    }

    tasks.withType(org.gradle.api.tasks.testing.Test).configureEach { testTask ->
        testLogging {
            events "passed", "failed", "skipped", "standardOut", "standardError"
            showStandardStreams = true
            exceptionFormat = "full"
            showExceptions = true
            showCauses = true
            showStackTraces = true
        }

        if (cgtlCoverageDir) {
            def taskCoverageDir = System.getProperty("cgtl.coverageDir")
            def taskSafeProject = project.path.replaceAll("[^A-Za-z0-9_-]", "_")
            def safeTask = testTask.path.replaceAll("[^A-Za-z0-9_-]", "_")
            def jacocoExtension = testTask.extensions.findByName("jacoco")
            if (jacocoExtension != null) {
                jacocoExtension.destinationFile = project.file("\${taskCoverageDir}/\${taskSafeProject}/\${safeTask}.exec")
            }
            testTask.finalizedBy(cgtlReportProvider)
        }
    }
}
`;
  if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf8') !== contents) {
    fs.writeFileSync(scriptPath, contents, 'utf8');
  }
  return scriptPath;
}


function ensureFlowInitScript() {
  const dependencySettings = dependencyResolutionSettings();
  const directory = extensionContext.globalStorageUri.fsPath;
  fs.mkdirSync(directory, { recursive: true });
  const scriptPath = path.join(directory, 'composite-test-flow.init.gradle');
  const contents = `
initscript {
    repositories {
        ${dependencySettings.repository ? `maven { url = uri(${gradleString(dependencySettings.repository)}) }` : 'mavenCentral()'}
    }
    dependencies { classpath "net.bytebuddy:byte-buddy:${dependencySettings.byteBuddyVersion}" }
}
def cgtlFlowOutput = System.getProperty("cgtl.flow.output")
def cgtlFlowAgent = System.getProperty("cgtl.flow.agent")
def cgtlFlowPackages = System.getProperty("cgtl.flow.packages", "")
def cgtlByteBuddyJar = new File(net.bytebuddy.ByteBuddy.protectionDomain.codeSource.location.toURI()).absolutePath
allprojects { project ->
    tasks.withType(org.gradle.api.tasks.testing.Test).configureEach { testTask ->
        if (cgtlFlowOutput && cgtlFlowAgent) {
            testTask.maxParallelForks = 1
            testTask.jvmArgs("-javaagent:" + cgtlFlowAgent)
            testTask.jvmArgs("-Xbootclasspath/a:" + cgtlByteBuddyJar)
            testTask.systemProperty("cgtl.flow.output", cgtlFlowOutput)
            testTask.systemProperty("cgtl.flow.maxEvents", "20000")
            testTask.systemProperty("cgtl.flow.packages", cgtlFlowPackages)
            testTask.systemProperty("cgtl.flow.byteBuddyJar", cgtlByteBuddyJar)
        }
    }
}
`;
  if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf8') !== contents) fs.writeFileSync(scriptPath, contents, 'utf8');
  return scriptPath;
}

function collectFlowEvents(flowFile) {
  if (!flowFile || !fs.existsSync(flowFile)) return [];
  try {
    return fs.readFileSync(flowFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (_) { return undefined; }
    }).filter(Boolean).sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  } catch (_) { return []; }
}


async function resolveFlowSource(className, preferredSourcePath) {
  const topLevelClass = String(className || '').split('$')[0];
  if (!topLevelClass) return undefined;
  const relativeJava = `${topLevelClass.replace(/\./g, '/')}.java`;
  const relativeKotlin = `${topLevelClass.replace(/\./g, '/')}.kt`;
  const exclude = '**/{build,bin,.gradle,node_modules,out,target}/**';
  const candidates = [
    ...await vscode.workspace.findFiles(`**/src/main/java/${relativeJava}`, exclude, 100),
    ...await vscode.workspace.findFiles(`**/src/main/kotlin/${relativeKotlin}`, exclude, 100),
    ...await vscode.workspace.findFiles(`**/src/test/java/${relativeJava}`, exclude, 100),
    ...await vscode.workspace.findFiles(`**/src/test/kotlin/${relativeKotlin}`, exclude, 100)
  ];
  if (!candidates.length) return undefined;

  const preferredProject = preferredSourcePath ? findProjectDirectoryFromSourcePath(preferredSourcePath) : undefined;
  const preferredWorkspace = preferredSourcePath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(preferredSourcePath))?.uri.fsPath : undefined;
  const normalizedProject = preferredProject ? normalizePath(preferredProject) : '';
  const normalizedWorkspace = preferredWorkspace ? normalizePath(preferredWorkspace) : '';

  candidates.sort((a, b) => {
    const score = uri => {
      const file = normalizePath(uri.fsPath);
      let value = 0;
      if (normalizedProject && (file === normalizedProject || file.startsWith(`${normalizedProject}/`))) value += 1000;
      if (normalizedWorkspace && (file === normalizedWorkspace || file.startsWith(`${normalizedWorkspace}/`))) value += 100;
      if (file.endsWith(`/src/main/java/${relativeJava}`) || file.endsWith(`/src/main/kotlin/${relativeKotlin}`)) value += 10;
      if (file.endsWith(`/src/test/java/${relativeJava}`) || file.endsWith(`/src/test/kotlin/${relativeKotlin}`)) value += 8;
      return value;
    };
    return score(b) - score(a) || a.fsPath.localeCompare(b.fsPath);
  });
  return candidates[0];
}

async function enrichFlowEvents(events, preferredSourcePath) {
  const classCache = new Map();
  const methodCache = new Map();
  const enriched = [];
  for (const event of events || []) {
    if (!event.className || !event.methodName) { enriched.push(event); continue; }
    const topLevelClass = String(event.className).split('$')[0];
    let uri = classCache.get(topLevelClass);
    if (uri === undefined) {
      uri = await resolveFlowSource(topLevelClass, preferredSourcePath) || null;
      classCache.set(topLevelClass, uri);
    }
    if (!uri) { enriched.push(event); continue; }

    const methodKey = `${topLevelClass}#${event.methodName}`;
    let info = methodCache.get(methodKey);
    if (info === undefined) {
      info = null;
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const parsed = await parseJavaDocument(document);
        const method = parsed.methods.find(item => item.name === event.methodName);
        if (method) {
          info = {
            sourcePath: uri.fsPath,
            sourceFile: path.basename(uri.fsPath),
            line: method.range.start.line + 1,
            endLine: method.range.end.line + 1
          };
        } else {
          info = { sourcePath: uri.fsPath, sourceFile: path.basename(uri.fsPath) };
        }
      } catch (_) {}
      methodCache.set(methodKey, info);
    }
    if (!info) { enriched.push(event); continue; }
    if (event.event === 'line') {
      enriched.push({
        ...event,
        sourcePath: info.sourcePath,
        sourceFile: event.sourceFile || info.sourceFile,
        endLine: info.endLine,
        locationKind: 'executed-line'
      });
    } else {
      enriched.push({ ...event, ...info, locationKind: event.event === 'exit' ? 'method-exit' : 'method-entry' });
    }
  }
  // Resolve the exact caller source independently from the callee source. The
  // agent captures the JVM caller frame at method entry, including its line.
  // Keeping both paths on the event lets replay show call-site and resume steps
  // even when projects contain duplicate source filenames.
  const callerClassCache = new Map();
  for (const event of enriched) {
    if (!event.callerClassName || Number(event.callerLine || 0) <= 0) continue;
    const callerTopLevel = String(event.callerClassName).split('$')[0];
    let callerUri = callerClassCache.get(callerTopLevel);
    if (callerUri === undefined) {
      callerUri = await resolveFlowSource(callerTopLevel, preferredSourcePath) || null;
      callerClassCache.set(callerTopLevel, callerUri);
    }
    if (callerUri) {
      event.callerSourcePath = callerUri.fsPath;
      event.callerSourceFile = event.callerSourceFile || path.basename(callerUri.fsPath);
    }
  }
  return enriched;
}

async function executedCodeFromFlow(events, preferredSourcePath) {
  const byFile = new Map();
  const sourceCache = new Map();
  for (const event of events || []) {
    if (event.event !== 'line' || !event.line || !event.className) continue;
    const topLevelClass = String(event.className).split('$')[0];
    let uri = sourceCache.get(topLevelClass);
    if (uri === undefined) {
      uri = event.sourcePath ? vscode.Uri.file(event.sourcePath) : (await resolveFlowSource(topLevelClass, preferredSourcePath) || null);
      sourceCache.set(topLevelClass, uri);
    }
    const sourcePath = uri?.fsPath;
    const simple = topLevelClass.split('.').pop();
    const key = sourcePath || `${topLevelClass.replace(/\./g, '/')}.java`;
    const item = byFile.get(key) || { sourcePath, relativePath: event.sourceFile || `${simple}.java`, lines: new Set() };
    item.lines.add(Number(event.line));
    byFile.set(key, item);
  }
  return [...byFile.values()].map(item => ({ ...item, lines: [...item.lines].sort((a,b)=>a-b) }));
}

function showFlowReplayPanel(result) {
  const lines = (result?.flowEvents || []).filter(event => event.event === 'line');
  const methods = (result?.flowEvents || []).filter(event => event.event === 'enter');
  if (!lines.length && !methods.length) {
    vscode.window.showInformationMessage('No ordered flow events were captured for this run.');
    return;
  }
  if (!flowReplayPanel) {
    flowReplayPanel = vscode.window.createWebviewPanel('compositeGradleTests.flowReplay', 'Test Flow', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    flowReplayPanel.onDidDispose(() => { flowReplayPanel = undefined; });
    flowReplayPanel.webview.onDidReceiveMessage(async message => {
      if (message.command !== 'openLine' && message.command !== 'openMethod') return;
      let uri;
      if (message.sourcePath && fs.existsSync(message.sourcePath)) uri = vscode.Uri.file(message.sourcePath);
      if (!uri) uri = await resolveFlowSource(message.className, result?.sourcePath);
      if (!uri) return;
      const document = await vscode.workspace.openTextDocument(uri);
      if (message.command === 'openLine') {
        const line = Math.max(0, Number(message.line || 1) - 1);
        await showNavigationDocument(document, new vscode.Position(line, 0), uri);
      } else {
        const parsed = await parseJavaDocument(document);
        const method = parsed.methods.find(item => item.name === message.methodName);
        await showNavigationDocument(document, method?.range?.start || new vscode.Position(0, 0), uri);
      }
    });
  }
  flowReplayPanel.title = `Execution Replay — ${result.displayName || 'Test'}`;
  flowReplayPanel.webview.html = renderFlowReplayHtml(result);
  flowReplayPanel.reveal(vscode.ViewColumn.Beside, false);
}

function renderFlowReplayHtml(result) {
  const allEvents = (result.flowEvents || []);
  const lineEntries = allEvents.filter(event => event.event === 'line');
  const methodEntries = allEvents.filter(event => event.event === 'enter');
  const rawEntries = allEvents.filter(event => event.event === 'enter' || event.event === 'line' || event.event === 'exit');
  const lineMode = lineEntries.length > 0;

  // Expand each method call into an explicit call-site -> callee -> return ->
  // resume sequence. The caller line comes from the live JVM stack frame
  // captured by the agent, not from filename or source-text guessing.
  const entries = [];
  for (const event of rawEntries) {
    const hasCaller = event.callerClassName && Number(event.callerLine || 0) > 0 && event.callerSourcePath;
    if (event.event === 'enter' && hasCaller) {
      entries.push({
        ...event,
        event: 'callsite',
        sequence: Number(event.sequence || 0) - 0.2,
        className: event.callerClassName,
        methodName: event.callerMethodName,
        sourceFile: event.callerSourceFile,
        sourcePath: event.callerSourcePath,
        line: Number(event.callerLine),
        depth: Math.max(0, Number(event.depth || 0)),
        calleeClassName: event.className,
        calleeMethodName: event.methodName,
        // A call-site step represents the exact pre-invocation boundary. Keep
        // the callee receiver and arguments captured by method-entry advice so
        // the replay can inspect the target object before it is modified.
        targetReceiver: event.receiver,
        callerReceiver: event.callerReceiver,
        callerArguments: event.callerArguments,
        receiver: event.receiver,
        arguments: event.arguments,
        __synthetic: true
      });
    }
    entries.push(event);
    if (event.event === 'exit' && hasCaller) {
      entries.push({
        ...event,
        event: 'resume',
        sequence: Number(event.sequence || 0) + 0.2,
        className: event.callerClassName,
        methodName: event.callerMethodName,
        sourceFile: event.callerSourceFile,
        sourcePath: event.callerSourcePath,
        line: Number(event.callerLine),
        depth: Math.max(0, Number(event.depth || 0)),
        calleeClassName: event.className,
        calleeMethodName: event.methodName,
        receiverAfter: event.receiverAfter,
        __synthetic: true
      });
    }
  }

  // Pair entry and exit snapshots by the call id emitted by the agent. This lets
  // an entry step show the eventual return value while preserving the ordered
  // exit event in the timeline. Fall back to a per-thread call stack for older
  // traces that did not include callId.
  const entryByCallId = new Map();
  const exitByCallId = new Map();
  const openCallsByThread = new Map();
  for (const event of entries) {
    const callId = event.callId ?? event.call ?? event.invocationId;
    const threadKey = String(event.thread ?? event.threadId ?? 'main');
    if (event.event === 'enter') {
      if (callId !== undefined && callId !== null) entryByCallId.set(String(callId), event);
      const stack = openCallsByThread.get(threadKey) || [];
      stack.push(event);
      openCallsByThread.set(threadKey, stack);
    } else if (event.event === 'exit') {
      let entry;
      if (callId !== undefined && callId !== null) {
        exitByCallId.set(String(callId), event);
        entry = entryByCallId.get(String(callId));
      }
      const stack = openCallsByThread.get(threadKey) || [];
      if (!entry && stack.length) entry = stack[stack.length - 1];
      if (entry) {
        entry.__outcome = { returnValue: event.returnValue, thrown: event.thrown, receiverAfter: event.receiverAfter, exitSequence: event.sequence };
        event.__entrySnapshot = { receiver: entry.receiver, arguments: entry.arguments };
        const index = stack.lastIndexOf(entry);
        if (index >= 0) stack.splice(index, 1);
      }
    }
  }
  for (const [callId, exit] of exitByCallId) {
    const entry = entryByCallId.get(callId);
    if (entry && !entry.__outcome) {
      entry.__outcome = { returnValue: exit.returnValue, thrown: exit.thrown, receiverAfter: exit.receiverAfter, exitSequence: exit.sequence };
      exit.__entrySnapshot = { receiver: entry.receiver, arguments: entry.arguments };
    }
  }
  for (const event of entries) {
    if (event.event !== 'resume') continue;
    const callId = event.callId ?? event.call ?? event.invocationId;
    if (callId === undefined || callId === null) continue;
    const entry = entryByCallId.get(String(callId));
    const exit = exitByCallId.get(String(callId));
    if (entry) event.__entrySnapshot = { receiver: entry.receiver, arguments: entry.arguments };
    if (exit) {
      event.receiverAfter = exit.receiverAfter;
      event.returnValue = exit.returnValue;
      event.thrown = exit.thrown;
    }
  }

  const coverageByPath = new Map((result.executedCode || []).map(file => [normalizePath(file.sourcePath || file.relativePath || ''), new Set(file.lines || [])]));
  const enrichedEntries = entries.map(event => {
    const sourcePath = event.sourcePath;
    const coveredLines = coverageByPath.get(normalizePath(sourcePath || '')) || new Set();
    const targetLine = Math.max(1, Number(event.line || 1));
    let sourcePreview = [];
    if (sourcePath && fs.existsSync(sourcePath)) {
      try {
        const sourceLines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
        const startLine = Math.max(1, targetLine - 5);
        const endLine = Math.min(sourceLines.length, Math.max(targetLine + 7, Number(event.endLine || targetLine + 4)));
        sourcePreview = sourceLines.slice(startLine - 1, endLine).map((text, offset) => ({
          line: startLine + offset,
          text,
          active: startLine + offset === targetLine,
          covered: coveredLines.has(startLine + offset)
        }));
      } catch (_) {}
    }
    return { ...event, sourcePreview };
  });
  const data = JSON.stringify(enrichedEntries).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="UTF-8"><style>
  *{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);overflow:hidden}.shell{height:100vh;display:grid;grid-template-columns:minmax(260px,320px) 1fr}.timeline{border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);overflow:auto}.head{position:sticky;top:0;background:var(--vscode-sideBar-background);padding:14px 14px 12px;border-bottom:1px solid var(--vscode-panel-border);z-index:2}.head strong{font-size:13px;letter-spacing:.02em}.head small{display:block;color:var(--vscode-descriptionForeground);margin-top:4px;line-height:1.35}.step{width:100%;border:0;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 70%,transparent);background:transparent;color:inherit;text-align:left;padding:10px 12px;display:grid;grid-template-columns:28px 1fr;cursor:pointer;position:relative}.step:hover{background:var(--vscode-list-hoverBackground)}.step.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.step.active:before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--vscode-focusBorder)}.seq{color:var(--vscode-textLink-foreground);font-variant-numeric:tabular-nums;padding-top:1px}.where{font-family:var(--vscode-editor-font-family);font-size:12px;min-width:0}.where b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.where small{display:block;opacity:.68;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.viewer{display:flex;flex-direction:column;min-width:0;overflow:hidden}.toolbar{display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground)}button{font:inherit}.toolbar button{border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:5px 11px;cursor:pointer}.toolbar button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.toolbar button:disabled{opacity:.45;cursor:default}.position{margin-left:auto;color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums}.progress{height:2px;background:var(--vscode-panel-border)}.progress>span{display:block;height:100%;background:var(--vscode-progressBar-background);transition:width .12s ease}.content{padding:18px 22px 28px;overflow:auto}.current-head{display:flex;align-items:flex-start;gap:18px;margin-bottom:16px}.identity{min-width:0}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px}.identity h1{font:600 19px/1.25 var(--vscode-editor-font-family);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.identity p{font:12px/1.4 var(--vscode-editor-font-family);color:var(--vscode-descriptionForeground);margin:5px 0 0}.meta{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.pill{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:4px 8px;font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}.code-card{border:1px solid var(--vscode-panel-border);background:var(--vscode-textCodeBlock-background);border-radius:4px;overflow:hidden}.code-title{display:flex;align-items:center;padding:9px 12px;border-bottom:1px solid var(--vscode-panel-border);font-size:11px;color:var(--vscode-descriptionForeground)}.code-title strong{color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:12px}.code-title span{margin-left:auto}.code{font:13px/1.65 var(--vscode-editor-font-family);padding:6px 0;overflow:auto}.line{display:grid;grid-template-columns:56px 1fr;min-height:22px}.line .num{text-align:right;padding-right:14px;color:var(--vscode-editorLineNumber-foreground);user-select:none}.line .text{white-space:pre;padding-right:18px}.line.covered{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 9%,transparent)}.line.covered .num{color:var(--vscode-testing-iconPassed);font-weight:700}.line.active{background:var(--vscode-editor-lineHighlightBackground);box-shadow:inset 3px 0 0 var(--vscode-focusBorder)}.line.active .num{color:var(--vscode-editorLineNumber-activeForeground);font-weight:700}.line.active .text{font-weight:600}.state-card{margin-top:14px;border:1px solid var(--vscode-panel-border);border-radius:4px;overflow:hidden}.state-title{padding:9px 12px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px;font-weight:600}.state-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1px;background:var(--vscode-panel-border)}.state-section{background:var(--vscode-editor-background);padding:12px;min-height:90px}.state-section h3{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin:0 0 9px}.state-row{font:12px/1.45 var(--vscode-editor-font-family);display:grid;grid-template-columns:minmax(80px,auto) 1fr;gap:10px;padding:3px 0}.state-key{color:var(--vscode-symbolIcon-fieldForeground,var(--vscode-textLink-foreground));overflow:hidden;text-overflow:ellipsis}.state-value{white-space:pre-wrap;word-break:break-word}.state-type{display:block;color:var(--vscode-descriptionForeground);font-size:10px}.state-empty{color:var(--vscode-descriptionForeground);font-size:12px}.empty{border:1px dashed var(--vscode-panel-border);padding:28px;text-align:center;color:var(--vscode-descriptionForeground)}.hint{margin-top:12px;color:var(--vscode-descriptionForeground);font-size:11px}.hint kbd{border:1px solid var(--vscode-panel-border);border-radius:3px;padding:1px 5px;background:var(--vscode-keybindingLabel-background)}
  </style></head><body><div class="shell"><aside class="timeline"><div class="head"><strong>${lineMode ? 'Execution replay' : 'Method call timeline'}</strong><small>${entries.length} replay steps · call sites, method boundaries, and returns preserved</small></div><div id="steps"></div></aside><main class="viewer"><div class="toolbar"><button id="prev">← Previous</button><button class="primary" id="next">Next →</button><button id="open">Open source</button><span class="position" id="position"></span></div><div class="progress"><span id="progress"></span></div><div class="content"><div class="current-head"><div class="identity"><div class="eyebrow" id="kind"></div><h1 id="method"></h1><p id="file"></p></div><div class="meta"><span class="pill" id="depth"></span><span class="pill" id="thread"></span></div></div><div class="code-card" id="codeCard"><div class="code-title"><strong id="codeFile"></strong><span id="codeLine"></span></div><div class="code" id="code"></div></div><div class="empty" id="empty">Source preview is unavailable for this event. Use Open source to navigate to the nearest method location.</div><div class="state-card"><div class="state-title" id="stateTitle">Frame snapshot</div><div class="state-grid"><section class="state-section"><h3 id="receiverHeading">This</h3><div id="receiver"></div></section><section class="state-section"><h3>Arguments</h3><div id="arguments"></div></section><section class="state-section"><h3>Outcome</h3><div id="outcome"></div></section></div></div><div class="hint"><kbd>j</kbd>/<kbd>k</kbd> or arrow keys move through execution. <kbd>Enter</kbd> opens the current source location.</div></div></main></div><script>
  const vscode=acquireVsCodeApi(),events=${data},lineMode=${lineMode};let index=0;const steps=document.getElementById('steps');
  const simpleName=e=>String(e.className||'').split('.').pop();
  const eventLabel=e=>e.event==='line'?'Line '+e.line:(e.event==='exit'?'Return':'Enter');
  const eventSymbol=e=>e.event==='line'?'•':(e.event==='exit'?'↩':'▶');
  events.forEach((e,i)=>{const b=document.createElement('button');b.className='step '+String(e.event||'');const loc=e.line?((e.sourceFile||simpleName(e)+'.java')+':'+e.line):eventLabel(e);const indent=Math.min(10,Number(e.depth||0))*12;b.innerHTML='<span class="seq">'+eventSymbol(e)+'</span><span class="where" style="padding-left:'+indent+'px"><b>'+simpleName(e)+'.'+e.methodName+'()</b><small>'+loc+'</small></span>';b.onclick=()=>{index=i;render()};steps.appendChild(b)});
  function renderCode(e){const code=document.getElementById('code'),card=document.getElementById('codeCard'),empty=document.getElementById('empty');code.innerHTML='';if(!e.sourcePreview||!e.sourcePreview.length){card.style.display='none';empty.style.display='block';return}card.style.display='block';empty.style.display='none';document.getElementById('codeFile').textContent=e.sourceFile||simpleName(e)+'.java';document.getElementById('codeLine').textContent=e.line?'line '+e.line:'';e.sourcePreview.forEach(row=>{const div=document.createElement('div');div.className='line'+(row.covered?' covered':'')+(row.active?' active':'');const n=document.createElement('span');n.className='num';n.textContent=row.line;const t=document.createElement('span');t.className='text';t.textContent=row.text||' ';div.append(n,t);div.onclick=()=>vscode.postMessage({command:'openLine',className:e.className,methodName:e.methodName,line:row.line,sourcePath:e.sourcePath});code.appendChild(div)});code.querySelector('.active')?.scrollIntoView({block:'center'});}
  function valueText(v){if(v===null||v===undefined)return 'null';if(typeof v!=='object')return String(v);return v.value!==undefined?String(v.value):(v.type||'object');}
  function renderObject(target,value,labelPrefix='field'){const root=document.getElementById(target);root.innerHTML='';if(value===null||value===undefined){root.innerHTML='<div class="state-empty">Not available</div>';return;}const add=(key,v)=>{const row=document.createElement('div');row.className='state-row';const k=document.createElement('span');k.className='state-key';k.textContent=key;const val=document.createElement('span');val.className='state-value';val.textContent=valueText(v);if(v&&v.type){const type=document.createElement('span');type.className='state-type';type.textContent=v.type;val.appendChild(type);}row.append(k,val);root.appendChild(row);};if(value.fields&&Object.keys(value.fields).length){add('this',value);Object.entries(value.fields).forEach(([k,v])=>add(k,v));}else add(labelPrefix,value);}
  function renderArguments(values){const root=document.getElementById('arguments');root.innerHTML='';if(!Array.isArray(values)||!values.length){root.innerHTML='<div class="state-empty">No arguments</div>';return;}values.forEach((v,i)=>{const row=document.createElement('div');row.className='state-row';const k=document.createElement('span');k.className='state-key';k.textContent='arg'+i;const val=document.createElement('span');val.className='state-value';val.textContent=valueText(v);if(v&&v.type){const type=document.createElement('span');type.className='state-type';type.textContent=v.type;val.appendChild(type);}row.append(k,val);root.appendChild(row);});}
  function renderState(e){
    const entrySnapshot=e.__entrySnapshot||{};
    const stateTitle=document.getElementById('stateTitle');
    const receiverHeading=document.getElementById('receiverHeading');
    if(e.event==='callsite'){
      stateTitle.textContent='State before invocation';receiverHeading.textContent='Target before call';
      // Method-entry advice runs immediately after control crosses the call
      // boundary. At that point the receiver and arguments still represent
      // the values supplied by the caller, before the callee body executes.
      renderObject('receiver',e.targetReceiver!==undefined?e.targetReceiver:e.receiver,'this');
      renderArguments(e.arguments);
      const outcome=document.getElementById('outcome');
      outcome.innerHTML='<div class="state-empty">Invocation enters '+simpleName({className:e.calleeClassName})+'.'+e.calleeMethodName+'()</div>';
      return;
    }
    const isAfter=e.event==='exit'||e.event==='resume';
    stateTitle.textContent=isAfter?'State after return':'Frame snapshot';
    receiverHeading.textContent=isAfter?'This after return':'This at entry';
    const receiver=isAfter?(e.receiverAfter!==undefined?e.receiverAfter:entrySnapshot.receiver):(e.receiver!==undefined?e.receiver:entrySnapshot.receiver);
    renderObject('receiver',receiver,'this');
    renderArguments(e.arguments!==undefined?e.arguments:entrySnapshot.arguments);
    const outcome=document.getElementById('outcome');outcome.innerHTML='';
    const add=(key,v)=>{const row=document.createElement('div');row.className='state-row';const k=document.createElement('span');k.className='state-key';k.textContent=key;const val=document.createElement('span');val.className='state-value';val.textContent=valueText(v);if(v&&v.type){const type=document.createElement('span');type.className='state-type';type.textContent=v.type;val.appendChild(type);}row.append(k,val);outcome.appendChild(row);};
    const result=e.event==='exit'||e.event==='resume'?e:e.__outcome;
    if(result){if(result.thrown)add('thrown',result.thrown);else add('return',result.returnValue);}else outcome.innerHTML='<div class="state-empty">Method has not returned in this trace</div>';
  }
  function render(){const e=events[index];document.querySelectorAll('.step').forEach((x,i)=>x.classList.toggle('active',i===index));document.querySelectorAll('.step')[index]?.scrollIntoView({block:'nearest'});document.getElementById('kind').textContent=e.event==='line'?'Executed source line':(e.event==='exit'?'Method return':(e.event==='callsite'?'Call site':(e.event==='resume'?'Caller resumes':'Method entry')));document.getElementById('method').textContent=e.event==='callsite'?'Calls '+simpleName({className:e.calleeClassName})+'.'+e.calleeMethodName+'()':(e.event==='resume'?'Returns to '+simpleName(e)+'.'+e.methodName+'()':simpleName(e)+'.'+e.methodName+'()');document.getElementById('file').textContent=e.line?((e.sourceFile||e.className)+':'+e.line):(e.event==='exit'?'Returned from '+e.className:e.className);document.getElementById('depth').textContent='Depth '+Number(e.depth||0);document.getElementById('thread').textContent='Thread '+String(e.thread||e.threadId||'main');document.getElementById('position').textContent=(index+1)+' of '+events.length;document.getElementById('progress').style.width=(((index+1)/events.length)*100)+'%';document.getElementById('prev').disabled=index===0;document.getElementById('next').disabled=index===events.length-1;renderCode(e);renderState(e);}
  const move=d=>{index=Math.max(0,Math.min(events.length-1,index+d));render()};document.getElementById('prev').onclick=()=>move(-1);document.getElementById('next').onclick=()=>move(1);document.getElementById('open').onclick=()=>{const e=events[index];vscode.postMessage({command:e.line?'openLine':'openMethod',className:e.className,methodName:e.methodName,line:e.line,sourcePath:e.sourcePath})};window.addEventListener('keydown',e=>{if(e.key==='j'||e.key==='ArrowDown'||e.key==='ArrowRight'){move(1);e.preventDefault()}if(e.key==='k'||e.key==='ArrowUp'||e.key==='ArrowLeft'){move(-1);e.preventDefault()}if(e.key==='Enter'){document.getElementById('open').click()}});render();
  </script></body></html>`;
}

async function collectExecutedCode(coverageDir) {
  if (!coverageDir || !fs.existsSync(coverageDir)) return [];
  const xmlFiles = fs.readdirSync(coverageDir).filter(name => name.endsWith('.xml')).map(name => path.join(coverageDir, name));
  const byFile = new Map();
  for (const xmlFile of xmlFiles) {
    let xml;
    try { xml = fs.readFileSync(xmlFile, 'utf8'); } catch (_) { continue; }
    const packageBlocks = [...xml.matchAll(/<package name="([^"]*)">([\s\S]*?)<\/package>/g)];
    for (const packageMatch of packageBlocks) {
      const packagePath = decodeXml(packageMatch[1]);
      const body = packageMatch[2];
      for (const sourceMatch of body.matchAll(/<sourcefile name="([^"]+)">([\s\S]*?)<\/sourcefile>/g)) {
        const fileName = decodeXml(sourceMatch[1]);
        const relativePath = [packagePath, fileName].filter(Boolean).join('/');
        const hitLines = [...sourceMatch[2].matchAll(/<line nr="(\d+)"[^>]*ci="(\d+)"[^>]*\/>/g)]
          .filter(match => Number(match[2]) > 0).map(match => Number(match[1]));
        if (!hitLines.length) continue;
        const resolved = await resolveCoverageSource(relativePath, fileName);
        const key = resolved || relativePath;
        const existing = byFile.get(key) || { sourcePath: resolved, relativePath, lines: new Set() };
        for (const line of hitLines) existing.lines.add(line);
        byFile.set(key, existing);
      }
    }
  }
  return [...byFile.values()].map(item => ({ ...item, lines: [...item.lines].sort((a,b)=>a-b) }))
    .sort((a,b)=>(a.sourcePath || a.relativePath).localeCompare(b.sourcePath || b.relativePath));
}

async function resolveCoverageSource(relativePath, fileName) {
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  const exact = await vscode.workspace.findFiles(`**/src/main/{java,kotlin}/${normalizedRelative}`, '**/{build,.gradle,node_modules,out,bin}/**', 5);
  if (exact.length) return exact[0].fsPath;
  const candidates = await vscode.workspace.findFiles(`**/${fileName}`, '**/{build,.gradle,node_modules,out,bin}/**', 50);
  const preferred = candidates.find(uri => normalizePath(uri.fsPath).endsWith(`/src/main/java/${normalizedRelative}`) || normalizePath(uri.fsPath).endsWith(`/src/main/kotlin/${normalizedRelative}`));
  return (preferred || candidates[0])?.fsPath;
}

function decodeXml(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function updateCoverageIndex(result) {
  coverageIndex[result.filter] = {
    filter: result.filter,
    displayName: result.displayName,
    task: result.task,
    sourcePath: result.sourcePath,
    invocation: result.invocation,
    capturedAt: result.finishedAt,
    files: result.executedCode
  };
  await extensionContext.workspaceState.update('coverageIndex', coverageIndex);
  projectTestsProvider?.refreshStatuses();
}

function javaMethodKey(method) {
  return `${method.parentClass?.name || '<type>'}#${method.name}`;
}

async function recordModifiedMethods(event) {
  const normalizedPath = normalizePath(event.document.uri.fsPath);
  const parsed = await parseJavaDocument(event.document);
  const methods = parsed.methods || [];
  const modified = changedProductionMethods.get(normalizedPath) || new Set();

  for (const change of event.contentChanges || []) {
    const startLine = change.range.start.line;
    // Include the newly inserted extent as well as the replaced original range.
    const insertedLineCount = Math.max(0, String(change.text || '').split(/\r?\n/).length - 1);
    const endLine = Math.max(change.range.end.line, startLine + insertedLineCount);
    for (const method of methods) {
      if (method.range.start.line <= endLine && method.range.end.line >= startLine) {
        modified.add(javaMethodKey(method));
      }
    }
  }

  if (modified.size) changedProductionMethods.set(normalizedPath, modified);
}

async function executedMethodKeysForFile(file) {
  if (Array.isArray(file.executedMethods) && file.executedMethods.length) {
    return new Set(file.executedMethods);
  }
  if (!file.sourcePath || !fs.existsSync(file.sourcePath)) return new Set();
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file.sourcePath));
    const parsed = await parseJavaDocument(document);
    const executedLines = new Set((file.lines || []).filter(Number.isFinite));
    return new Set(parsed.methods
      .filter(method => {
        const start = method.range.start.line + 1;
        const end = method.range.end.line + 1;
        for (const line of executedLines) if (line >= start && line <= end) return true;
        return false;
      })
      .map(javaMethodKey));
  } catch (_) {
    return new Set();
  }
}

async function affectedCoverageEntries() {
  if (!changedProductionMethods.size) return [];

  const affected = [];
  for (const entry of Object.values(coverageIndex)) {
    let bestMatch;
    for (const file of entry.files || []) {
      if (!file.sourcePath) continue;
      const normalizedPath = normalizePath(file.sourcePath);
      const modifiedMethods = changedProductionMethods.get(normalizedPath);
      if (!modifiedMethods?.size) continue;

      const executedMethods = await executedMethodKeysForFile(file);
      const matchedMethod = [...modifiedMethods].find(key => executedMethods.has(key));
      if (!matchedMethod) continue;

      const methodName = matchedMethod.split('#').pop();
      bestMatch = {
        kind: 'method',
        methodKey: matchedMethod,
        sourcePath: file.sourcePath,
        relativePath: file.relativePath,
        reason: `Executed production method ${methodName} was modified.`
      };
      break;
    }
    if (bestMatch) affected.push({ ...entry, affectedMatch: bestMatch });
  }

  return affected.sort((a, b) => String(a.displayName || a.filter).localeCompare(String(b.displayName || b.filter)));
}

async function openExecutedCodeLocation(result, sourcePath, line) {
  if (!sourcePath) throw new Error('The executed source file could not be located.');
  const uri = vscode.Uri.file(sourcePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const position = new vscode.Position(Math.max(0, Math.min(Number(line || 1) - 1, document.lineCount - 1)), 0);
  const editor = await showNavigationDocument(document, position, uri);
  const fileCoverage = (result.executedCode || []).find(file => normalizePath(file.sourcePath || '') === normalizePath(sourcePath));
  if (editor && executedLineDecoration && fileCoverage) {
    const ranges = fileCoverage.lines.filter(value => value > 0 && value <= document.lineCount).map(value => document.lineAt(value - 1).range);
    editor.setDecorations(executedLineDecoration, ranges);
  }
}

async function clearAffectedTests() {
  const count = changedProductionMethods.size;
  changedProductionPaths.clear();
  changedProductionMethods.clear();
  projectTestsProvider?.refreshStatuses();
  if (count) {
    vscode.window.setStatusBarMessage(`Cleared affected-test tracking for ${count} changed ${count === 1 ? 'file' : 'files'}.`, 2500);
  }
}

async function runAffectedTests() {
  const affected = await affectedCoverageEntries();
  if (!affected.length) return vscode.window.showInformationMessage('No affected tests are known for the changed production files.');
  for (const entry of affected) {
    const base = entry.invocation;
    if (!base) continue;
    await executeInvocation({ ...base, debug: false, captureCoverage: true, args: rebuildDebugArgs(base.args || [], false) });
  }
}

function parseGradleTestOutput(raw, invocation, code) {
  const normalized = String(raw || '').replace(/\r/g, '');
  const lines = normalized.split('\n');
  const events = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*(?!>\s*Task\b)(.+?)\s+>\s+(.+?)\s+(PASSED|FAILED|SKIPPED)\s*$/i);
    if (!match) continue;

    const className = match[1].trim();
    const testName = match[2].trim();
    if (!className || !testName || /^Task\b/i.test(className) || /^Task\b/i.test(testName)) continue;

    const event = {
      className,
      testName,
      status: match[3].toLowerCase(),
      line: lines[index],
      lineIndex: index
    };
    const key = `${event.className}|${event.testName}|${event.status}`;
    if (!seen.has(key)) {
      seen.add(key);
      events.push(event);
    }
  }

  let status = code === 0 ? 'passed' : 'failed';
  if (events.some(event => event.status === 'failed')) status = 'failed';
  else if (events.length && events.every(event => event.status === 'skipped')) status = 'skipped';
  else if (code === null) status = 'stopped';

  const failures = events
    .filter(event => event.status === 'failed')
    .map(event => ({
      className: event.className,
      testName: event.testName,
      displayName: `${event.className} > ${event.testName}`,
      failure: extractFailureForEvent(lines, event.lineIndex)
    }))
    .filter(item => item.failure);
  const buildFailure = failures.length ? '' : extractBuildFailure(normalized);
  if (buildFailure) {
    failures.push({
      className: '',
      testName: '',
      displayName: 'Gradle build',
      failure: buildFailure
    });
  }
  const failure = failures[0]?.failure || '';
  const testOutput = extractTestConsoleOutput(normalized);
  const summary = events.length
    ? events.map(event => `${event.className} > ${event.testName} ${event.status.toUpperCase()}`).join('\n')
    : `${invocation.filter} ${status.toUpperCase()}`;
  return { status, summary, testOutput, failure, failures, events };
}

function extractFailureForEvent(lines, eventLineIndex) {
  const captured = [];

  for (let index = eventLineIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    if (/^\s*(?!>\s*Task\b).+?\s+>\s+.+?\s+(?:PASSED|FAILED|SKIPPED)\s*$/i.test(line)) break;
    if (/^>\s*Task\b/.test(trimmed) || /^BUILD (?:SUCCESSFUL|FAILED)\b/.test(trimmed)) break;
    if (/^\d+ tests? completed\b/i.test(trimmed) || /^\d+ actionable tasks?:\b/i.test(trimmed)) break;
    if (/^> There were failing tests\b/i.test(trimmed) || /^See the report at:/i.test(trimmed)) break;
    if (/^FAILURE: Build failed\b/i.test(trimmed) || /^\* What went wrong:/i.test(trimmed)) break;

    if (!trimmed && captured.length === 0) continue;
    captured.push(line);
  }

  while (captured.length && !captured[captured.length - 1].trim()) captured.pop();
  return cleanFailureOutput(captured.join('\n'));
}

function extractBuildFailure(normalized) {
  const start = normalized.search(/FAILURE: Build failed|org\.opentest4j\.|java\.lang\.(?:AssertionError|Exception|Error)/i);
  return start >= 0 ? cleanFailureOutput(normalized.slice(start)) : '';
}

function extractTestConsoleOutput(normalized) {
  const lines = normalized.split('\n');
  const blocks = [];
  let current = [];
  let capture = false;

  for (const line of lines) {
    if (/\bSTANDARD_(?:OUT|ERROR)\b/i.test(line) || /\bstandard (?:out|error)\b/i.test(line)) {
      if (current.length) blocks.push(current);
      current = [];
      capture = true;
      continue;
    }
    if (!capture) continue;
    if (isGradleConsoleBoundary(line)) {
      if (current.length) blocks.push(current);
      current = [];
      capture = false;
      continue;
    }
    current.push(line.replace(/^\s{4}/, ''));
  }
  if (current.length) blocks.push(current);
  return blocks.map(block => block.join('\n').trim()).filter(Boolean).join('\n\n');
}

function isGradleConsoleBoundary(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return /^> Task\b/.test(trimmed)
    || /^(?!>\s*Task\b).+\s+>\s+.+\s+(?:PASSED|FAILED|SKIPPED)$/.test(trimmed)
    || /^BUILD (?:SUCCESSFUL|FAILED)\b/.test(trimmed)
    || /^\d+ tests? completed\b/i.test(trimmed)
    || /^\d+ actionable tasks?:\b/.test(trimmed)
    || /^Consider enabling configuration cache\b/.test(trimmed)
    || /^https?:\/\//.test(trimmed)
    || /^FAILURE: Build failed\b/.test(trimmed)
    || /^\* What went wrong:/.test(trimmed);
}

function cleanFailureOutput(value) {
  return String(value || '')
    .replace(/\nBUILD FAILED[\s\S]*$/i, '')
    .replace(/\n\d+ tests? completed[\s\S]*$/i, '')
    .replace(/\n\d+ actionable tasks?:[\s\S]*$/i, '')
    .replace(/^\s*[^\n]+\s+>\s+[^\n]+\s+FAILED\s*\n?/, '')
    .replace(/^\s*> Task[^\n]*\n?/gm, '')
    .trim();
}

async function recordResult(result) {
  testHistory = [result, ...testHistory.filter(item => item.id !== result.id)].slice(0, 30);
  if (result.sourcePath) invalidatedSourcePaths.delete(normalizePath(result.sourcePath));
  if (extensionContext) await extensionContext.workspaceState.update('testHistory', testHistory);
  refreshLastRunDecorations();
  if (projectTestsProvider) projectTestsProvider.refreshStatuses();
}

async function clearHistory() {
  testHistory = [];
  latestResults.clear();
  invalidatedSourcePaths.clear();
  if (extensionContext) await extensionContext.workspaceState.update('testHistory', []);
  const editor = vscode.window.activeTextEditor;
  if (editor && lastPassedDecoration && lastFailedDecoration) {
    editor.setDecorations(lastPassedDecoration, []);
    editor.setDecorations(lastFailedDecoration, []);
  }
  if (projectTestsProvider) projectTestsProvider.refreshStatuses();
  showResultsView();
}

async function showResultsView(result) {
  if (resultsViewProvider) {
    resultsViewProvider.setCurrent(result || testHistory[0]);
  }
  try {
    await vscode.commands.executeCommand('workbench.view.extension.compositeGradleTests');
  } catch (_) {
    // The view remains available from the Activity Bar even when VS Code does
    // not expose the generated container command in an older release.
  }
}

class CompositeGradleResultsViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = undefined;
    this.current = testHistory[0];
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(message => this.handleMessage(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.render();
    });
    this.render();
  }

  setCurrent(result) {
    if (result) this.current = result;
    else this.current = testHistory[0];
    this.render();
  }

  findResult(id) {
    if (this.current && this.current.id === id) return this.current;
    return testHistory.find(item => item.id === id);
  }

  async handleMessage(message) {
    try {
      if (message.command === 'select') {
        const selected = this.findResult(message.id);
        if (selected) {
          this.current = selected;
          this.render();
        }
        return;
      }

      if (message.command === 'clear') {
        await clearHistory();
        return;
      }

      if (message.command === 'raw') {
        output.show(true);
        return;
      }

      const selected = this.findResult(message.id);
      if (!selected) {
        throw new Error('The selected test result is no longer available.');
      }

      if (message.command === 'rerun') {
        await executeInvocation(invocationFromResult(selected, false));
      } else if (message.command === 'debug') {
        await executeInvocation(invocationFromResult(selected, true));
      } else if (message.command === 'runClass') {
        await executeInvocation(classInvocationFromResult(selected, false));
      } else if (message.command === 'debugClass') {
        await executeInvocation(classInvocationFromResult(selected, true));
      } else if (message.command === 'copy') {
        await vscode.env.clipboard.writeText(selected.command || formatCommand(selected.invocation.executable, selected.invocation.args));
        vscode.window.setStatusBarMessage('Composite Gradle command copied.', 2500);
      } else if (message.command === 'openExecuted') {
        await openExecutedCodeLocation(selected, message.file, message.line);
      } else if (message.command === 'expandExecuted') {
        showExecutedCodePanel(selected);
      } else if (message.command === 'openFlow') {
        showFlowReplayPanel(selected);
      } else if (message.command === 'rerunReport') {
        const next = invocationFromResult(selected, false);
        next.captureCoverage = true;
        next.captureFlow = false;
        next.analysisMode = 'report';
        await executeInvocation(next);
      } else if (message.command === 'rerunFlow') {
        const next = invocationFromResult(selected, false);
        next.captureCoverage = false;
        next.captureFlow = true;
        next.analysisMode = 'flow';
        await executeInvocation(next);
      } else if (message.command === 'analyze') {
        await executeCombinedAnalysis(invocationFromResult(selected, false));
      } else if (message.command === 'openSource' || message.command === 'openLocation') {
        let sourcePath = selected.sourcePath;
        if (message.command === 'openLocation') {
          sourcePath = await resolveFailureSourcePath(selected, message.file, message.className) || sourcePath;
        }
        if (!sourcePath) throw new Error('The source file for this result could not be located.');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
        let line = 0;
        let character = 0;
        if (message.command === 'openLocation' && Number.isInteger(message.line)) {
          line = message.line - 1;
        } else if (Number.isInteger(selected.invocation?.targetLine)) {
          line = selected.invocation.targetLine;
          character = selected.invocation.targetCharacter || 0;
        } else {
          const target = await findTargetByFilter(document, selected.filter, selected.invocation?.scope);
          line = target?.range?.start?.line || 0;
          character = target?.range?.start?.character || 0;
        }
        const position = new vscode.Position(Math.max(0, Math.min(line, document.lineCount - 1)), Math.max(0, character));
        const editor = await showNavigationDocument(document, position, vscode.Uri.file(sourcePath));
        const range = document.lineAt(position.line).range;
        const highlight = vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground')
        });
        editor.setDecorations(highlight, [range]);
        setTimeout(() => highlight.dispose(), 1000);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Composite Gradle Tests: ${error.message || error}`);
    }
  }

  render() {
    if (!this.view) return;
    this.view.webview.html = renderResultsHtml(this.current || testHistory[0], testHistory);
  }
}


async function findTargetByFilter(document, filter, scope) {
  const parsed = await parseJavaDocument(document);
  const methodName = scope === 'method' ? String(filter || '').split('.').pop() : '';
  if (methodName) {
    const method = parsed.methods.find(item => item.isTest && item.name === methodName);
    if (method) return method;
  }
  const className = String(filter || '').split('.').pop().replace(/\$.*$/, '');
  return parsed.classes.find(item => item.name === className) || parsed.classes[0];
}

async function resolveFailureSourcePath(result, fileName, className) {
  const current = result.sourcePath;
  if (current && (!fileName || path.basename(current) === fileName)) return current;
  if (!fileName) return current;

  const candidates = await vscode.workspace.findFiles(`**/${fileName}`, '**/{build,.gradle,node_modules,out}/**', 100);
  if (!candidates.length) return current;
  const classPath = String(className || '').replace(/\$.*$/, '').replace(/\./g, '/');
  const packageSuffix = classPath ? `${classPath}.java` : '';
  const taskParts = String(result.task || '').split(':').filter(Boolean);
  const score = uri => {
    const normalized = normalizePath(uri.fsPath);
    let value = 0;
    if (packageSuffix && normalized.endsWith(packageSuffix)) value += 1000;
    for (const part of taskParts) if (normalized.includes(`/${part}/`)) value += 20;
    if (result.cwd && isPathInside(normalized, normalizePath(result.cwd))) value += 10;
    return value;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0].fsPath;
}


function classInvocationFromResult(result, debug) {
  const base = result.invocation || (lastInvocation && lastInvocation.filter === result.filter ? lastInvocation : undefined);
  if (!base) throw new Error('This history item cannot be rerun as a class. Run it once with the current extension version.');
  const classFilter = base.classFilter || String(base.filter || '').replace(/\.[^.]+$/, '');
  const args = [...base.args];
  const testsIndex = args.indexOf('--tests');
  if (testsIndex >= 0 && testsIndex + 1 < args.length) args[testsIndex + 1] = classFilter;
  return {
    ...base,
    args: rebuildDebugArgs(args, debug),
    debug,
    scope: 'class',
    filter: classFilter,
    displayName: base.classDisplayName || classFilter.split('.').pop(),
    classFilter,
    classDisplayName: base.classDisplayName || classFilter.split('.').pop()
  };
}

function invocationFromResult(result, debug) {
  const base = result.invocation || (lastInvocation && lastInvocation.filter === result.filter ? lastInvocation : undefined);
  if (!base) {
    throw new Error('This older history item does not contain enough information to rerun. Run the test once with the current extension version.');
  }
  return { ...base, debug, args: rebuildDebugArgs(base.args, debug) };
}

function rebuildDebugArgs(args, debug) {
  const filtered = args.filter(value => value !== '--debug-jvm');
  if (debug) filtered.push('--debug-jvm');
  return filtered;
}

function renderResultsHtml(current, history) {
  const nonce = Math.random().toString(36).slice(2);
  const detail = current ? renderResultDetail(current) : '<div class="empty-state"><span class="empty-icon">◇</span><strong>No test result yet</strong><span>Run a test to see its output here.</span></div>';
  const rows = history.map((item, index) => `
    <button class="history-row ${current && current.id === item.id ? 'selected' : ''}" data-command="select" data-id="${escapeHtml(item.id)}" data-index="${index}">
      <span class="history-status status ${escapeHtml(item.status)}">${statusGlyph(item.status)}</span>
      <span class="history-copy"><strong>${escapeHtml(item.displayName)}</strong><small>${escapeHtml(item.status)}</small></span>
      <span class="history-time">${formatDuration(item.durationMs)}</span>
    </button>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
    :root{--radius:4px}*{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{display:flex;flex-direction:column;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0;margin:0;background:var(--vscode-sideBar-background);line-height:1.4}button{font:inherit}
    .history{flex:0 0 auto;max-height:28vh;display:flex;flex-direction:column;background:color-mix(in srgb,var(--vscode-sideBar-background) 90%,var(--vscode-editor-background));border-bottom:1px solid var(--vscode-panel-border)}
    .header{padding:8px 10px 6px;display:flex;justify-content:space-between;align-items:center}.header h3,.detail-label{font-size:10px;font-weight:700;margin:0;text-transform:uppercase;letter-spacing:.1em;color:var(--vscode-descriptionForeground)}.header button{border:0;border-radius:3px;padding:2px 6px;cursor:pointer;background:transparent;color:var(--vscode-descriptionForeground);font-size:10px}.header button:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}
    .history-list{overflow:auto;min-height:0}.history-row{width:100%;border:0;border-top:1px solid var(--vscode-panel-border);border-left:2px solid transparent;background:transparent;color:inherit;text-align:left;padding:6px 9px;display:grid;grid-template-columns:17px minmax(0,1fr) auto;gap:7px;align-items:center;cursor:pointer}.history-row:hover{background:var(--vscode-list-hoverBackground)}.history-row.selected{border-left-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.history-status{font-size:14px}.history-copy{min-width:0;display:flex;flex-direction:column}.history-copy strong{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history-copy small{font-size:9px;color:var(--vscode-descriptionForeground);text-transform:capitalize}.history-time{color:var(--vscode-descriptionForeground);font-size:9px;font-variant-numeric:tabular-nums}.history-row.selected .history-time,.history-row.selected .history-copy small{color:inherit;opacity:.78}.empty-history{padding:10px;color:var(--vscode-descriptionForeground);font-size:11px}
    .detail-wrap{min-height:0;flex:1 1 auto;display:flex;flex-direction:column;background:var(--vscode-sideBar-background)}.detail-label{flex:0 0 auto;padding:9px 10px 7px;border-top:5px solid color-mix(in srgb,var(--vscode-focusBorder) 45%,var(--vscode-panel-border));border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-sideBar-background) 82%,var(--vscode-editor-background))}.detail{min-height:0;overflow:auto;padding:10px 12px 28px;scroll-behavior:smooth}.hero{display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:7px;align-items:center;padding:2px 0 8px}.hero .big{font-size:17px;line-height:1}.hero h1{font-size:13px;font-weight:650;line-height:1.2;margin:0;word-break:break-word}.hero-duration{font-size:10px;color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums}.subtitle{margin-top:2px;color:var(--vscode-descriptionForeground);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.subtitle code{font-family:var(--vscode-editor-font-family);font-size:10px}
    .actions{display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin:0;padding:5px 0;border-top:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border)}.actions button{border:0;border-radius:3px;padding:3px 6px;cursor:pointer;background:transparent;color:var(--vscode-foreground);font-size:11px}.actions button:hover{background:var(--vscode-toolbar-hoverBackground)}.actions .primary{color:var(--vscode-textLink-foreground);font-weight:600}.actions .separator{width:1px;height:14px;background:var(--vscode-panel-border);margin:0 2px}.actions .raw{margin-left:auto;color:var(--vscode-descriptionForeground)}
    .status.passed{color:var(--vscode-testing-iconPassed)}.status.failed{color:var(--vscode-testing-iconFailed)}.status.skipped{color:var(--vscode-testing-iconSkipped)}.status.running{color:var(--vscode-progressBar-background)}.status.stopped{color:var(--vscode-descriptionForeground)}
    .section{margin-top:16px}.failure-section{margin-top:12px}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}.section h3{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--vscode-descriptionForeground);margin:0}.console{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.55;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-radius:var(--radius);padding:9px 10px;margin:0;max-height:260px;overflow:auto}.failure-nav{display:flex;gap:5px;overflow-x:auto;padding:0 0 8px;margin-bottom:4px}.failure-nav button{flex:0 0 auto;max-width:220px;border:1px solid var(--vscode-panel-border);border-radius:999px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:4px 8px;cursor:pointer;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.failure-nav button span{color:var(--vscode-testing-iconFailed);margin-right:5px}.failure-nav button:hover{background:var(--vscode-button-secondaryHoverBackground)}.failure-groups{display:flex;flex-direction:column;gap:16px}.failure-group{min-width:0}.failure-test{display:flex;align-items:center;gap:7px;margin:0 0 6px 1px;padding-top:2px;font-family:var(--vscode-editor-font-family);font-size:11px;font-weight:600}.failure-test-mark{color:var(--vscode-testing-iconFailed);font-size:13px}.failure-card{scroll-margin-top:10px;border:1px solid color-mix(in srgb,var(--vscode-testing-iconFailed) 60%,var(--vscode-panel-border));border-left:3px solid var(--vscode-testing-iconFailed);border-radius:var(--radius);background:color-mix(in srgb,var(--vscode-testing-iconFailed) 5%,var(--vscode-textCodeBlock-background));overflow:hidden}.failure-head{padding:9px 10px;border-bottom:1px solid var(--vscode-panel-border)}.failure-type{font-family:var(--vscode-editor-font-family);font-size:11px;font-weight:700}.failure-message{font-size:11px;margin-top:3px;color:var(--vscode-descriptionForeground)}.comparison{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--vscode-panel-border)}.comparison>div{padding:8px 10px;min-width:0}.comparison>div+div{border-left:1px solid var(--vscode-panel-border)}.comparison label{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin-bottom:3px}.comparison code{font-family:var(--vscode-editor-font-family);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.location{display:block;width:100%;border:0;background:transparent;text-align:left;color:var(--vscode-textLink-foreground);cursor:pointer;padding:7px 10px;font-family:var(--vscode-editor-font-family);font-size:11px}.location:hover{background:var(--vscode-toolbar-hoverBackground)}.frames{margin:0;padding:8px 10px;white-space:pre;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:10px;line-height:1.55}.framework-toggle{width:100%;border:0;border-top:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer;text-align:left;padding:6px 10px;font-size:10px}.framework-toggle:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.framework-frames{display:none;border-top:1px solid var(--vscode-panel-border)}.framework-frames.open{display:block}
    .event-list{display:flex;flex-direction:column;gap:3px}.event{width:100%;border:0;text-align:left;background:transparent;color:inherit;display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:6px;padding:5px 6px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px}.event:hover{background:var(--vscode-list-hoverBackground)}.event .event-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.event-open{font-family:var(--vscode-font-family);font-size:9px;color:var(--vscode-textLink-foreground);opacity:0}.event.failed:hover .event-open,.event.failed:focus .event-open{opacity:1}.event.failed{cursor:pointer}.event.passed .event-mark{color:var(--vscode-testing-iconPassed)}.event.failed .event-mark{color:var(--vscode-testing-iconFailed)}.event.skipped .event-mark{color:var(--vscode-testing-iconSkipped)}
    .coverage-title-actions{display:flex;align-items:center;gap:8px}.coverage-expand{border:1px solid var(--vscode-panel-border);border-radius:3px;background:transparent;color:var(--vscode-textLink-foreground);font-size:10px;padding:2px 6px;cursor:pointer}.coverage-expand:hover{background:var(--vscode-toolbar-hoverBackground)}.coverage-files{display:flex;flex-direction:column;gap:10px}.coverage-file{border:1px solid var(--vscode-panel-border);border-radius:var(--radius);overflow:hidden;background:var(--vscode-editor-background)}.coverage-file-head{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-textCodeBlock-background) 82%,var(--vscode-sideBar-background))}.coverage-file-name{min-width:0;flex:1;font-family:var(--vscode-editor-font-family);font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.coverage-file-meta{font-size:9px;color:var(--vscode-descriptionForeground);white-space:nowrap}.coverage-open{border:0;background:transparent;color:var(--vscode-textLink-foreground);font-size:10px;padding:2px 4px;cursor:pointer}.coverage-open:hover{background:var(--vscode-toolbar-hoverBackground)}.coverage-code{font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.5;overflow-x:auto}.coverage-row{width:100%;display:grid;grid-template-columns:38px minmax(max-content,1fr);border:0;background:transparent;color:var(--vscode-foreground);padding:0;text-align:left;cursor:pointer}.coverage-row:hover{background:var(--vscode-list-hoverBackground)}.coverage-row.context{opacity:.42}.coverage-row.executed{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 7%,transparent)}.coverage-row.executed:hover{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 13%,var(--vscode-list-hoverBackground))}.coverage-number{padding:2px 8px 2px 4px;text-align:right;color:var(--vscode-editorLineNumber-foreground);border-right:1px solid var(--vscode-panel-border);font-variant-numeric:tabular-nums;user-select:none}.coverage-row.executed .coverage-number{color:var(--vscode-textLink-foreground);font-weight:600}.coverage-source{padding:2px 9px;white-space:pre}.coverage-gap{height:7px;border-top:1px dotted var(--vscode-panel-border);opacity:.6}.empty-output{padding:8px 10px;border:1px dashed var(--vscode-panel-border);border-radius:var(--radius);color:var(--vscode-descriptionForeground);font-size:11px}.empty-state{min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--vscode-descriptionForeground);gap:5px}.empty-state strong{color:var(--vscode-foreground);font-size:13px}.empty-icon{font-size:24px}
  </style></head><body><section class="history"><div class="header"><h3>Recent runs</h3><button data-command="clear">Clear</button></div><div class="history-list">${rows || '<div class="empty-history">No recent runs.</div>'}</div></section><section class="detail-wrap"><div class="detail-label">Selected run</div><main class="detail">${detail}</main></section>
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();let selectedIndex=Math.max(0,[...document.querySelectorAll('.history-row')].findIndex(x=>x.classList.contains('selected')));function selectIndex(next){const rows=[...document.querySelectorAll('.history-row')];if(!rows.length)return;selectedIndex=Math.max(0,Math.min(next,rows.length-1));rows[selectedIndex].click();rows[selectedIndex].scrollIntoView({block:'nearest'});}document.addEventListener('click',event=>{const button=event.target.closest('button[data-command]');if(!button)return;if(button.dataset.command==='jumpFailure'){document.getElementById(button.dataset.target)?.scrollIntoView({behavior:'smooth',block:'start'});return;}if(button.dataset.command==='toggleFramework'){const target=document.getElementById(button.dataset.target);if(target){target.classList.toggle('open');button.textContent=target.classList.contains('open')?'Hide framework frames':button.dataset.label;}return;}const message={command:button.dataset.command,id:button.dataset.id};if(button.dataset.line)message.line=Number(button.dataset.line);if(button.dataset.file)message.file=button.dataset.file;if(button.dataset.class)message.className=button.dataset.class;vscode.postMessage(message);});document.addEventListener('keydown',event=>{if(['INPUT','TEXTAREA'].includes(event.target.tagName))return;const key=event.key.toLowerCase();if(key==='j'||event.key==='ArrowDown'){event.preventDefault();selectIndex(selectedIndex+1);}else if(key==='k'||event.key==='ArrowUp'){event.preventDefault();selectIndex(selectedIndex-1);}else if(key==='enter'||key==='o'){event.preventDefault();document.querySelector('[data-command="openSource"]')?.click();}else if(key==='r'){event.preventDefault();document.querySelector('[data-command="rerun"]')?.click();}else if(key==='d'){event.preventDefault();document.querySelector('[data-command="debug"]')?.click();}else if(key==='f'){event.preventDefault();document.querySelector('.failure-card')?.scrollIntoView({behavior:'smooth',block:'start'});}});document.body.tabIndex=0;document.body.focus();</script></body></html>`;
}

function renderResultDetail(result) {
  const isClass = result.invocation && result.invocation.scope === 'class';
  const rerunLabel = isClass ? 'Rerun Class' : 'Rerun Test';
  const debugLabel = isClass ? 'Debug Class' : 'Debug Test';
  const className = result.invocation?.classDisplayName || result.filter?.split('.').slice(-2, -1)[0] || '';
  const simpleName = isClass ? result.displayName : String(result.displayName || '').split('.').pop();
  const subtitle = [className && className !== simpleName ? className : '', result.task, formatDuration(result.durationMs)].filter(Boolean).join(' · ');
  const failureItems = Array.isArray(result.failures) && result.failures.length
    ? result.failures
    : (result.failure ? [{ displayName: result.displayName, failure: result.failure }] : []);
  const failureSection = failureItems.length
    ? `<div class="section failure-section"><div class="section-title"><h3>Failures · ${failureItems.length}</h3></div>${failureItems.length > 1 ? `<div class="failure-nav">${failureItems.map((item, index) => `<button data-command="jumpFailure" data-target="failure-${index}"><span>✕</span>${escapeHtml(shortTestName(item.displayName))}</button>`).join('')}</div>` : ''}<div class="failure-groups">${failureItems.map((item, index) => renderFailureCard(analyzeFailure(item.failure, result, item), result, index, item.displayName)).join('')}</div></div>`
    : '';
  const consoleSection = result.testOutput
    ? `<div class="section"><div class="section-title"><h3>Test output</h3></div><pre class="console">${escapeHtml(result.testOutput)}</pre></div>`
    : (result.status === 'failed' ? `<div class="section"><div class="section-title"><h3>Test output</h3></div><div class="empty-output">No output was written by this test.</div></div>` : '');
  const failureAnalyses = failureItems.map(item => analyzeFailure(item.failure, result, item));
  const eventLines = String(result.summary || '').split('\n').filter(line => {
    if (!line.trim() || /FAILURE:\s*Build failed/i.test(line) || /^>\s*Task\b/.test(line.trim())) return false;
    return /\s(PASSED|FAILED|SKIPPED)$/.test(line);
  });
  const showResults = isClass || eventLines.length > 1;
  const executedFileCount = Array.isArray(result.executedCode) ? result.executedCode.length : 0;
  const executedLineCount = Array.isArray(result.executedCode) ? result.executedCode.reduce((total, file) => total + (Array.isArray(file.lines) ? file.lines.length : 0), 0) : 0;
  const canExpandExecuted = executedLineCount >= 8 || executedFileCount >= 2;
  const flowLineCount = Array.isArray(result.flowEvents) ? result.flowEvents.filter(event => event.event === 'line').length : 0;
  const flowMethodCount = Array.isArray(result.flowEvents) ? result.flowEvents.filter(event => event.event === 'enter').length : 0;
  const flowEntryCount = flowLineCount || flowMethodCount;
  const flowSection = flowEntryCount
    ? `<div class="section flow-section"><div class="section-title"><h3>Execution flow</h3><button class="coverage-expand" data-command="openFlow" data-id="${escapeHtml(result.id)}">Open replay</button></div><div class="empty-output">${flowLineCount ? `${flowLineCount} ordered source-line events` : `${flowMethodCount} ordered method calls with source locations`} captured. Open replay to walk through the execution.</div></div>`
    : (result.flowCaptured ? `<div class="section flow-section"><div class="section-title"><h3>Execution flow</h3></div><div class="empty-output">Flow capture completed, but no flow events were recorded.</div></div>` : '');
  const executedSection = executedFileCount
    ? `<div class="section executed-section"><div class="section-title"><h3>Executed code</h3><div class="coverage-title-actions"><span class="coverage-file-meta">${executedFileCount} ${executedFileCount === 1 ? 'file' : 'files'} · ${executedLineCount} ${executedLineCount === 1 ? 'line' : 'lines'}</span>${canExpandExecuted ? `<button class="coverage-expand" data-command="expandExecuted" data-id="${escapeHtml(result.id)}">Open expanded</button>` : ''}</div></div><div class="coverage-files">${result.executedCode.map(file => renderExecutedFile(file, result)).join('')}</div></div>`
    : (result.coverageCaptured ? `<div class="section"><div class="section-title"><h3>Executed code</h3></div><div class="empty-output">No executed-code report was produced. Open Raw output for the exact Gradle or JaCoCo error.</div></div>` : '');
  const resultSection = showResults && eventLines.length
    ? `<div class="section"><div class="section-title"><h3>Results · ${eventLines.length}</h3></div><div class="event-list">${eventLines.map(line => {
        const match = line.match(/\s(PASSED|FAILED|SKIPPED)$/);
        const state = match ? match[1].toLowerCase() : result.status;
        const mark = state === 'passed' ? '✓' : state === 'failed' ? '✕' : '○';
        const name = match ? line.slice(0, -match[0].length) : line;
        const failureIndex = state === 'failed' ? failureItems.findIndex(item => normalizeTestDisplay(item.displayName) === normalizeTestDisplay(name)) : -1;
        const info = failureIndex >= 0 ? failureAnalyses[failureIndex] : undefined;
        const attrs = info?.line ? ` data-command="openLocation" data-id="${escapeHtml(result.id)}" data-line="${info.line}" data-file="${escapeHtml(info.file || '')}" data-class="${escapeHtml(info.className || '')}" title="Open failed test"` : '';
        return `<${info?.line ? 'button' : 'div'} class="event ${escapeHtml(state)}"${attrs}><span class="event-mark">${mark}</span><span class="event-name">${escapeHtml(name)}</span>${info?.line ? '<span class="event-open">Open</span>' : ''}</${info?.line ? 'button' : 'div'}>`;
      }).join('')}</div></div>` : '';

  return `<div class="hero"><span class="big status ${escapeHtml(result.status)}">${statusGlyph(result.status)}</span><div><h1>${escapeHtml(simpleName)}</h1><div class="subtitle" title="${escapeHtml(result.filter)}">${escapeHtml([className && className !== simpleName ? className : '', result.task].filter(Boolean).join(' · '))}</div></div><span class="hero-duration">${formatDuration(result.durationMs)}</span></div>
    <div class="actions"><button class="primary" data-command="rerun" data-id="${escapeHtml(result.id)}">↻ ${rerunLabel}</button><button data-command="debug" data-id="${escapeHtml(result.id)}">◇ ${debugLabel}</button><span class="separator"></span><button data-command="openSource" data-id="${escapeHtml(result.id)}">Open test</button><button data-command="copy" data-id="${escapeHtml(result.id)}">Copy</button><button data-command="rerunReport" data-id="${escapeHtml(result.id)}">Code report</button><button data-command="rerunFlow" data-id="${escapeHtml(result.id)}">Code flow</button><button class="primary" data-command="analyze" data-id="${escapeHtml(result.id)}">Analyze</button><button class="raw" data-command="raw" data-id="${escapeHtml(result.id)}">Raw</button></div>
    ${failureSection}${consoleSection}${flowSection}${executedSection}${resultSection}`;
}


function showExecutedCodePanel(result) {
  if (!result || !Array.isArray(result.executedCode) || !result.executedCode.length) {
    vscode.window.showInformationMessage('No executed code is available for this test run.');
    return;
  }
  if (executedCodePanel) {
    executedCodePanel.reveal(vscode.ViewColumn.Beside, false);
  } else {
    executedCodePanel = vscode.window.createWebviewPanel(
      'compositeGradleTests.executedCode',
      'Executed Code',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    executedCodePanel.onDidDispose(() => { executedCodePanel = undefined; });
    executedCodePanel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.command === 'openExecuted') {
          const selected = testHistory.find(item => item.id === message.id) || result;
          await openExecutedCodeLocation(selected, message.file, Number(message.line));
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Composite Gradle Tests: ${error.message || error}`);
      }
    });
  }
  executedCodePanel.title = `Executed Code — ${result.displayName || 'Test'}`;
  executedCodePanel.webview.html = renderExecutedCodeWorkspaceHtml(result);
}

function renderExecutedCodeWorkspaceHtml(result) {
  const nonce = Math.random().toString(36).slice(2);
  const files = Array.isArray(result.executedCode) ? result.executedCode : [];
  const totalLines = files.reduce((total, file) => total + (Array.isArray(file.lines) ? file.lines.length : 0), 0);
  const nav = files.map((file, index) => {
    const sourcePath = String(file.sourcePath || '');
    const name = path.basename(sourcePath || file.relativePath || `Source ${index + 1}`);
    const count = Array.isArray(file.lines) ? file.lines.length : 0;
    return `<button class="file-nav ${index === 0 ? 'active' : ''}" data-target="coverage-file-${index}"><span>${escapeHtml(name)}</span><small>${count} lines</small></button>`;
  }).join('');
  const content = files.map((file, index) => renderExpandedExecutedFile(file, result, index)).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
    *{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}button{font:inherit}.shell{height:100%;display:grid;grid-template-columns:220px minmax(0,1fr)}.sidebar{border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);display:flex;flex-direction:column;min-width:0}.summary{padding:16px 14px 12px;border-bottom:1px solid var(--vscode-panel-border)}.summary h1{font-size:14px;margin:0 0 3px}.summary p{font-size:11px;color:var(--vscode-descriptionForeground);margin:0}.file-list{padding:8px;overflow:auto}.file-nav{width:100%;display:flex;justify-content:space-between;gap:8px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;padding:7px 8px;cursor:pointer}.file-nav:hover{background:var(--vscode-list-hoverBackground)}.file-nav.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.file-nav span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family);font-size:11px}.file-nav small{flex:0 0 auto;font-size:9px;opacity:.7}.workspace{overflow:auto;scroll-behavior:smooth;padding:18px 22px 70px}.file-section{scroll-margin-top:18px;margin:0 0 24px;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden;background:var(--vscode-textCodeBlock-background)}.file-header{position:sticky;top:-18px;z-index:2;display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}.file-header strong{font-family:var(--vscode-editor-font-family);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-header .meta{margin-left:auto;font-size:10px;color:var(--vscode-descriptionForeground)}.open-file{border:0;border-radius:3px;background:transparent;color:var(--vscode-textLink-foreground);padding:3px 6px;cursor:pointer}.open-file:hover{background:var(--vscode-toolbar-hoverBackground)}.code{overflow:auto;font-family:var(--vscode-editor-font-family);font-size:13px;line-height:1.65}.row{width:100%;display:grid;grid-template-columns:52px minmax(max-content,1fr);border:0;background:transparent;color:inherit;padding:0;text-align:left;cursor:pointer}.row:hover{background:var(--vscode-list-hoverBackground)}.row.context{opacity:.5}.row.executed{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 8%,transparent)}.number{padding:3px 12px 3px 4px;text-align:right;color:var(--vscode-editorLineNumber-foreground);border-right:1px solid var(--vscode-panel-border);font-variant-numeric:tabular-nums;user-select:none}.row.executed .number{color:var(--vscode-textLink-foreground);font-weight:700}.source{padding:3px 14px;white-space:pre}.gap{height:14px;border-top:1px dotted var(--vscode-panel-border);opacity:.65}.empty{padding:18px;color:var(--vscode-descriptionForeground)}@media(max-width:700px){.shell{grid-template-columns:1fr}.sidebar{display:none}.workspace{padding:12px}.file-header{top:-12px}}
  </style></head><body><div class="shell"><aside class="sidebar"><div class="summary"><h1>${escapeHtml(result.displayName || 'Executed code')}</h1><p>${files.length} ${files.length === 1 ? 'file' : 'files'} · ${totalLines} executed ${totalLines === 1 ? 'line' : 'lines'}</p></div><nav class="file-list">${nav}</nav></aside><main class="workspace">${content || '<div class="empty">No executed code was captured.</div>'}</main></div><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.addEventListener('click',event=>{const nav=event.target.closest('.file-nav');if(nav){document.querySelectorAll('.file-nav').forEach(x=>x.classList.remove('active'));nav.classList.add('active');document.getElementById(nav.dataset.target)?.scrollIntoView({behavior:'smooth',block:'start'});return;}const button=event.target.closest('button[data-command]');if(!button)return;vscode.postMessage({command:button.dataset.command,id:button.dataset.id,file:button.dataset.file,line:Number(button.dataset.line)});});const observer=new IntersectionObserver(entries=>{const visible=entries.filter(x=>x.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(!visible)return;document.querySelectorAll('.file-nav').forEach(x=>x.classList.toggle('active',x.dataset.target===visible.target.id));},{root:document.querySelector('.workspace'),threshold:[.2,.5,.8]});document.querySelectorAll('.file-section').forEach(x=>observer.observe(x));</script></body></html>`;
}

function renderExpandedExecutedFile(file, result, index) {
  const sourcePath = String(file.sourcePath || '');
  const displayPath = sourcePath || file.relativePath || 'Source';
  const executed = [...new Set((file.lines || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const firstLine = executed[0] || 1;
  let sourceLines = [];
  try {
    if (sourcePath && fs.existsSync(sourcePath)) sourceLines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
  } catch (_) {}
  if (!sourceLines.length) {
    const rows = executed.map(line => `<button class="row executed" data-command="openExecuted" data-id="${escapeHtml(result.id)}" data-line="${line}" data-file="${escapeHtml(sourcePath)}"><span class="number">${line}</span><span class="source">Executed line</span></button>`).join('');
    return `<section id="coverage-file-${index}" class="file-section"><header class="file-header"><strong title="${escapeHtml(displayPath)}">${escapeHtml(path.basename(displayPath))}</strong><span class="meta">${executed.length} executed lines</span><button class="open-file" data-command="openExecuted" data-id="${escapeHtml(result.id)}" data-line="${firstLine}" data-file="${escapeHtml(sourcePath)}">Open file</button></header><div class="code">${rows}</div></section>`;
  }
  const executedSet = new Set(executed);
  const visible = new Set();
  for (const line of executed) {
    for (let candidate = Math.max(1, line - 4); candidate <= Math.min(sourceLines.length, line + 4); candidate++) visible.add(candidate);
  }
  const visibleLines = [...visible].sort((a, b) => a - b).slice(0, 600);
  let previous = 0;
  const rows = visibleLines.map(line => {
    const gap = previous && line > previous + 1 ? '<div class="gap"></div>' : '';
    previous = line;
    const state = executedSet.has(line) ? 'executed' : 'context';
    return `${gap}<button class="row ${state}" data-command="openExecuted" data-id="${escapeHtml(result.id)}" data-line="${line}" data-file="${escapeHtml(sourcePath)}"><span class="number">${line}</span><span class="source">${escapeHtml(sourceLines[line - 1] || '')}</span></button>`;
  }).join('');
  const capped = visible.size > visibleLines.length ? ` · showing first ${visibleLines.length}` : '';
  return `<section id="coverage-file-${index}" class="file-section"><header class="file-header"><strong title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</strong><span class="meta">${executed.length} executed lines${capped}</span><button class="open-file" data-command="openExecuted" data-id="${escapeHtml(result.id)}" data-line="${firstLine}" data-file="${escapeHtml(sourcePath)}">Open file</button></header><div class="code">${rows}</div></section>`;
}

function renderExecutedFile(file, result) {
  const sourcePath = String(file.sourcePath || '');
  const displayPath = path.basename(sourcePath || file.relativePath || 'Source');
  const executed = [...new Set((file.lines || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const firstLine = executed[0] || 1;
  let sourceLines = [];
  try {
    if (sourcePath && fs.existsSync(sourcePath)) sourceLines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
  } catch (_) {}

  if (!sourceLines.length) {
    const buttons = executed.map(line => `<button class="coverage-row executed" data-command="openExecuted" data-id="${escapeHtml(result.id)}" data-line="${line}" data-file="${escapeHtml(sourcePath)}"><span class="coverage-number">${line}</span><span class="coverage-source">Executed line</span></button>`).join('');
    return `<div class="coverage-file"><div class="coverage-file-head"><span class="coverage-file-name" title="${escapeHtml(sourcePath)}">${escapeHtml(displayPath)}</span><span class="coverage-file-meta">${executed.length} ${executed.length === 1 ? 'line' : 'lines'}</span><button class="coverage-open" data-command="openExecuted" data-id="${escapeHtml(result.id)}" data-line="${firstLine}" data-file="${escapeHtml(sourcePath)}">Open file</button></div><div class="coverage-code">${buttons}</div></div>`;
  }

  const executedSet = new Set(executed);
  const visible = new Set();
  for (const line of executed) {
    for (let candidate = Math.max(1, line - 1); candidate <= Math.min(sourceLines.length, line + 1); candidate++) visible.add(candidate);
  }
  const visibleLines = [...visible].sort((a, b) => a - b).slice(0, 120);
  let previous = 0;
  const rows = visibleLines.map(line => {
    const gap = previous && line > previous + 1 ? '<div class="coverage-gap"></div>' : '';
    previous = line;
    const state = executedSet.has(line) ? 'executed' : 'context';
    return `${gap}<button class="coverage-row ${state}" data-command="openExecuted" data-id="${escapeHtml(result.id)}" data-line="${line}" data-file="${escapeHtml(sourcePath)}"><span class="coverage-number">${line}</span><span class="coverage-source">${escapeHtml(sourceLines[line - 1] || '')}</span></button>`;
  }).join('');
  return `<div class="coverage-file"><div class="coverage-file-head"><span class="coverage-file-name" title="${escapeHtml(sourcePath)}">${escapeHtml(displayPath)}</span><span class="coverage-file-meta">${executed.length} ${executed.length === 1 ? 'line' : 'lines'}</span><button class="coverage-open" data-command="openExecuted" data-id="${escapeHtml(result.id)}" data-line="${firstLine}" data-file="${escapeHtml(sourcePath)}">Open file</button></div><div class="coverage-code">${rows}</div></div>`;
}

function analyzeFailure(failure, result, failureItem = {}) {
  const lines = String(failure || '').split('\n').filter((line, index, all) => line.trim() || (index > 0 && index < all.length - 1));
  const first = (lines.find(line => line.trim()) || '').trim();
  const colon = first.indexOf(':');
  const fullType = colon >= 0 ? first.slice(0, colon).trim() : first;
  const type = fullType.split('.').pop() || 'Test failure';
  const message = colon >= 0 ? first.slice(colon + 1).trim() : '';
  let expected = '', actual = '';
  let match = message.match(/expected:\s*<([\s\S]*?)>\s*but was:\s*<([\s\S]*?)>/i);
  if (match) { expected = match[1]; actual = match[2]; }
  else if ((match = message.match(/expected:\s*not\s*<([\s\S]*?)>/i))) { expected = `not ${match[1]}`; actual = match[1]; }
  const frames = lines.slice(1).filter(line => /^\s*at\s+/.test(line));
  const filterParts = String(result.filter || '').split('.').filter(Boolean);
  const eventClass = String(failureItem.className || '').trim();
  const invocationClass = String(result.invocation?.className || result.invocation?.classDisplayName || '').trim();
  const inferredClass = result.invocation?.scope === 'class'
    ? String(result.filter || '').trim()
    : filterParts.slice(0, -1).join('.');
  const fullClassName = eventClass || invocationClass || inferredClass;
  const simpleClassName = fullClassName.split('.').pop();
  const sourceFileName = simpleClassName ? `${simpleClassName.replace(/\$.*$/, '')}.java` : '';
  const packagePrefix = fullClassName.includes('.') ? fullClassName.split('.').slice(0, -1).join('.') : filterParts.slice(0, -2).join('.');
  const normalizedFrame = line => line.replace(/\b(?:app|test|main)\/\//g, '');
  const isFramework = line => /(?:^|[\s/])(org\.junit|org\.opentest4j|java\.|javax\.|jdk\.|sun\.|org\.gradle|groovy\.|worker\.org\.gradle)/.test(normalizedFrame(line));
  const isUser = line => {
    const normalized = normalizedFrame(line);
    if (fullClassName && (normalized.includes(`${fullClassName}.`) || normalized.includes(` ${fullClassName}.`))) return true;
    if (sourceFileName && normalized.includes(`(${sourceFileName}:`)) return true;
    if (packagePrefix && (normalized.includes(`/${packagePrefix}.`) || normalized.includes(` ${packagePrefix}.`))) return true;
    return /\([^():]+\.java:\d+\)/.test(normalized) && !isFramework(normalized);
  };
  const userFrames = frames.filter(isUser);
  const frameworkFrames = frames.filter(line => !isUser(line));
  const primary = userFrames[0]
    || (sourceFileName ? frames.find(line => normalizedFrame(line).includes(`(${sourceFileName}:`)) : '')
    || frames.find(line => /\([^():]+\.java:\d+\)/.test(line) && !isFramework(line))
    || frames.find(line => /\([^():]+\.java:\d+\)/.test(line))
    || '';
  const locationMatch = primary.match(/([^/.(]+\.java):(\d+)\)/);
  return { type, message, expected, actual, userFrames, frameworkFrames, primary, file: locationMatch?.[1], line: locationMatch ? Number(locationMatch[2]) : undefined, className: fullClassName };
}

function renderFailureCard(info, result, index = 0, testName = '') {
  const comparison = info.expected || info.actual ? `<div class="comparison"><div><label>Expected</label><code>${escapeHtml(info.expected || '—')}</code></div><div><label>Actual</label><code>${escapeHtml(info.actual || '—')}</code></div></div>` : '';
  const location = info.line ? `<button class="location" data-command="openLocation" data-id="${escapeHtml(result.id)}" data-line="${info.line}" data-file="${escapeHtml(info.file || '')}" data-class="${escapeHtml(info.className || '')}">↗ ${escapeHtml(info.file || 'Open failure')} : ${info.line}</button>` : '';
  const userFrames = info.userFrames.length ? `<pre class="frames">${escapeHtml(info.userFrames.join('\n'))}</pre>` : '';
  const frameworkId = `frameworkFrames-${index}`;
  const framework = info.frameworkFrames.length ? `<button class="framework-toggle" data-command="toggleFramework" data-target="${frameworkId}" data-label="Show ${info.frameworkFrames.length} framework frames">Show ${info.frameworkFrames.length} framework frames</button><pre id="${frameworkId}" class="frames framework-frames">${escapeHtml(info.frameworkFrames.join('\n'))}</pre>` : '';
  const testHeader = testName ? `<div class="failure-test"><span class="failure-test-mark">✕</span><span>${escapeHtml(testName)}</span></div>` : '';
  return `<article id="failure-${index}" class="failure-group">${testHeader}<div class="failure-card"><div class="failure-head"><div class="failure-type">${escapeHtml(info.type)}</div>${info.message ? `<div class="failure-message">${escapeHtml(info.message)}</div>` : ''}</div>${comparison}${location}${userFrames}${framework}</div></article>`;
}

function normalizeTestDisplay(value) {
  return String(value || '').replace(/\s+(PASSED|FAILED|SKIPPED)$/i, '').replace(/\(\)$/, '').replace(/\s+/g, '').toLowerCase();
}

function shortTestName(value) {
  const text = String(value || 'Test failure');
  const separator = text.lastIndexOf('>');
  return (separator >= 0 ? text.slice(separator + 1) : text).trim();
}

function statusGlyph(status) {
  return status === 'passed' ? '✓' : status === 'failed' ? '✕' : status === 'skipped' ? '○' : status === 'running' ? '◌' : '■';
}

function formatDuration(ms) {
  if (!ms) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
}

function isDebugReady(text, port) {
  return new RegExp(`Listening for transport dt_socket at address:\\s*${port}\\b`, 'i').test(text)
    || new RegExp(`Listening.*${port}`, 'i').test(text);
}

async function attachDebugger(invocation) {
  output.appendLine(`\n[debug] Attaching Java debugger to localhost:${invocation.debugPort} for project ${invocation.projectName || '(automatic)'}...`);
  const configuration = {
    type: 'java',
    request: 'attach',
    name: `Composite Gradle: ${invocation.displayName}`,
    hostName: 'localhost',
    port: invocation.debugPort,
    timeout: 120000
  };
  // An incorrect Java project name causes the Java debug adapter to reject
  // every evaluate request. Only pass a name that was explicitly configured
  // or positively resolved from the Java language server.
  if (invocation.projectName) configuration.projectName = invocation.projectName;
  const started = await vscode.debug.startDebugging(undefined, configuration);
  if (!started) {
    throw new Error('VS Code could not start the Java attach debugger. Ensure the Java debugger extension is installed.');
  }
}

function terminateProcessTree(child) {
  if (!child || child.killed) return;
  output.appendLine('\n[stop] Terminating Gradle test...');
  if (process.platform === 'win32') {
    cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      }, 2000);
    } catch (_) {
      child.kill('SIGTERM');
    }
  }
}

async function resolveTestTarget(document, position, scope) {
  const parsed = await parseJavaDocument(document);
  const containingClasses = parsed.classes.filter(item => item.range.contains(position));
  const containingMethods = parsed.methods.filter(item => item.range.contains(position));
  const clazz = smallestRange(containingClasses);
  const method = smallestRange(containingMethods);

  if (!clazz) return undefined;
  const className = buildNestedClassName(clazz, parsed.classes);
  const fqcn = parsed.packageName ? `${parsed.packageName}.${className}` : className;

  if (scope === 'method') {
    if (!method || !method.isTest) return undefined;
    return {
      filter: `${fqcn}.${method.name}`,
      displayName: `${className}.${method.name}`,
      classFilter: fqcn,
      classDisplayName: className,
      scope: 'method',
      range: method.selectionRange
    };
  }

  return { filter: fqcn, displayName: className, classFilter: fqcn, classDisplayName: className, scope: 'class', range: clazz.selectionRange };
}

async function parseJavaDocument(document) {
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) || [];
  const packageMatch = document.getText().match(/^\s*package\s+([\w.]+)\s*;/m);
  const packageName = packageMatch ? packageMatch[1] : '';
  const annotations = new Set(vscode.workspace.getConfiguration('compositeGradleTests', document.uri)
    .get('testAnnotations', ['Test', 'ParameterizedTest', 'RepeatedTest', 'TestFactory', 'TestTemplate']));
  const classes = [];
  const methods = [];

  function visit(symbolList, parentClass) {
    for (const symbol of symbolList) {
      const isClass = [vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum].includes(symbol.kind);
      const currentClass = isClass ? symbol : parentClass;
      if (isClass) {
        classes.push({ name: symbol.name, range: symbol.range, selectionRange: symbol.selectionRange, parentClass });
      }
      if (symbol.kind === vscode.SymbolKind.Method) {
        const prefixStart = Math.max(0, symbol.range.start.line - 8);
        const prefix = document.getText(new vscode.Range(prefixStart, 0, symbol.selectionRange.start.line, 500));
        const foundAnnotations = [...prefix.matchAll(/@([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
        const displayNameMatch = prefix.match(/@DisplayName\s*\(\s*\"((?:\\.|[^\"\\])*)\"\s*\)/s);
        methods.push({
          name: stripMethodSignature(symbol.name),
          displayName: displayNameMatch ? decodeJavaString(displayNameMatch[1]) : undefined,
          range: symbol.range,
          selectionRange: symbol.selectionRange,
          parentClass: currentClass,
          isTest: foundAnnotations.some(name => annotations.has(name))
        });
      }
      if (symbol.children && symbol.children.length) visit(symbol.children, currentClass);
    }
  }

  visit(symbols, undefined);

  // The Red Hat Java language server does not always include annotations in a
  // method symbol's range, and it can briefly return no document symbols while
  // the project is importing. Merge a lightweight source parser so cursor
  // commands and CodeLens still work for ordinary JUnit source files.
  const fallback = parseJavaSourceFallback(document, annotations);
  mergeFallbackSymbols(classes, methods, fallback);

  return { packageName, classes, methods };
}

function mergeFallbackSymbols(classes, methods, fallback) {
  for (const fallbackClass of fallback.classes) {
    const existing = classes.find(item => item.name === fallbackClass.name
      && item.selectionRange.start.line === fallbackClass.selectionRange.start.line);
    if (!existing) classes.push(fallbackClass);
  }

  for (const fallbackMethod of fallback.methods) {
    const existing = methods.find(item => item.name === fallbackMethod.name
      && item.selectionRange.start.line === fallbackMethod.selectionRange.start.line);
    if (existing) {
      existing.isTest = existing.isTest || fallbackMethod.isTest;
      existing.displayName = existing.displayName || fallbackMethod.displayName;
      // Language-server ranges sometimes begin at the method name and exclude
      // modifiers/annotations. The fallback range covers the whole declaration
      // and body, which makes "under cursor" behavior consistent.
      if (rangeSize(fallbackMethod.range) > rangeSize(existing.range)) {
        existing.range = fallbackMethod.range;
      }
      if (!existing.parentClass && fallbackMethod.parentClass) {
        existing.parentClass = classes.find(item => item.name === fallbackMethod.parentClass.name
          && item.selectionRange.start.line === fallbackMethod.parentClass.selectionRange.start.line)
          || fallbackMethod.parentClass;
      }
    } else {
      fallbackMethod.parentClass = fallbackMethod.parentClass
        ? classes.find(item => item.name === fallbackMethod.parentClass.name
          && item.selectionRange.start.line === fallbackMethod.parentClass.selectionRange.start.line)
          || fallbackMethod.parentClass
        : undefined;
      methods.push(fallbackMethod);
    }
  }
}

function parseJavaSourceFallback(document, annotations) {
  const text = document.getText();
  const classes = [];
  const methods = [];

  const classPattern = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)[^\{;]*\{/g;
  let match;
  while ((match = classPattern.exec(text))) {
    const openOffset = text.indexOf('{', match.index);
    const closeOffset = findMatchingBrace(text, openOffset);
    if (closeOffset < 0) continue;
    const nameOffset = match.index + match[0].indexOf(match[2]);
    classes.push({
      name: match[2],
      range: new vscode.Range(document.positionAt(match.index), document.positionAt(closeOffset + 1)),
      selectionRange: new vscode.Range(document.positionAt(nameOffset), document.positionAt(nameOffset + match[2].length)),
      parentClass: undefined,
      openOffset,
      closeOffset
    });
  }

  // Establish nested-class relationships after all class ranges are known.
  for (const clazz of classes) {
    clazz.parentClass = classes
      .filter(candidate => candidate !== clazz
        && candidate.openOffset < clazz.openOffset
        && candidate.closeOffset > clazz.closeOffset)
      .sort((a, b) => (a.closeOffset - a.openOffset) - (b.closeOffset - b.openOffset))[0];
  }

  const annotationNames = [...annotations].map(escapeRegExp).join('|');

  // Lightweight fallback for ordinary Java methods. This is used both for
  // test discovery and production-method impact tracking when the Java
  // language server is temporarily unavailable.
  const methodPattern = new RegExp(
    `((?:\\s*@[A-Za-z_$][\\w$]*(?:\\s*\\([^)]*\\))?\\s*)*)` +
    `(?:public|protected|private|static|final|synchronized|abstract|native|strictfp|default|\\s)*` +
    `(?:<[^>{};]+>\\s*)?` +
    `[A-Za-z_$][\\w$<>,.?\\[\\] ]*?\\s+` +
    `([A-Za-z_$][\\w$]*)\\s*\\([^;{}]*\\)\\s*` +
    `(?:throws\\s+[^\\{]+)?\\{`,
    'g'
  );

  while ((match = methodPattern.exec(text))) {
    const openOffset = text.indexOf('{', match.index + match[0].lastIndexOf('{'));
    const closeOffset = findMatchingBrace(text, openOffset);
    if (closeOffset < 0) continue;
    const methodName = match[2];
    const nameOffset = match.index + match[0].lastIndexOf(methodName);
    const parentClass = classes
      .filter(clazz => clazz.openOffset < match.index && clazz.closeOffset > closeOffset)
      .sort((a, b) => (a.closeOffset - a.openOffset) - (b.closeOffset - b.openOffset))[0];
    const displayNameMatch = match[1].match(/@DisplayName\s*\(\s*\"((?:\\.|[^\"\\])*)\"\s*\)/s);
    methods.push({
      name: methodName,
      displayName: displayNameMatch ? decodeJavaString(displayNameMatch[1]) : undefined,
      range: new vscode.Range(document.positionAt(match.index), document.positionAt(closeOffset + 1)),
      selectionRange: new vscode.Range(document.positionAt(nameOffset), document.positionAt(nameOffset + methodName.length)),
      parentClass,
      isTest: annotationNames
        ? [...match[1].matchAll(/@([A-Za-z_$][\w$]*)/g)].some(annotation => annotations.has(annotation[1]))
        : false
    });
  }

  return { classes, methods };
}

function decodeJavaString(value) {
  return String(value)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function findMatchingBrace(text, openOffset) {
  if (openOffset < 0 || text[openOffset] !== '{') return -1;
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openOffset; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; i++; continue; }
    if (char === '/' && next === '*') { blockComment = true; i++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return i;
  }
  return -1;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripMethodSignature(name) {
  const paren = name.indexOf('(');
  return paren >= 0 ? name.slice(0, paren) : name;
}

function buildNestedClassName(clazz, classes) {
  const names = [clazz.name];
  let parent = clazz.parentClass;
  while (parent) {
    names.unshift(parent.name);
    parent = parent.parentClass;
  }
  return names.join('$');
}

function smallestRange(items) {
  return items.sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
}

function rangeSize(range) {
  return (range.end.line - range.start.line) * 100000 + (range.end.character - range.start.character);
}


async function refreshLastRunDecorations() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'java' || !lastPassedDecoration || !lastFailedDecoration) return;
  const sourcePath = normalizePath(editor.document.uri.fsPath);
  if (invalidatedSourcePaths.has(sourcePath)) {
    editor.setDecorations(lastPassedDecoration, []);
    editor.setDecorations(lastFailedDecoration, []);
    return;
  }
  const parsed = await parseJavaDocument(editor.document);
  const statuses = new Map();
  const relevant = testHistory.filter(item => normalizePath(item.sourcePath || '') === sourcePath);
  for (const result of relevant) {
    if (result.invocation?.scope === 'method') {
      const method = String(result.filter || '').split('.').pop();
      if (method && !statuses.has(method)) statuses.set(method, result.status);
      continue;
    }
    for (const line of String(result.summary || '').split('\n')) {
      const match = line.match(/(?:^|>\s*)([A-Za-z_$][\w$]*)\s*(?:\([^)]*\))?\s+(PASSED|FAILED|SKIPPED)\s*$/);
      if (!match || statuses.has(match[1])) continue;
      statuses.set(match[1], match[2].toLowerCase());
    }
  }
  const passed = [], failed = [];
  for (const method of parsed.methods.filter(item => item.isTest)) {
    const status = statuses.get(method.name);
    if (status !== 'passed' && status !== 'failed') continue;
    const option = {
      range: new vscode.Range(method.selectionRange.start.line, 0, method.selectionRange.start.line, 0),
      hoverMessage: `Last run: ${status}. Marker clears when this file changes.`
    };
    (status === 'passed' ? passed : failed).push(option);
  }
  editor.setDecorations(lastPassedDecoration, passed);
  editor.setDecorations(lastFailedDecoration, failed);
}

class CompositeGradleCodeLensProvider {
  constructor() {
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this.changeEmitter.event;
  }

  dispose() { this.changeEmitter.dispose(); }
  refresh() { this.changeEmitter.fire(); }

  async provideCodeLenses(document) {
    const config = vscode.workspace.getConfiguration('compositeGradleTests', document.uri);
    if (!config.get('inlineActions', true)) return [];
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) return [];

    const parsed = await parseJavaDocument(document);
    const cursor = editor.selection.active;
    const activeMethod = parsed.methods
      .filter(item => item.isTest && item.parentClass && item.range.contains(cursor))
      .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
    const lenses = [];

    if (activeMethod) {
      const className = buildNestedClassName(activeMethod.parentClass, parsed.classes);
      const fqcn = parsed.packageName ? `${parsed.packageName}.${className}` : className;
      const target = { filter: `${fqcn}.${activeMethod.name}`, displayName: `${className}.${activeMethod.name}`, classFilter: fqcn, classDisplayName: className, scope: 'method', range: activeMethod.selectionRange };
      lenses.push(new vscode.CodeLens(activeMethod.selectionRange, { title: '$(run) Run', command: 'compositeGradleTests._runTarget', arguments: [document.uri.toString(), target, false] }));
      lenses.push(new vscode.CodeLens(activeMethod.selectionRange, { title: '$(debug-alt) Debug', command: 'compositeGradleTests._runTarget', arguments: [document.uri.toString(), target, true] }));
      return lenses;
    }

    const activeClass = parsed.classes
      .filter(clazz => clazz.range.contains(cursor) && parsed.methods.some(method => method.isTest && method.parentClass === clazz))
      .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
    if (activeClass && cursor.line <= activeClass.selectionRange.line + 1) {
      const className = buildNestedClassName(activeClass, parsed.classes);
      const fqcn = parsed.packageName ? `${parsed.packageName}.${className}` : className;
      const target = { filter: fqcn, displayName: className, classFilter: fqcn, classDisplayName: className, scope: 'class', range: activeClass.selectionRange };
      lenses.push(new vscode.CodeLens(activeClass.selectionRange, { title: '$(run) Run Class', command: 'compositeGradleTests._runTarget', arguments: [document.uri.toString(), target, false] }));
      lenses.push(new vscode.CodeLens(activeClass.selectionRange, { title: '$(debug-alt) Debug Class', command: 'compositeGradleTests._runTarget', arguments: [document.uri.toString(), target, true] }));
    }
    return lenses;
  }
}

async function runProvidedTarget(uri, target, debug) {
  const resolvedUri = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
  const document = await vscode.workspace.openTextDocument(resolvedUri);
  const invocation = await createInvocation(document.uri, target, debug);
  await executeInvocation(invocation);
}

function expandWorkspaceFolder(value, owningWorkspaceFolder) {
  const owningPath = owningWorkspaceFolder.uri.fsPath;
  return value
    .replace(/\$\{workspaceFolder:([^}]+)\}/g, (match, name) => {
      const folder = (vscode.workspace.workspaceFolders || []).find(item => item.name === name);
      if (!folder) {
        const available = (vscode.workspace.workspaceFolders || []).map(item => item.name).join(', ');
        throw new Error(`Workspace folder "${name}" was not found. Available folders: ${available || '(none)'}`);
      }
      return folder.uri.fsPath;
    })
    .replace(/\$\{workspaceFolder\}/g, owningPath);
}

function createSpawnSpec(executable, args) {
  if (process.platform !== 'win32') {
    return { command: executable, args };
  }

  const lower = executable.toLowerCase();
  const isCommandScript = lower.endsWith('.bat') || lower.endsWith('.cmd') || !path.extname(executable);
  if (!isCommandScript) {
    return { command: executable, args };
  }

  const commandLine = formatWindowsCommand(executable, args);
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine]
  };
}

function formatWindowsCommand(executable, args) {
  return [executable, ...args].map(quoteWindowsArgument).join(' ');
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (!/[\s&|<>^()"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/\/$/, process.platform === 'win32' ? '' : '').toLowerCase();
}

function formatCommand(executable, args) {
  return [executable, ...args].map(shellQuote).join(' ');
}

function shellQuote(value) {
  const string = String(value);
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(string)) return string;
  return `"${string.replace(/"/g, '\\"')}"`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


class ProjectTestItem extends vscode.TreeItem {
  constructor(kind, label, data, collapsibleState) {
    super(label, collapsibleState);
    this.kind = kind;
    this.data = data;
    this.id = data.id;
    this.contextValue = `compositeGradleTests.${kind}`;
    this.tooltip = data.tooltip || label;
    this.description = data.description || '';
    this.iconPath = statusThemeIcon(data.status, kind);
    if (kind === 'method' || kind === 'class') {
      this.command = {
        command: 'compositeGradleTests.projectTests.open',
        title: 'Open Test',
        arguments: [this]
      };
    }
  }
}

function statusThemeIcon(status, kind) {
  if (status === 'running') return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('progressBar.background'));
  if (status === 'failed') return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
  if (status === 'passed') return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
  if (status === 'skipped') return new vscode.ThemeIcon('debug-step-over', new vscode.ThemeColor('testing.iconSkipped'));
  if (status === 'stale') return new vscode.ThemeIcon('history', new vscode.ThemeColor('descriptionForeground'));
  if (kind === 'task') return new vscode.ThemeIcon('project');
  if (kind === 'class') return new vscode.ThemeIcon('symbol-class');
  return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
}

class ProjectTestsProvider {
  constructor(context) {
    this.context = context;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
    this.tasks = [];
    this.discovering = false;
  }

  dispose() { this.changeEmitter.dispose(); }
  refreshStatuses() { this.changeEmitter.fire(); }

  async refresh() {
    if (this.discovering) return;
    this.discovering = true;
    this.changeEmitter.fire();
    try {
      const files = await vscode.workspace.findFiles(
        '**/src/{test,*Test,integrationTest}/**/*.java',
        '**/{build,.gradle,node_modules,out,bin}/**',
        5000
      );
      const taskMap = new Map();
      for (const uri of files) {
        try {
          const document = await vscode.workspace.openTextDocument(uri);
          const parsed = await parseJavaDocument(document);
          const testMethods = parsed.methods.filter(method => method.isTest && method.parentClass);
          if (!testMethods.length) continue;
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
          if (!workspaceFolder) continue;
          const config = vscode.workspace.getConfiguration('compositeGradleTests', uri);
          const root = resolveCompositeRoot(config.get('compositeRoot', config.get('root', '${workspaceFolder}')), workspaceFolder);
          const task = resolveTask(uri.fsPath, root, config);
          if (!taskMap.has(task)) taskMap.set(task, { task, classes: new Map(), sourcePath: uri.fsPath });
          const taskNode = taskMap.get(task);
          for (const method of testMethods) {
            const nestedName = buildNestedClassName(method.parentClass, parsed.classes);
            const fqcn = parsed.packageName ? `${parsed.packageName}.${nestedName}` : nestedName;
            if (!taskNode.classes.has(fqcn)) {
              taskNode.classes.set(fqcn, {
                fqcn,
                name: nestedName,
                sourcePath: uri.fsPath,
                uri: uri.toString(),
                line: method.parentClass.selectionRange.start.line,
                methods: new Map()
              });
            }
            const clazz = taskNode.classes.get(fqcn);
            clazz.methods.set(method.name, {
              name: method.name,
              displayName: method.displayName,
              filter: `${fqcn}.${method.name}`,
              sourcePath: uri.fsPath,
              uri: uri.toString(),
              line: method.selectionRange.start.line
            });
          }
        } catch (_) { /* Keep discovery resilient to a single malformed file. */ }
      }
      this.tasks = [...taskMap.values()].sort((a,b) => a.task.localeCompare(b.task));
      await this.context.workspaceState.update('projectTestIndexCount', this.tasks.reduce((n,t)=>n+t.classes.size,0));
    } finally {
      this.discovering = false;
      this.changeEmitter.fire();
    }
  }

  getTreeItem(element) { return element; }

  async getChildren(element) {
    if (!element) {
      if (!this.tasks.length && !this.discovering) await this.refresh();
      if (this.discovering && !this.tasks.length) {
        return [new ProjectTestItem('message', 'Discovering Java tests…', { id:'discovering', status:'running' }, vscode.TreeItemCollapsibleState.None)];
      }
      const affected = await affectedCoverageEntries();
      const roots = this.tasks.map(task => this.taskItem(task));
      if (affected.length) roots.unshift(new ProjectTestItem('affectedRoot', 'Affected Tests', {
        id:'affected',
        status:'stale',
        description:`${affected.length} ${affected.length === 1 ? 'test' : 'tests'}`,
        affected,
        tooltip:'Tests that previously executed a production method modified during this VS Code session. Saving does not clear the affected state; use the clear action when you are done.'
      }, vscode.TreeItemCollapsibleState.Collapsed));
      return roots;
    }
    if (element.kind === 'affectedRoot') {
      return element.data.affected.map(entry => {
        const match = entry.affectedMatch || {};
        const badge = 'method';
        return new ProjectTestItem('affectedMethod', entry.displayName || entry.filter, {
          id:`affected:${entry.filter}`,
          status:'stale',
          description:`${badge} · ${entry.task}`,
          coverageEntry:entry,
          sourcePath:entry.sourcePath,
          line:entry.invocation?.targetLine || 0,
          tooltip:`${match.reason || 'Previously executed changed production code.'}\n${entry.filter}`
        }, vscode.TreeItemCollapsibleState.None);
      });
    }
    if (element.kind === 'task') {
      return [...element.data.taskData.classes.values()]
        .sort((a,b)=>a.name.localeCompare(b.name))
        .map(clazz => this.classItem(element.data.taskData, clazz));
    }
    if (element.kind === 'class') {
      return [...element.data.classData.methods.values()]
        .sort((a,b)=>a.name.localeCompare(b.name))
        .map(method => this.methodItem(element.data.taskData, element.data.classData, method));
    }
    return [];
  }

  taskItem(taskData) {
    const children = [...taskData.classes.values()].flatMap(c => [...c.methods.values()]);
    const status = aggregateStatus(children.map(m => this.statusFor(m.filter, m.sourcePath)));
    return new ProjectTestItem('task', taskData.task, {
      id:`task:${taskData.task}`, status, description:`${taskData.classes.size} classes`,
      taskData, tooltip:`Gradle task ${taskData.task}`
    }, vscode.TreeItemCollapsibleState.Expanded);
  }

  classItem(taskData, classData) {
    const status = aggregateStatus([...classData.methods.values()].map(m => this.statusFor(m.filter, m.sourcePath)));
    return new ProjectTestItem('class', classData.name, {
      id:`class:${taskData.task}:${classData.fqcn}`, status, description:`${classData.methods.size} tests`,
      taskData, classData, sourcePath:classData.sourcePath, line:classData.line
    }, vscode.TreeItemCollapsibleState.Collapsed);
  }

  methodItem(taskData, classData, methodData) {
    const status = this.statusFor(methodData.filter, methodData.sourcePath);
    return new ProjectTestItem('method', `${methodData.name}()`, {
      id:`method:${methodData.filter}`, status, taskData, classData, methodData,
      sourcePath:methodData.sourcePath, line:methodData.line,
      tooltip: methodData.displayName
        ? `${methodData.displayName}\n${methodData.filter}${status === 'stale' ? ' — result is stale' : ''}`
        : `${methodData.filter}${status === 'stale' ? ' — result is stale' : ''}`
    }, vscode.TreeItemCollapsibleState.None);
  }

  statusFor(filter, sourcePath) {
    if (runningProcess && lastInvocation && lastInvocation.filter === filter) return 'running';
    if (invalidatedSourcePaths.has(normalizePath(sourcePath))) return latestStatus(filter) ? 'stale' : 'unknown';
    return latestStatus(filter) || 'unknown';
  }
}

function latestStatus(filter) {
  const direct = testHistory.find(result => result.filter === filter);
  if (direct) return direct.status;
  for (const result of testHistory) {
    const event = (result.events || []).find(event => `${event.className}.${event.testName.replace(/\(.*$/, '')}` === filter || `${event.className}.${event.testName}` === filter);
    if (event) return event.status;
  }
  return undefined;
}

function aggregateStatus(statuses) {
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('stale')) return 'stale';
  const known = statuses.filter(s => s && s !== 'unknown');
  if (known.length && known.every(s => s === 'passed')) return 'passed';
  if (known.length && known.every(s => s === 'skipped')) return 'skipped';
  return 'unknown';
}

async function runProjectTreeItem(item, debug) {
  if (!item || !item.data) return;
  if (item.kind === 'affectedMethod') {
    const base = item.data.coverageEntry?.invocation;
    if (!base) return;
    return executeInvocation({ ...base, debug, captureCoverage:true, args:rebuildDebugArgs(base.args || [], debug) });
  }
  if (item.kind === 'method') {
    const m=item.data.methodData, c=item.data.classData;
    return runProvidedTarget(m.uri, { filter:m.filter, displayName:`${c.name}.${m.name}`, classFilter:c.fqcn, classDisplayName:c.name, scope:'method', range:new vscode.Range(m.line,0,m.line,0) }, debug);
  }
  if (item.kind === 'class') {
    const c=item.data.classData;
    return runProvidedTarget(c.uri, { filter:c.fqcn, displayName:c.name, classFilter:c.fqcn, classDisplayName:c.name, scope:'class', range:new vscode.Range(c.line,0,c.line,0) }, debug);
  }
  if (item.kind === 'task') {
    const task=item.data.taskData;
    const first=[...task.classes.values()][0];
    if (!first) return;
    return runProvidedTarget(first.uri, { filter:'*', displayName:task.task, classFilter:'*', classDisplayName:task.task, scope:'class', range:new vscode.Range(first.line,0,first.line,0) }, debug);
  }
}

async function openProjectTreeItem(item) {
  const sourcePath=item?.data?.sourcePath || item?.data?.methodData?.sourcePath || item?.data?.classData?.sourcePath;
  const line=item?.data?.line ?? item?.data?.methodData?.line ?? item?.data?.classData?.line ?? 0;
  if (!sourcePath) return;
  const uri=vscode.Uri.file(sourcePath);
  const document=await vscode.workspace.openTextDocument(uri);
  const position=new vscode.Position(Math.max(0,Math.min(line,document.lineCount-1)),0);
  await showNavigationDocument(document,position,uri);
}

async function runFailedProjectTests() {
  if (!projectTestsProvider) return;
  const failed=[];
  for (const task of projectTestsProvider.tasks) for (const clazz of task.classes.values()) for (const method of clazz.methods.values()) {
    if (projectTestsProvider.statusFor(method.filter,method.sourcePath)==='failed') failed.push({task,clazz,method});
  }
  if (!failed.length) return vscode.window.showInformationMessage('No failed project tests are recorded.');
  for (const entry of failed) {
    await runProvidedTarget(entry.method.uri,{filter:entry.method.filter,displayName:`${entry.clazz.name}.${entry.method.name}`,classFilter:entry.clazz.fqcn,classDisplayName:entry.clazz.name,scope:'method',range:new vscode.Range(entry.method.line,0,entry.method.line,0)},false);
  }
}


async function showDebugEvaluateWindow() {
  const session = vscode.debug.activeDebugSession;
  if (!session) throw new Error('Start a Java debug session first.');
  if (session.type !== 'java') throw new Error('The active debug session is not a Java session.');

  const frame = await resolveCurrentDebugFrame(session);
  if (!frame) throw new Error('Pause the debugger at a breakpoint before evaluating.');

  debugEvaluateSession = session;
  debugEvaluateFrameId = frame.id;
  debugEvaluateCurrentFrame = frame;

  let document;
  if (debugEvaluateScratchUri) {
    document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === debugEvaluateScratchUri.toString());
  }
  if (!document) {
    document = await vscode.workspace.openTextDocument({
      language: 'java',
      content: '// Ctrl+Enter evaluates the selection or document in the paused frame.\n\n'
    });
    debugEvaluateScratchUri = document.uri;
  }

  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
    preview: false
  });
  await vscode.commands.executeCommand('setContext', 'compositeGradleTests.evaluateEditorActive', true);
  const end = document.lineAt(document.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  editor.revealRange(new vscode.Range(end, end));
  await ensureDebugEvaluateResultPanel();
  renderDebugEvaluateResult({ status: 'idle', message: 'Ready to evaluate.', frame });
  vscode.window.setStatusBarMessage(`Evaluate Expression — ${frame.name || 'paused frame'}`, 3500);
}

async function resolveCurrentDebugFrame(session) {
  try {
    if (debugEvaluateStoppedThreadId) {
      const stack = await session.customRequest('stackTrace', {
        threadId: debugEvaluateStoppedThreadId,
        startFrame: 0,
        levels: 1
      });
      const frame = stack?.stackFrames?.[0];
      if (frame) return { ...frame, threadId: debugEvaluateStoppedThreadId };
    }

    const threads = await session.customRequest('threads');
    for (const thread of threads?.threads || []) {
      try {
        const stack = await session.customRequest('stackTrace', {
          threadId: thread.id,
          startFrame: 0,
          levels: 1
        });
        const frame = stack?.stackFrames?.[0];
        if (frame) {
          debugEvaluateStoppedThreadId = thread.id;
          return { ...frame, threadId: thread.id };
        }
      } catch (_) { }
    }
  } catch (_) { }
  return undefined;
}

async function ensureDebugEvaluateResultPanel() {
  if (debugEvaluateResultPanel) {
    debugEvaluateResultPanel.reveal(undefined, true);
    return debugEvaluateResultPanel;
  }

  // Keep the expression editor above the result view, matching an IDE-style
  // evaluate window. The scratch editor is active when this is called.
  await vscode.commands.executeCommand('workbench.action.newGroupBelow');
  debugEvaluateResultPanel = vscode.window.createWebviewPanel(
    'compositeGradleTests.evaluateResult',
    'Evaluate',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  debugEvaluateResultPanel.webview.onDidReceiveMessage(handleDebugEvaluateMessage);
  debugEvaluateResultPanel.onDidDispose(() => { debugEvaluateResultPanel = undefined; });
  renderDebugEvaluateResult({ status: 'idle', message: 'Press Ctrl+Enter in the Evaluate editor.', frame: debugEvaluateCurrentFrame });
  await vscode.commands.executeCommand('workbench.action.navigateUp');
  return debugEvaluateResultPanel;
}

async function handleDebugEvaluateMessage(message) {
  try {
    if (message.command === 'expand' && Number.isInteger(message.variablesReference)) {
      const session = vscode.debug.activeDebugSession || debugEvaluateSession;
      if (!session) return;
      const response = await session.customRequest('variables', { variablesReference: message.variablesReference });
      debugEvaluateResultPanel?.webview.postMessage({
        command: 'expanded',
        nodeId: message.nodeId,
        variables: response?.variables || []
      });
      return;
    }
    if (message.command === 'history' && Number.isInteger(message.index)) {
      const item = debugEvaluateHistory[message.index];
      if (!item || !debugEvaluateScratchUri) return;
      const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === debugEvaluateScratchUri.toString());
      if (!document) return;
      const edit = new vscode.WorkspaceEdit();
      const full = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      edit.replace(document.uri, full, `// Ctrl+Enter evaluates the selection or document in the paused frame.\n\n${item.expression}`);
      await vscode.workspace.applyEdit(edit);
      const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document.uri.toString() === document.uri.toString());
      if (editor) {
        const end = document.lineAt(document.lineCount - 1).range.end;
        editor.selection = new vscode.Selection(end, end);
        editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      renderDebugEvaluateResult(item.model || { status: 'idle', message: 'Expression restored.', frame: debugEvaluateCurrentFrame });
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Evaluate: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function renderDebugEvaluateResult(model) {
  if (!debugEvaluateResultPanel) return;
  debugEvaluateCurrentModel = model;
  const escape = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const status = model?.status || 'idle';
  const frame = model?.frame || debugEvaluateCurrentFrame;
  const frameLabel = frame
    ? `${escape(frame.name || 'stack frame')} · ${escape(frame.source?.name || frame.source?.path || '')}${frame.line ? `:${frame.line}` : ''}`
    : 'No paused frame';
  const history = debugEvaluateHistory.map((item, index) =>
    `<button class="history-item" data-history="${index}" title="${escape(item.expression)}">${escape(item.expression.replace(/\s+/g, ' ').slice(0, 80))}</button>`
  ).join('');
  const vars = Array.isArray(model?.variables) ? model.variables : [];
  const rootRows = vars.map((v, index) => renderEvaluateVariable(v, `root-${index}`, 0, escape)).join('');
  const resultLine = status === 'success'
    ? `<div class="root-result"><span class="value">${escape(formatDebugValue(model.result))}</span><span class="type">${escape(model.type || '')}</span></div>`
    : status === 'error'
      ? `<div class="error">${escape(model.message)}</div>`
      : status === 'running'
        ? `<div class="running">Evaluating…</div>`
        : `<div class="idle">${escape(model.message || 'Ready')}</div>`;
  const expression = model?.expression ? `<div class="expression">${escape(model.expression)}</div>` : '';
  const nonce = Math.random().toString(36).slice(2);
  debugEvaluateResultPanel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
    *{box-sizing:border-box}html,body{height:100%;margin:0}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column;font-size:12px}
    .context{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.context strong{color:var(--vscode-foreground);font-weight:600}
    .main{display:grid;grid-template-columns:minmax(0,1fr) 155px;min-height:0;flex:1}.result-pane{min-width:0;overflow:auto;padding:10px 12px 24px}.history{border-left:1px solid var(--vscode-panel-border);min-width:0;overflow:auto;background:var(--vscode-sideBar-background)}
    .section-label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--vscode-descriptionForeground);font-weight:700;padding:8px 9px 5px}.history-item{display:block;width:100%;border:0;border-top:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-foreground);text-align:left;padding:7px 8px;font:inherit;font-family:var(--vscode-editor-font-family);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}.history-item:hover{background:var(--vscode-list-hoverBackground)}
    .expression{font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground);padding:0 0 8px;white-space:pre-wrap}.root-result{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:baseline;padding:7px 8px;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);margin-bottom:8px}.value{font-family:var(--vscode-editor-font-family);font-size:13px;overflow-wrap:anywhere}.type{color:var(--vscode-descriptionForeground);font-size:10px}.error{border-left:3px solid var(--vscode-testing-iconFailed);background:var(--vscode-inputValidation-errorBackground);padding:9px;white-space:pre-wrap}.running,.idle{color:var(--vscode-descriptionForeground);padding:8px 0}
    .tree{border:1px solid var(--vscode-panel-border)}.var-row{display:grid;grid-template-columns:minmax(110px,.8fr) minmax(100px,1.2fr) minmax(70px,.55fr);align-items:center;min-height:26px;border-top:1px solid var(--vscode-panel-border);font-family:var(--vscode-editor-font-family);font-size:11px}.var-row:first-child{border-top:0}.cell{padding:4px 7px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.name{display:flex;align-items:center;gap:3px}.toggle{width:16px;height:18px;padding:0;border:0;background:transparent;color:var(--vscode-foreground);cursor:pointer;font-size:11px}.toggle.empty{visibility:hidden}.var-value{color:var(--vscode-debugTokenExpression-value)}.var-type{color:var(--vscode-descriptionForeground);font-size:10px}.children{grid-column:1/-1}.children:empty{display:none}.child-wrap .var-row{border-left:1px solid var(--vscode-panel-border)}
    @media(max-width:520px){.main{grid-template-columns:1fr}.history{display:none}.var-row{grid-template-columns:minmax(95px,.9fr) minmax(95px,1.1fr)}.var-type{display:none}}
  </style></head><body><div class="context"><strong>Paused:</strong> ${frameLabel}</div><div class="main"><div class="result-pane">${expression}${resultLine}${rootRows ? `<div class="section-label">Fields</div><div class="tree">${rootRows}</div>` : ''}</div><aside class="history"><div class="section-label">History</div>${history || '<div class="idle" style="padding:8px">No evaluations</div>'}</aside></div><script nonce="${nonce}">
    const vscode=acquireVsCodeApi();
    document.addEventListener('click',event=>{
      const history=event.target.closest('[data-history]');
      if(history){vscode.postMessage({command:'history',index:Number(history.dataset.history)});return;}
      const button=event.target.closest('[data-ref]');
      if(!button)return;
      const id=button.dataset.node;const target=document.getElementById(id);if(!target)return;
      if(target.dataset.loaded==='true'){target.hidden=!target.hidden;button.textContent=target.hidden?'▸':'▾';return;}
      button.textContent='…';vscode.postMessage({command:'expand',nodeId:id,variablesReference:Number(button.dataset.ref)});
    });
    window.addEventListener('message',event=>{
      const message=event.data;if(message.command!=='expanded')return;
      const target=document.getElementById(message.nodeId);const button=document.querySelector('[data-node="'+message.nodeId+'"]');if(!target)return;
      target.innerHTML=(message.variables||[]).map((v,i)=>renderVar(v,message.nodeId+'-'+i,Number(target.dataset.depth||0)+1)).join('');target.dataset.loaded='true';target.hidden=false;if(button)button.textContent='▾';
    });
    function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function renderVar(v,id,depth){const ref=Number(v.variablesReference||0);const pad=depth*14;return '<div class="child-wrap"><div class="var-row"><div class="cell name" style="padding-left:'+(7+pad)+'px"><button class="toggle '+(ref?'':'empty')+'" data-ref="'+ref+'" data-node="'+id+'">▸</button><span title="'+esc(v.name)+'">'+esc(v.name)+'</span></div><div class="cell var-value" title="'+esc(v.value)+'">'+esc(v.value)+'</div><div class="cell var-type" title="'+esc(v.type||'')+'">'+esc(v.type||'')+'</div><div id="'+id+'" class="children" data-depth="'+depth+'" hidden></div></div></div>';}
  </script></body></html>`;
}

function renderEvaluateVariable(variable, nodeId, depth, escape) {
  const ref = Number(variable?.variablesReference || 0);
  const padding = 7 + depth * 14;
  return `<div class="child-wrap"><div class="var-row"><div class="cell name" style="padding-left:${padding}px"><button class="toggle ${ref ? '' : 'empty'}" data-ref="${ref}" data-node="${nodeId}">▸</button><span title="${escape(variable?.name)}">${escape(variable?.name)}</span></div><div class="cell var-value" title="${escape(variable?.value)}">${escape(formatDebugValue(variable?.value))}</div><div class="cell var-type" title="${escape(variable?.type || '')}">${escape(variable?.type || '')}</div><div id="${nodeId}" class="children" data-depth="${depth}" hidden></div></div></div>`;
}

function formatDebugValue(value) {
  const text = String(value ?? '');
  if (text === 'null') return 'null';
  return text;
}

async function evaluateCurrentExpression() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !debugEvaluateScratchUri || editor.document.uri.toString() !== debugEvaluateScratchUri.toString()) {
    throw new Error('Open the Evaluate Expression editor first with Alt+F8.');
  }

  const session = vscode.debug.activeDebugSession || debugEvaluateSession;
  if (!session || session.type !== 'java') throw new Error('The Java debug session has ended.');
  const frame = await resolveCurrentDebugFrame(session);
  if (!frame) throw new Error('Pause the debugger at a breakpoint before evaluating.');
  debugEvaluateSession = session;
  debugEvaluateFrameId = frame.id;
  debugEvaluateCurrentFrame = frame;

  const selection = editor.selection;
  let expression = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
  expression = expression
    .split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line) && !/^\s*import\s+/.test(line))
    .join('\n')
    .trim();
  if (!expression) throw new Error('Enter or select an expression to evaluate.');

  await ensureDebugEvaluateResultPanel();
  renderDebugEvaluateResult({ status: 'running', expression, frame });
  debugEvaluateOutput.appendLine(`\n> ${expression.replace(/\n/g, '\n  ')}`);
  vscode.window.setStatusBarMessage('$(sync~spin) Evaluating Java expression…');
  try {
    const result = await session.customRequest('evaluate', {
      expression,
      frameId: debugEvaluateFrameId,
      context: 'repl'
    });
    const variables = [];
    if (result?.variablesReference) {
      const response = await session.customRequest('variables', { variablesReference: result.variablesReference });
      variables.push(...(response?.variables || []).slice(0, 200));
    }
    const renderedResult = `${result?.result ?? ''}${result?.type ? `  (${result.type})` : ''}`;
    debugEvaluateOutput.appendLine(renderedResult || '(no value)');
    const successModel = {
      status: 'success', expression, frame,
      result: String(result?.result ?? ''), type: result?.type || '', variables
    };
    debugEvaluateHistory = [{ expression, model: successModel }, ...debugEvaluateHistory.filter(item => item.expression !== expression)].slice(0, 20);
    if (extensionContext) await extensionContext.workspaceState.update('debugEvaluateHistory', debugEvaluateHistory);
    renderDebugEvaluateResult(successModel);
    vscode.window.setStatusBarMessage(`$(check) ${String(result?.result ?? '').slice(0, 120) || '(no value)'}`, 5000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugEvaluateOutput.appendLine(`ERROR: ${message}`);
    const errorModel = { status: 'error', expression, message, frame };
    debugEvaluateHistory = [{ expression, model: errorModel }, ...debugEvaluateHistory.filter(item => item.expression !== expression)].slice(0, 20);
    if (extensionContext) await extensionContext.workspaceState.update('debugEvaluateHistory', debugEvaluateHistory);
    renderDebugEvaluateResult(errorModel);
    vscode.window.showErrorMessage(`Evaluate failed: ${message}`);
  }
}

class DebugEvaluateCompletionProvider {
  async provideCompletionItems(document, position) {
    if (!debugEvaluateScratchUri || document.uri.toString() !== debugEvaluateScratchUri.toString()) return undefined;
    const session = vscode.debug.activeDebugSession || debugEvaluateSession;
    if (!session || session.type !== 'java') return undefined;
    const frame = await resolveCurrentDebugFrame(session);
    if (!frame) return undefined;
    debugEvaluateSession = session;
    debugEvaluateFrameId = frame.id;

    const offset = document.offsetAt(position);
    const text = document.getText();
    const before = text.slice(0, offset);
    const line = position.line + 1;
    const column = position.character + 1;
    let response;
    try {
      response = await session.customRequest('completions', {
        frameId: debugEvaluateFrameId,
        text,
        line,
        column
      });
    } catch (_) {
      return undefined;
    }

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/)
      || new vscode.Range(position, position);
    return (response?.targets || []).slice(0, 250).map(target => {
      const item = new vscode.CompletionItem(target.label, vscode.CompletionItemKind.Method);
      item.detail = target.detail || target.type || 'Debug value';
      item.insertText = target.text || target.label;
      // Deliberately replace only the identifier under the cursor. The Java
      // debug adapter may report a range that includes the receiver expression.
      item.range = wordRange;
      item.sortText = target.sortText || target.label;
      return item;
    });
  }
}

async function resolveJavaProjectNameFromJavaExtension(filePath) {
  try {
    const projects = await vscode.commands.executeCommand('java.project.getAll');
    const candidates = collectJavaProjects(projects);
    const normalizedFile = normalizePath(filePath);
    const matches = candidates
      .map(project => ({ ...project, normalizedPath: project.path ? normalizePath(project.path) : '' }))
      .filter(project => project.name && project.normalizedPath && isPathInside(normalizedFile, project.normalizedPath))
      .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length);
    if (matches[0]?.name) {
      output.appendLine(`[debug] Java project resolved by language server: ${matches[0].name}`);
      return matches[0].name;
    }
    output.appendLine('[debug] Java project was not positively resolved; attaching without projectName.');
  } catch (error) {
    output.appendLine(`[debug] Java project lookup unavailable; attaching without projectName: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

function collectJavaProjects(value, results = []) {
  if (!value) return results;
  if (Array.isArray(value)) {
    for (const item of value) collectJavaProjects(item, results);
    return results;
  }
  if (typeof value !== 'object') return results;
  const name = value.name || value.projectName || value.displayName;
  const rawPath = value.path || value.projectPath || value.uri || value.location || value.rootPath;
  let projectPath;
  if (typeof rawPath === 'string') {
    try { projectPath = rawPath.startsWith('file:') ? vscode.Uri.parse(rawPath).fsPath : rawPath; } catch (_) { projectPath = rawPath; }
  }
  if (name && projectPath) results.push({ name: String(name), path: projectPath });
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectJavaProjects(child, results);
  }
  return results;
}

function deactivate() {
  if (runningProcess) terminateProcessTree(runningProcess);
  debugEvaluatePanel?.panel?.dispose();
  debugEvaluateResultPanel?.dispose();
  vscode.commands.executeCommand('setContext', 'compositeGradleTests.evaluateEditorActive', false);
}

module.exports = { activate, deactivate };

// Internal target command registration is kept outside the public manifest.
const originalActivate = module.exports.activate;
module.exports.activate = async function patchedActivate(context) {
  await originalActivate(context);
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests._runTarget', runProvidedTarget));
  projectTestsProvider = new ProjectTestsProvider(context);
  context.subscriptions.push(projectTestsProvider);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('compositeGradleTests.projectTestsView', projectTestsProvider));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.projectTests.refresh', () => projectTestsProvider.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.projectTests.run', item => runProjectTreeItem(item, false)));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.projectTests.debug', item => runProjectTreeItem(item, true)));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.projectTests.open', openProjectTreeItem));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.projectTests.runFailed', runFailedProjectTests));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.projectTests.runAffected', runAffectedTests));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.projectTests.clearAffected', clearAffectedTests));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'java', scheme: 'untitled' }, new DebugEvaluateCompletionProvider(), '.'));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    const active = !!editor && !!debugEvaluateScratchUri && editor.document.uri.toString() === debugEvaluateScratchUri.toString();
    vscode.commands.executeCommand('setContext', 'compositeGradleTests.evaluateEditorActive', active);
  }));
  context.subscriptions.push(vscode.workspace.onDidCreateFiles(() => projectTestsProvider.refresh()));
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles(() => projectTestsProvider.refresh()));
  context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => projectTestsProvider.refresh()));
};
