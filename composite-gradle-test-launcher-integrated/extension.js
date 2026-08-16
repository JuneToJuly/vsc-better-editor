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
let debugEvaluatePanelProvider;
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

  debugEvaluatePanelProvider = new DebugEvaluatePanelProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'compositeGradleTests.evaluateView',
    debugEvaluatePanelProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  ));

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
    projectName: resolveMappedJavaProjectName(documentUri.fsPath, root, config)
      || String(config.get('javaProjectName', '') || '').trim()
      || await resolveJavaProjectNameFromJavaExtension(documentUri.fsPath),
    showOutput: config.get('showOutput', false),
    documentUri: documentUri.toString(),
    sourcePath: documentUri.fsPath,
    scope: target.scope || (target.filter === target.classFilter ? 'class' : 'method'),
    classFilter: target.classFilter || target.filter,
    classDisplayName: target.classDisplayName || target.displayName,
    targetLine: target.range?.start?.line,
    targetCharacter: target.range?.start?.character,
    captureCoverage: config.get('captureExecutedCode', false),
    // Instrumentation packages are intentionally workspace-wide. Replay can cross
    // composite projects, so do not scope this list to the test source folder.
    // Folder-scoped reads introduced a regression where an empty folder value
    // shadowed the workspace package list.
    flowConfiguredPrefixes: flowPackagePrefixes()
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

function resolveMappedJavaProjectName(filePath, root, config) {
  const normalizedFile = normalizePath(path.resolve(filePath));
  const mappings = config.get('projects', []);
  let best;

  // Use the same longest-source-root matching rule as Gradle task resolution.
  // This keeps the debugger project aligned with the exact source file that
  // selected the Gradle task, including nested composite and multi-project builds.
  for (const mapping of mappings) {
    if (!mapping || typeof mapping.sourceRoot !== 'string') continue;
    const projectName = String(mapping.javaProjectName || mapping.projectName || '').trim();
    if (!projectName) continue;
    const sourceRoot = normalizePath(path.resolve(root, mapping.sourceRoot));
    if (isPathInside(normalizedFile, sourceRoot) && (!best || sourceRoot.length > best.sourceRoot.length)) {
      best = { sourceRoot, projectName };
    }
  }

  if (best) {
    output.appendLine(`[debug] Java project resolved by source mapping: ${best.projectName}`);
    return best.projectName;
  }
  return undefined;
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
    const configuredPrefixes = Array.isArray(invocation.flowConfiguredPrefixes)
      ? invocation.flowConfiguredPrefixes.map(normalizeFlowPrefix).filter(Boolean)
      : flowPackagePrefixes();
    const tracedPrefixes = [...new Set([testPackage, ...configuredPrefixes].map(normalizeFlowPrefix).filter(Boolean))];
    if (!tracedPrefixes.length) {
      throw new Error('Code Flow could not determine a package to trace. Configure compositeGradleTests.flowPackagePrefixes.');
    }
    flowArgs.splice(
      taskIndex >= 0 ? taskIndex : 0,
      0,
      `-Dcgtl.flow.output=${flowFile}`,
      `-Dcgtl.flow.agent=${agentJar}`,
      `-Dcgtl.flow.packages=${tracedPrefixes.join(',')}`,
      `-Dcgtl.flow.lineState=${String(vscode.workspace.getConfiguration('compositeGradleTests').get('flowLineState', 'receiver') || 'receiver')}`,
      `-Dcgtl.flow.lineState.maxDepth=${Number(vscode.workspace.getConfiguration('compositeGradleTests').get('flowLineStateMaxDepth', 2) || 2)}`,
      `-Dcgtl.flow.lineState.maxFields=${Number(vscode.workspace.getConfiguration('compositeGradleTests').get('flowLineStateMaxFields', 30) || 30)}`,
      `-Dcgtl.flow.lineState.maxCollectionItems=${Number(vscode.workspace.getConfiguration('compositeGradleTests').get('flowLineStateMaxCollectionItems', 20) || 20)}`
    );
    invocation = {
      ...invocation,
      flowDir,
      flowFile,
      captureFlow: true,
      flowAutomaticPackage: testPackage,
      flowConfiguredPrefixes: configuredPrefixes,
      flowTracedPrefixes: tracedPrefixes,
      args: flowArgs
    };
  }
  lastInvocation = invocation;
  output.clear();
  output.appendLine(`> ${formatCommand(invocation.executable, invocation.args)}`);
  output.appendLine(`cwd: ${invocation.cwd}`);
  if (invocation.captureFlow) {
    output.appendLine(`[CGTL FLOW] Automatic package: ${invocation.flowAutomaticPackage || '<none>'}`);
    output.appendLine(`[CGTL FLOW] Additional packages: ${(invocation.flowConfiguredPrefixes || []).join(', ') || '<none>'}`);
    const flowConfigScopes = flowPackagePrefixConfiguration().scopes;
    for (const entry of flowConfigScopes) {
      output.appendLine(`[CGTL FLOW] Package config ${entry.label}/${entry.scope}: ${entry.values.join(', ')}`);
    }
    output.appendLine(`[CGTL FLOW] Effective packages: ${(invocation.flowTracedPrefixes || []).join(', ') || '<none>'}`);
  }
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
  const reportCompleted = report.status === 'passed' || report.status === 'failed';
  if (!reportCompleted) {
    await recordResult(report);
    showResultsView(report);
    throw new Error('Code Report could not complete, so Analyze could not continue. See the recorded test result.');
  }
  const fingerprintMiddle = await createAnalysisFingerprint(baseInvocation);
  if (fingerprintMiddle !== fingerprintBefore) throw new Error('Source files changed during Code Report. Run Analyze again.');
  vscode.window.setStatusBarMessage('$(sync~spin) Composite Gradle: capturing code flow…');
  const flowInvocation = { ...baseInvocation, captureCoverage: false, captureFlow: true, analysisMode: 'flow' };
  const flow = await executeInvocationAndWait(flowInvocation);
  const flowCompleted = flow.status === 'passed' || flow.status === 'failed';
  if (!flowCompleted) {
    await recordResult(flow);
    showResultsView(flow);
    throw new Error('Code Flow could not complete, so Analyze could not merge the result. See the recorded test result.');
  }
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
    summary: report.summary || flow.summary,
    testOutput: [report.testOutput, flow.testOutput].filter(Boolean).join('\n'),
    failure: report.failure || flow.failure,
    failures: (report.failures && report.failures.length ? report.failures : flow.failures) || [],
    events: (report.events && report.events.length ? report.events : flow.events) || [],
    exitCode: report.exitCode !== 0 ? report.exitCode : flow.exitCode,
    reportStatus: report.status,
    flowStatus: flow.status,
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
  const analysisIcon = combined.status === 'failed' ? '$(testing-failed-icon)' : '$(check)';
  const analysisLabel = combined.status === 'failed' ? 'Analysis captured failed test' : 'Analysis complete';
  vscode.window.setStatusBarMessage(`${analysisIcon} ${analysisLabel}: ${combined.displayName}`, combined.status === 'failed' ? 8000 : 5000);
}

function normalizeFlowPrefix(value) {
  return String(value || '')
    .trim()
    .replace(/\.\*$/, '')
    .replace(/\.+$/, '');
}

function asFlowPrefixValues(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : String(value || '').split(',');
}

function flowPackagePrefixConfiguration() {
  // Instrumentation prefixes are additive. VS Code configuration normally uses
  // override semantics (folder > workspace > user), which is undesirable here:
  // a stale/empty value at one scope can hide packages configured at another.
  // Explicitly merge every scope, including every folder in a multi-root workspace.
  const values = [];
  const scopes = [];
  const seenScopes = new Set();

  const collectInspect = (inspect, label) => {
    if (!inspect) return;
    const entries = [
      ['default', inspect.defaultValue],
      ['global', inspect.globalValue],
      ['workspace', inspect.workspaceValue],
      ['folder', inspect.workspaceFolderValue]
    ];
    for (const [scope, raw] of entries) {
      const normalized = asFlowPrefixValues(raw).map(normalizeFlowPrefix).filter(Boolean);
      if (!normalized.length) continue;
      values.push(...normalized);
      const key = `${label}:${scope}:${normalized.join(',')}`;
      if (!seenScopes.has(key)) {
        seenScopes.add(key);
        scopes.push({ label, scope, values: normalized });
      }
    }
  };

  collectInspect(
    vscode.workspace.getConfiguration('compositeGradleTests').inspect('flowPackagePrefixes'),
    'workspace'
  );

  for (const folder of vscode.workspace.workspaceFolders || []) {
    collectInspect(
      vscode.workspace.getConfiguration('compositeGradleTests', folder.uri).inspect('flowPackagePrefixes'),
      folder.name
    );
  }

  return { values: [...new Set(values)], scopes };
}

function flowPackagePrefixes() {
  return flowPackagePrefixConfiguration().values;
}

function replayInstrumentationResource() {
  const replayPath = nativeReplaySession?.currentEvent?.sourcePath
    || nativeReplaySession?.lineEvents?.[nativeReplaySession?.position]?.sourcePath;
  if (replayPath) return vscode.Uri.file(replayPath);
  return vscode.window.activeTextEditor?.document?.uri;
}

function flowExcludePrefixes() {
  const config = vscode.workspace.getConfiguration('compositeGradleTests');
  const configured = config.get('flowExcludePrefixes', []);
  const values = Array.isArray(configured) ? configured : String(configured || '').split(',');
  return [...new Set(values.map(normalizeFlowPrefix).filter(Boolean))];
}

function flowPrefixMatches(className, prefix) {
  const name = String(className || '');
  const normalized = normalizeFlowPrefix(prefix);
  return !!normalized && (name === normalized || name.startsWith(normalized + '.') || name.startsWith(normalized + '$'));
}

function flowInstrumentationStatus(className) {
  const included = flowPackagePrefixes().some(prefix => flowPrefixMatches(className, prefix));
  return included ? 'included' : 'automatic';
}

async function updateFlowPrefixSetting(key, updater) {
  // Instrumentation configuration is workspace-wide. This deliberately mirrors
  // flowPackagePrefixes() so the UI edits the exact setting used by the launcher.
  const config = vscode.workspace.getConfiguration('compositeGradleTests');
  const current = config.get(key, []);
  const values = Array.isArray(current)
    ? current.map(normalizeFlowPrefix).filter(Boolean)
    : String(current || '').split(',').map(normalizeFlowPrefix).filter(Boolean);
  const next = [...new Set(updater(values).map(normalizeFlowPrefix).filter(Boolean))].sort();
  await config.update(key, next, vscode.ConfigurationTarget.Workspace);
  instrumentationProvider?.refresh();
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
def cgtlFlowExcludes = System.getProperty("cgtl.flow.excludes", "")
def cgtlFlowLineState = System.getProperty("cgtl.flow.lineState", "receiver")
def cgtlFlowLineStateMaxDepth = System.getProperty("cgtl.flow.lineState.maxDepth", "2")
def cgtlFlowLineStateMaxFields = System.getProperty("cgtl.flow.lineState.maxFields", "30")
def cgtlFlowLineStateMaxItems = System.getProperty("cgtl.flow.lineState.maxCollectionItems", "20")
def cgtlByteBuddyJar = new File(net.bytebuddy.ByteBuddy.protectionDomain.codeSource.location.toURI()).absolutePath
allprojects { project ->
    tasks.withType(org.gradle.api.tasks.testing.Test).configureEach { testTask ->
        if (cgtlFlowOutput && cgtlFlowAgent) {
            testTask.maxParallelForks = 1
            testTask.jvmArgs("-javaagent:" + cgtlFlowAgent)
            testTask.jvmArgs("-Xbootclasspath/a:" + cgtlByteBuddyJar)
            testTask.systemProperty("cgtl.flow.output", cgtlFlowOutput)
            testTask.systemProperty("cgtl.flow.maxEvents", "200000")
            testTask.systemProperty("cgtl.flow.packages", cgtlFlowPackages)
            testTask.systemProperty("cgtl.flow.excludes", cgtlFlowExcludes)
            testTask.systemProperty("cgtl.flow.lineState", cgtlFlowLineState)
            testTask.systemProperty("cgtl.flow.lineState.maxDepth", cgtlFlowLineStateMaxDepth)
            testTask.systemProperty("cgtl.flow.lineState.maxFields", cgtlFlowLineStateMaxFields)
            testTask.systemProperty("cgtl.flow.lineState.maxCollectionItems", cgtlFlowLineStateMaxItems)
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
    const events = fs.readFileSync(flowFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (_) { return undefined; }
    }).filter(Boolean).sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    const checkpoints = new Map();
    const hydrate = value => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(hydrate);
      if (value.snapshotRef) {
        const prior = checkpoints.get(String(value.snapshotRef));
        return prior ? { ...structuredClone(prior), __fromCheckpoint: true, __checkpointSequence: value.checkpointSequence } : value;
      }
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = hydrate(child);
      if (result.snapshotId) checkpoints.set(String(result.snapshotId), structuredClone(result));
      return result;
    };
    for (const event of events) {
      for (const key of ['frameReceiver','receiver','receiverAfter','callerReceiver','callerReceiverAfter','targetReceiver','returnValue','thrown']) {
        if (event[key] !== undefined) event[key] = hydrate(event[key]);
      }
      if (Array.isArray(event.arguments)) event.arguments = event.arguments.map(hydrate);
      if (event.frameLocals && typeof event.frameLocals === 'object') event.frameLocals = hydrate(event.frameLocals);
    }
    return events;
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
          // Document-symbol ranges can begin before the declaration (for
          // annotations, comments, or a fallback parser's wider method range).
          // selectionRange points at the actual method name and is therefore
          // the correct source-first location for an entry boundary.
          info = {
            sourcePath: uri.fsPath,
            sourceFile: path.basename(uri.fsPath),
            declarationLine: method.selectionRange.start.line + 1,
            endLine: Math.max(method.selectionRange.start.line + 1, method.range.end.line + 1)
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
      const boundaryLine = event.event === 'exit' ? info.endLine : info.declarationLine;
      enriched.push({
        ...event,
        sourcePath: info.sourcePath,
        sourceFile: event.sourceFile || info.sourceFile,
        line: boundaryLine,
        endLine: info.endLine,
        declarationLine: info.declarationLine,
        locationKind: event.event === 'exit' ? 'method-exit' : 'method-entry'
      });
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

function showLegacyFlowReplayPanel(result) {
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
  const allEvents = result.flowEvents || [];
  const rawEntries = allEvents.filter(event => event.event === 'enter' || event.event === 'line' || event.event === 'exit');
  const entries = [];
  const callerByCallId = new Map();
  for (const event of rawEntries) {
    if (event.event !== 'exit') continue;
    const callId = event.callId ?? event.call ?? event.invocationId;
    if (callId === undefined || callId === null) continue;
    if (event.callerClassName && Number(event.callerLine || 0) > 0 && event.callerSourcePath) callerByCallId.set(String(callId), event);
  }
  for (const originalEvent of rawEntries) {
    let event = originalEvent;
    if (event.event === 'enter') {
      const callId = event.callId ?? event.call ?? event.invocationId;
      const exitCaller = callId === undefined || callId === null ? null : callerByCallId.get(String(callId));
      if (exitCaller && (!event.callerSourcePath || Number(event.callerLine || 0) <= 0)) {
        event = { ...event,
          callerClassName: event.callerClassName || exitCaller.callerClassName,
          callerMethodName: event.callerMethodName || exitCaller.callerMethodName,
          callerSourceFile: event.callerSourceFile || exitCaller.callerSourceFile,
          callerSourcePath: event.callerSourcePath || exitCaller.callerSourcePath,
          callerLine: Number(event.callerLine || exitCaller.callerLine || 0),
          callerReceiver: event.callerReceiver || exitCaller.callerReceiver,
          callerArguments: event.callerArguments || exitCaller.callerArguments
        };
      }
    }
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
        calleeClassName: event.className,
        calleeMethodName: event.methodName,
        targetReceiver: event.receiver,
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
        calleeClassName: event.className,
        calleeMethodName: event.methodName,
        __synthetic: true
      });
    }
  }

  // A source-line callback at a method's first executable line can run one event
  // before Byte Buddy's entry Advice. At that instant Recorder.calls still points
  // at the caller, so the line is written with the caller's callId even though its
  // class/method/depth already identify the callee. The entry event is normally the
  // very next sequence number. Re-home that boundary line before grouping events,
  // otherwise line 2 appears to be the first line of the invocation and state diffs
  // miss mutations performed by line 1.
  const rawEventBySequence = new Map(entries.map(event => [Number(event.sequence), event]));
  for (const entry of entries) {
    if (entry.event !== 'enter') continue;
    const entrySequence = Number(entry.sequence);
    if (!Number.isFinite(entrySequence)) continue;
    const preceding = rawEventBySequence.get(entrySequence - 1);
    if (!preceding || preceding.event !== 'line') continue;
    const sameMethod = String(preceding.className || '') === String(entry.className || '')
      && String(preceding.methodName || '') === String(entry.methodName || '')
      && String(preceding.descriptor || '') === String(entry.descriptor || '');
    const sameThread = String(preceding.threadId ?? preceding.thread ?? '') === String(entry.threadId ?? entry.thread ?? '');
    const sameDepth = Number(preceding.depth || 0) === Number(entry.depth || 0);
    if (!sameMethod || !sameThread || !sameDepth) continue;
    const entryCallId = entry.callId ?? entry.call ?? entry.invocationId;
    if (entryCallId === undefined || entryCallId === null) continue;
    preceding.__originalCallId = preceding.callId ?? preceding.call ?? preceding.invocationId;
    preceding.callId = entryCallId;
    preceding.invocationId = entryCallId;
    preceding.__reassignedToEntry = true;
  }

  // Normalize method-boundary ordering against the ordered line stream.
  // ASM line callbacks can run before Byte Buddy method-entry Advice, so the raw
  // entry sequence may appear after the callee's first line. Replay must read:
  // caller line -> Call -> Entry -> callee lines -> Exit -> Resume.
  const eventsByInvocation = new Map();
  for (const event of entries) {
    const callId = event.callId ?? event.call ?? event.invocationId;
    if (callId === undefined || callId === null) continue;
    const key = String(callId);
    const group = eventsByInvocation.get(key) || [];
    group.push(event);
    eventsByInvocation.set(key, group);
  }
  for (const group of eventsByInvocation.values()) {
    const lines = group.filter(event => event.event === 'line');
    const entry = group.find(event => event.event === 'enter');
    const callsite = group.find(event => event.event === 'callsite');
    const exit = group.find(event => event.event === 'exit');
    const resume = group.find(event => event.event === 'resume');
    if (lines.length) {
      const firstLine = Math.min(...lines.map(event => Number(event.sequence ?? event.__index ?? 0)));
      const lastLine = Math.max(...lines.map(event => Number(event.sequence ?? event.__index ?? 0)));
      if (entry) entry.sequence = Math.min(Number(entry.sequence ?? firstLine), firstLine - 0.1);
      if (callsite) callsite.sequence = Math.min(Number(callsite.sequence ?? firstLine), firstLine - 0.2);
      if (exit) exit.sequence = Math.max(Number(exit.sequence ?? lastLine), lastLine + 0.1);
      if (resume) resume.sequence = Math.max(Number(resume.sequence ?? lastLine), Number(exit?.sequence ?? lastLine) + 0.1);
    } else {
      if (entry && callsite) callsite.sequence = Number(entry.sequence ?? 0) - 0.1;
      if (exit && resume) resume.sequence = Number(exit.sequence ?? 0) + 0.1;
    }
  }

  const entryByCallId = new Map();
  const exitByCallId = new Map();
  const stackByThread = new Map();
  for (const event of entries) {
    const callId = event.callId ?? event.call ?? event.invocationId;
    const threadKey = String(event.thread ?? event.threadId ?? 'main');
    if (event.event === 'enter') {
      if (callId !== undefined && callId !== null) entryByCallId.set(String(callId), event);
      const stack = stackByThread.get(threadKey) || [];
      stack.push(event);
      stackByThread.set(threadKey, stack);
    } else if (event.event === 'exit') {
      let entry;
      if (callId !== undefined && callId !== null) {
        exitByCallId.set(String(callId), event);
        entry = entryByCallId.get(String(callId));
      }
      const stack = stackByThread.get(threadKey) || [];
      if (!entry && stack.length) entry = stack[stack.length - 1];
      if (entry) {
        entry.__outcome = { returnValue: event.returnValue, thrown: event.thrown, receiverAfter: event.receiverAfter };
        event.__entrySnapshot = { receiver: entry.receiver, arguments: entry.arguments };
        const index = stack.lastIndexOf(entry);
        if (index >= 0) stack.splice(index, 1);
      }
    }
  }
  for (const event of entries) {
    if (event.event !== 'callsite' && event.event !== 'resume') continue;
    const callId = event.callId ?? event.call ?? event.invocationId;
    if (callId === undefined || callId === null) continue;
    const entry = entryByCallId.get(String(callId));
    const exit = exitByCallId.get(String(callId));
    if (entry) {
      event.targetReceiver = entry.receiver;
      event.arguments = entry.arguments;
      event.callerReceiver = entry.callerReceiver;
      event.callerArguments = entry.callerArguments;
    }
    if (exit) {
      event.receiverAfter = exit.receiverAfter;
      event.callerReceiverAfter = exit.callerReceiverAfter;
      event.callerArgumentsAfter = exit.callerArgumentsAfter;
      event.returnValue = exit.returnValue;
      event.thrown = exit.thrown;
    }
  }

  const normalized = value => normalizePath(value || '');
  const coverageByPath = new Map((result.executedCode || []).map(file => [normalized(file.sourcePath || file.relativePath), new Set(file.lines || [])]));
  const fileMap = new Map();
  const addFile = (sourcePath, fallbackName) => {
    if (!sourcePath || !fs.existsSync(sourcePath)) return;
    const key = normalized(sourcePath);
    if (fileMap.has(key)) return;
    let lines = [];
    try { lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/); } catch (_) { return; }
    fileMap.set(key, {
      sourcePath,
      name: path.basename(sourcePath) || fallbackName || 'Source',
      relativePath: vscode.workspace.asRelativePath(sourcePath, false),
      lines,
      coveredLines: [...(coverageByPath.get(key) || new Set())]
    });
  };
  for (const file of result.executedCode || []) addFile(file.sourcePath, path.basename(file.relativePath || ''));
  for (const event of entries) addFile(event.sourcePath, event.sourceFile);

  const enrichedEntries = entries.map((event, index) => ({ ...event, __index: index, sourcePath: event.sourcePath || '' }));
  for (const file of fileMap.values()) {
    file.eventsByLine = {};
    file.markerLines = {};
  }
  for (const event of enrichedEntries) {
    const file = fileMap.get(normalized(event.sourcePath));
    const line = Number(event.line || 0);
    if (!file || line <= 0) continue;
    (file.eventsByLine[line] ||= []).push(event.__index);
    const marker = file.markerLines[line] ||= { calls: 0, entries: 0, exits: 0, resumes: 0, changes: 0, exceptions: 0, events: 0 };
    marker.events++;
    if (event.event === 'callsite') marker.calls++;
    if (event.event === 'enter') marker.entries++;
    if (event.event === 'exit') marker.exits++;
    if (event.event === 'resume') marker.resumes++;
    if (event.thrown) marker.exceptions++;
    const before = event.callerReceiver || event.__entrySnapshot?.receiver || event.receiver;
    const after = event.callerReceiverAfter || event.receiverAfter;
    if (before && after && JSON.stringify(before) !== JSON.stringify(after)) marker.changes++;
  }

  const payload = JSON.stringify({
    events: enrichedEntries,
    files: [...fileMap.values()],
    title: result.displayName || 'Test'
  }).replace(/</g, '\\u003c');

  return `<!doctype html><html><head><meta charset="UTF-8"><style>
  *{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}button{font:inherit}
  .app{height:100vh;display:grid;grid-template-rows:auto auto 1fr;overflow:hidden}.topbar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground)}.topbar .title{font-weight:600;margin-right:12px}.tabs{display:flex;gap:2px}.tabs button,.action{border:1px solid transparent;background:transparent;color:var(--vscode-descriptionForeground);padding:5px 9px;border-radius:3px;cursor:pointer}.tabs button.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.action:hover,.tabs button:hover{background:var(--vscode-toolbar-hoverBackground)}
  .replay-controls{display:none;align-items:center;gap:7px;padding:2px 0;flex-wrap:wrap}.execution-graph.replay-active .replay-controls{display:flex}.execution-graph.replay-active .graph-title,.execution-graph.replay-active .graph-scroll{display:none}.replay-controls button,.replay-controls select{border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground,var(--vscode-editor-background));color:var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground));padding:4px 8px;border-radius:3px;cursor:pointer}.replay-controls button:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-toolbar-hoverBackground))}.replay-controls input[type=range]{flex:1;min-width:120px}.replay-status{min-width:150px;font-family:var(--vscode-editor-font-family);font-size:10px;color:var(--vscode-descriptionForeground)}.replay-search-wrap{display:flex;align-items:center;gap:3px;margin-left:auto}.replay-search{width:210px;min-width:120px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:4px 7px;border-radius:3px}.replay-search-status{min-width:38px;color:var(--vscode-descriptionForeground);font-size:9px;text-align:center}.replay-step.search-match{box-shadow:inset 3px 0 0 var(--vscode-editor-findMatchHighlightBackground)}.code-line .execution-count{margin-left:auto;padding:0 6px;color:var(--vscode-descriptionForeground);font-size:9px;font-family:var(--vscode-editor-font-family)}.replay-step{display:block;width:100%;border:0;border-bottom:1px solid var(--vscode-panel-border);background:transparent;color:inherit;text-align:left;padding:7px 9px;cursor:pointer}.replay-step:hover{background:var(--vscode-list-hoverBackground)}.replay-step.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.replay-step .seq{display:inline-block;min-width:48px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:9px}.replay-step b{font-family:var(--vscode-editor-font-family);font-size:10px}.replay-step small{display:block;margin-left:48px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.replay-callstack{display:flex;flex-wrap:wrap;gap:4px;margin:7px 0}.replay-frame{border:1px solid var(--vscode-panel-border);border-radius:3px;padding:3px 6px;font-family:var(--vscode-editor-font-family);font-size:9px;background:var(--vscode-editor-inactiveSelectionBackground)}.replay-current{border-left:3px solid var(--vscode-focusBorder)}
  .execution-graph{position:relative;border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-editorGroupHeader-tabsBackground) 82%,var(--vscode-editor-background));padding:7px 10px 8px;min-width:0;overflow:hidden}.graph-title{display:flex;align-items:center;gap:8px;margin-bottom:5px;color:var(--vscode-descriptionForeground);font-size:9px;text-transform:uppercase;letter-spacing:.08em}.graph-title strong{color:var(--vscode-editor-foreground);font-size:10px}.graph-search{margin-left:auto;width:min(320px,30vw);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:4px 7px;font-size:11px;text-transform:none;letter-spacing:normal;outline:none}.graph-search:focus{border-color:var(--vscode-focusBorder)}.graph-scroll{overflow-x:auto;overflow-y:hidden;scrollbar-gutter:stable;padding-bottom:3px}.graph-track{display:flex;align-items:stretch;gap:0;min-width:max-content}.graph-node{position:relative;display:flex;flex-direction:column;justify-content:center;min-width:150px;max-width:230px;padding:7px 10px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);text-align:left;cursor:pointer}.graph-node:hover{background:var(--vscode-list-hoverBackground)}.graph-node.active{border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.graph-node .node-kind{font-size:8px;text-transform:uppercase;letter-spacing:.09em;color:var(--vscode-descriptionForeground);margin-bottom:3px}.graph-node.active .node-kind{color:inherit;opacity:.75}.graph-node b{font-family:var(--vscode-editor-font-family);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.graph-node small{margin-top:2px;color:var(--vscode-descriptionForeground);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.graph-node.active small{color:inherit;opacity:.78}.graph-edge{display:flex;align-items:center;padding:0 6px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:14px}.graph-node.callsite{border-top-color:var(--vscode-textLink-foreground)}.graph-node.enter{border-top-color:var(--vscode-debugIcon-startForeground,var(--vscode-textLink-foreground))}.graph-node.exit{border-top-color:var(--vscode-testing-iconPassed)}.graph-node.resume{border-top-color:var(--vscode-symbolIcon-variableForeground,var(--vscode-textLink-foreground))}.graph-node.exception{border-top-color:var(--vscode-errorForeground)}.graph-node.search-match{box-shadow:inset 0 0 0 1px var(--vscode-editor-findMatchBorder,var(--vscode-focusBorder))}.graph-tooltip{position:fixed;z-index:1000;display:none;max-width:min(760px,75vw);min-width:360px;padding:9px 11px;border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-panel-border));background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-editor-foreground));box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none}.graph-tooltip.show{display:block}.tooltip-meta{font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px}.tooltip-code{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre-wrap;overflow-wrap:anywhere}
  .workspace{display:grid;grid-template-columns:245px minmax(420px,1fr) 355px;min-height:0;overflow:hidden}.pane{min-width:0;min-height:0;border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;overflow:hidden}.pane:last-child{border-right:0}.pane-head{padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-editor-background) 92%,var(--vscode-sideBar-background));flex:0 0 auto}.pane-head strong{display:block;font-size:12px}.pane-head small{display:block;color:var(--vscode-descriptionForeground);margin-top:2px;font-size:10px}.scroll{overflow:auto;min-height:0;flex:1;scrollbar-gutter:stable}
  .file-row,.event-row,.trace-row{width:100%;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.file-row{padding:9px 11px;border-left:2px solid transparent}.file-row:hover,.event-row:hover,.trace-row:hover{background:var(--vscode-list-hoverBackground)}.file-row.active,.event-row.active,.trace-row.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-left-color:var(--vscode-focusBorder)}.file-row b{display:block;font-family:var(--vscode-editor-font-family);font-size:12px}.file-row small{display:block;color:var(--vscode-descriptionForeground);font-size:10px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.file-meta{float:right;font-size:10px;color:var(--vscode-descriptionForeground)}
  .source-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorStickyScroll-background,var(--vscode-editor-background));flex:0 0 auto}.source-head b{font-family:var(--vscode-editor-font-family)}.source-head span{color:var(--vscode-descriptionForeground);font-size:10px}.code{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);line-height:1.55;white-space:pre;min-width:max-content;padding:8px 0 40vh}.code-line{display:grid;grid-template-columns:38px 42px minmax(max-content,1fr);min-height:22px;cursor:pointer;border-left:3px solid transparent;position:relative}.code-line:hover{background:var(--vscode-list-hoverBackground)}.code-line.covered{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 8%,transparent);border-left-color:color-mix(in srgb,var(--vscode-testing-iconPassed) 58%,transparent)}.code-line.covered:hover{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 13%,var(--vscode-list-hoverBackground))}.code-line.selected{background:color-mix(in srgb,var(--vscode-focusBorder) 24%,var(--vscode-editor-selectionBackground));border-left-color:var(--vscode-focusBorder);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--vscode-focusBorder) 48%,transparent)}.code-line.selected .src{opacity:1;font-weight:600}.code-line.covered .ln{color:var(--vscode-testing-iconPassed);font-weight:600}.gutter{display:flex;gap:3px;align-items:center;justify-content:flex-end;padding-right:6px;font-family:var(--vscode-font-family);font-size:9px}.g-marker{display:inline-flex;align-items:center;justify-content:center;min-width:12px;height:14px;line-height:14px}.g-call{color:var(--vscode-textLink-foreground)}.g-entry{color:var(--vscode-debugIcon-startForeground,var(--vscode-textLink-foreground))}.g-exit{color:var(--vscode-testing-iconPassed)}.g-resume{color:var(--vscode-symbolIcon-variableForeground,var(--vscode-textLink-foreground))}.g-change{color:var(--vscode-editorWarning-foreground)}.g-error{color:var(--vscode-errorForeground)}.ln{color:var(--vscode-editorLineNumber-foreground);text-align:right;padding-right:10px;user-select:none}.src{padding-right:18px}.code-line:not(.covered):not(.selected) .src{opacity:.58}
  .activity-head{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-bottom:1px solid var(--vscode-panel-border)}.activity-head .occ{font-size:10px;color:var(--vscode-descriptionForeground)}.occ-nav{display:flex;gap:4px}.occ-nav button{border:0;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:3px 7px;cursor:pointer}.event-row{padding:9px 11px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 60%,transparent);border-left:2px solid transparent}.event-row .kind{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground)}.event-row b{display:block;margin-top:3px;font-family:var(--vscode-editor-font-family);font-size:12px}.event-row small{display:block;margin-top:3px;color:var(--vscode-descriptionForeground);font-size:10px}.event-row.callsite .kind{color:var(--vscode-textLink-foreground)}.event-row.exit .kind{color:var(--vscode-testing-iconPassed)}.event-row.exception .kind{color:var(--vscode-errorForeground)}
  .context-card{padding:10px 11px;border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-editor-background) 94%,var(--vscode-sideBar-background))}.context-title{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin-bottom:6px}.crumbs{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-family:var(--vscode-editor-font-family);font-size:10px}.crumb{border:0;background:transparent;color:var(--vscode-textLink-foreground);padding:2px 3px;cursor:pointer}.crumb.current{color:var(--vscode-editor-foreground);font-weight:600}.crumb-sep{color:var(--vscode-descriptionForeground)}.context-strip{display:grid;grid-template-columns:1fr 1.2fr 1fr;gap:5px;margin-top:8px}.context-step{border:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-descriptionForeground);padding:6px 7px;text-align:left;min-width:0;cursor:pointer;border-radius:3px}.context-step:hover{background:var(--vscode-list-hoverBackground)}.context-step.current{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-color:var(--vscode-focusBorder)}.context-step b,.context-step small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.context-step b{font-family:var(--vscode-editor-font-family);font-size:10px}.context-step small{font-size:9px;margin-top:2px;opacity:.8}.context-summary{margin-top:8px;padding:7px 8px;border-left:2px solid var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-editor-background) 90%,var(--vscode-list-hoverBackground));font-size:10px;line-height:1.45}.detail{padding:11px}.detail h3{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin:12px 0 6px}.kv{display:grid;grid-template-columns:minmax(80px,auto) 1fr;gap:8px;padding:3px 0;font-family:var(--vscode-editor-font-family);font-size:11px}.kv .key{color:var(--vscode-symbolIcon-variableForeground,var(--vscode-textLink-foreground))}.value-tree{margin:2px 0 2px 8px;border-left:1px solid var(--vscode-panel-border);padding-left:8px}.value-tree>summary{cursor:pointer;color:var(--vscode-descriptionForeground);list-style:none}.value-tree>summary::-webkit-details-marker{display:none}.value-tree>summary:before{content:'▸';display:inline-block;width:12px}.value-tree[open]>summary:before{content:'▾'}.value-tree .kv{font-size:10px}.kv.changed{background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 12%,transparent);padding:4px 6px}.empty{padding:16px;color:var(--vscode-descriptionForeground);font-size:11px}.trace-row{padding:7px 10px;border-left:2px solid transparent;font-family:var(--vscode-editor-font-family)}.trace-row b{font-size:11px}.trace-row small{display:block;color:var(--vscode-descriptionForeground);font-size:9px;margin-top:2px}.badge{float:right;color:var(--vscode-descriptionForeground);font-size:9px}
  @media(max-width:1000px){.workspace{grid-template-columns:205px minmax(360px,1fr) 300px}}@media(max-width:760px){.workspace{grid-template-columns:180px 1fr}.activity-pane{position:absolute;right:0;top:44px;bottom:0;width:min(360px,70vw);background:var(--vscode-editor-background);box-shadow:-5px 0 12px #0005}}

  .full-graph{grid-row:3;display:none;min-height:0;overflow:hidden;background:var(--vscode-editor-background)}.workspace{grid-row:3}.full-graph.active{display:grid;grid-template-rows:auto 1fr}.full-graph-toolbar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground)}.full-graph-toolbar>div{display:flex;flex-direction:column;margin-right:auto}.full-graph-toolbar small{color:var(--vscode-descriptionForeground)}.full-graph-toolbar label{display:flex;align-items:center;gap:5px;color:var(--vscode-descriptionForeground);font-size:11px}.full-graph-toolbar button{border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:4px 8px;cursor:pointer}.full-graph-body{min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 420px}.full-graph-body.inspector-collapsed{grid-template-columns:minmax(0,1fr) 0}.full-graph-body.inspector-collapsed .graph-inspector{display:none}.full-graph-canvas{position:relative;overflow:auto;min-width:0;background-image:radial-gradient(circle,var(--vscode-editorIndentGuide-background) 1px,transparent 1px);background-size:20px 20px}.full-graph-canvas svg{display:block;min-width:100%;min-height:100%}.graph-inspector{min-height:0;border-left:1px solid var(--vscode-panel-border);display:grid;grid-template-rows:auto 1fr}.fg-edge{stroke:var(--vscode-descriptionForeground);stroke-width:1.4;fill:none;marker-end:url(#fgArrow);opacity:.65}.fg-edge.repeat{stroke-dasharray:5 4}.fg-node{cursor:pointer}.fg-node rect{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-panel-border);stroke-width:1.2;rx:6}.fg-node.method rect{stroke:var(--vscode-focusBorder);stroke-width:1.5}.fg-node.line rect{fill:color-mix(in srgb,var(--vscode-testing-iconPassed) 10%,var(--vscode-editorWidget-background));stroke:color-mix(in srgb,var(--vscode-testing-iconPassed) 55%,var(--vscode-panel-border))}.fg-node.call rect{stroke:var(--vscode-symbolIcon-methodForeground)}.fg-node.exception rect{stroke:var(--vscode-testing-iconFailed);stroke-width:2}.fg-node:hover rect,.fg-node.selected rect{fill:var(--vscode-list-hoverBackground);stroke:var(--vscode-focusBorder);stroke-width:2}.fg-node text{fill:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:11px;pointer-events:none}.fg-node .fg-context{fill:var(--vscode-descriptionForeground);font-size:9px}.fg-node .fg-outcome{fill:var(--vscode-testing-iconPassed);font-size:9px}.fg-node.exception .fg-outcome{fill:var(--vscode-testing-iconFailed)}.fg-node .fg-kind{fill:var(--vscode-descriptionForeground);font-size:8px;text-transform:uppercase}.fg-count{fill:var(--vscode-badge-background);stroke:none}.fg-count-text{fill:var(--vscode-badge-foreground);font-size:9px;text-anchor:middle}.graph-inspector .detail{padding:10px}.graph-inspector .source-preview{margin:8px 0;padding:9px;border:1px solid var(--vscode-panel-border);background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);white-space:pre-wrap}.graph-legend{display:flex;gap:10px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);font-size:10px;color:var(--vscode-descriptionForeground)}

  .activity-pane .pane-head{padding-bottom:8px}.activity-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-editor-background) 96%,var(--vscode-sideBar-background))}.occ-nav{display:flex;gap:4px}.occ-nav button{border:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-editor-foreground);border-radius:3px;padding:3px 7px;cursor:pointer}.occ-nav button:hover{background:var(--vscode-toolbar-hoverBackground)}
  .detail.replay-current{border-left:0;padding:0 12px 18px}.replay-summary{margin:10px 0 4px;padding:9px 10px;border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-focusBorder);border-radius:4px;background:color-mix(in srgb,var(--vscode-editor-background) 94%,var(--vscode-sideBar-background))}.replay-summary strong{display:block;font-family:var(--vscode-editor-font-family);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.replay-summary small{display:block;margin-top:3px;color:var(--vscode-descriptionForeground);font-size:9px}.section{margin-top:13px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;padding-bottom:5px;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 70%,transparent)}.section-head strong{font-size:10px;text-transform:uppercase;letter-spacing:.08em}.section-head span{color:var(--vscode-descriptionForeground);font-size:9px}.state-card{border:1px solid var(--vscode-panel-border);border-radius:4px;overflow:hidden;background:color-mix(in srgb,var(--vscode-editor-background) 97%,var(--vscode-sideBar-background))}.state-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 9px;border-bottom:1px solid var(--vscode-panel-border)}.state-card-head b{font-family:var(--vscode-editor-font-family);font-size:11px}.state-card-head small{min-width:0;color:var(--vscode-descriptionForeground);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.state-fields{padding:5px 9px 8px;overflow-x:auto;scrollbar-width:thin}.state-fields>.kv{padding:4px 0;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 40%,transparent)}.state-fields>.kv:last-child{border-bottom:0}.state-empty{padding:9px;color:var(--vscode-descriptionForeground);font-size:10px}.detail .kv{grid-template-columns:minmax(86px,34%) minmax(150px,1fr);align-items:start;gap:8px;padding:3px 0}.kv .key{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kv .value{min-width:150px;overflow-wrap:normal;word-break:normal}.scalar{display:inline-block;max-width:100%;font-family:var(--vscode-editor-font-family);white-space:normal;overflow-wrap:anywhere}.scalar.string:before,.scalar.string:after{content:'"';opacity:.55}.scalar.nullish{color:var(--vscode-descriptionForeground);font-style:italic}.value-tree{margin:0;border-left:0;padding-left:0;min-width:max-content}.value-tree>summary{display:flex;align-items:center;gap:5px;min-height:20px;min-width:210px;color:var(--vscode-editor-foreground);white-space:nowrap}.value-tree>summary:before{flex:0 0 12px;color:var(--vscode-descriptionForeground)}.value-tree .object-label{flex:0 0 auto;font-family:var(--vscode-editor-font-family);white-space:nowrap}.value-tree .object-meta{margin-left:8px;color:var(--vscode-descriptionForeground);font-size:9px;white-space:nowrap}.value-tree .tree-body{margin:3px 0 2px 4px;padding:2px 0 2px 7px;border-left:1px solid color-mix(in srgb,var(--vscode-panel-border) 55%,transparent)}.value-tree .tree-body>.kv{grid-template-columns:minmax(82px,110px) minmax(150px,1fr);padding:3px 0}.value-tree .tree-body .value-tree{min-width:220px}.change-list{display:flex;flex-direction:column;gap:5px}.change-row{padding:7px 8px;border-left:3px solid var(--vscode-editorWarning-foreground);border-radius:3px;background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 9%,transparent)}.change-path{font-family:var(--vscode-editor-font-family);font-size:10px;font-weight:600}.change-values{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:6px;margin-top:4px;font-family:var(--vscode-editor-font-family);font-size:10px}.change-before{color:var(--vscode-descriptionForeground);text-decoration:line-through;overflow-wrap:anywhere}.change-arrow{color:var(--vscode-editorWarning-foreground)}.change-after{overflow-wrap:anywhere}.no-changes{padding:8px 9px;border:1px dashed var(--vscode-panel-border);border-radius:3px;color:var(--vscode-descriptionForeground);font-size:10px}.state-breadcrumbs{display:flex;flex-wrap:wrap;gap:3px;margin:5px 0 8px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:9px}.state-breadcrumbs span:not(:last-child):after{content:'›';padding-left:3px;opacity:.6}.collection-count{color:var(--vscode-descriptionForeground);font-size:9px}.map-entry{display:grid;grid-template-columns:minmax(92px,130px) minmax(150px,1fr);gap:8px;min-width:250px;padding:3px 0}.map-key{font-family:var(--vscode-editor-font-family);color:var(--vscode-symbolIcon-variableForeground,var(--vscode-textLink-foreground));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.map-entry>.value{min-width:150px}.metadata-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 10px;margin:7px 0 2px}.metadata-grid .kv{grid-template-columns:auto minmax(0,1fr);font-size:9px;color:var(--vscode-descriptionForeground)}
  </style></head><body><div class="app"><div class="topbar"><span class="title">Execution Replay</span><div class="tabs"><button id="sourceTab" class="active">Source</button><button id="replayTab">Replay</button><button id="callsTab">Call Tree</button><button id="timelineTab">Timeline</button><button id="changesTab">Changes</button><button id="graphTab">Graph</button></div><span style="flex:1"></span><button class="action" id="openSource">Open source</button></div><section class="execution-graph" id="executionGraph"><div class="replay-controls" id="replayControls"><button id="replayStart" title="First step">|←</button><button id="replayPrev" title="Previous recorded line">←</button><button id="replayInto" title="Step Into — next recorded line">↓ Into</button><button id="replayOver" title="Step Over — skip child invocations">↷ Over</button><button id="replayOut" title="Step Out — return to caller">↑ Out</button><button id="replayPlay" title="Play or pause">▶</button><button id="replayEnd" title="Last step">→|</button><input id="replaySlider" type="range" min="0" max="0" value="0" aria-label="Replay position"><span class="replay-status" id="replayStatus">No line events</span><div class="replay-search-wrap"><input id="replaySearch" class="replay-search" type="search" spellcheck="false" placeholder="Search replay…" aria-label="Search replay"><span id="replaySearchStatus" class="replay-search-status"></span><button id="replaySearchPrev" title="Previous search result">↑</button><button id="replaySearchNext" title="Next search result">↓</button></div><select id="replaySpeed" aria-label="Replay speed"><option value="1000">1×</option><option value="500" selected>2×</option><option value="250">4×</option><option value="100">10×</option></select></div><div class="graph-title"><strong>Execution path</strong><span id="graphHint">Select a runtime event to inspect its call path.</span><input id="graphSearch" class="graph-search" type="search" spellcheck="false" placeholder="Search methods or source lines…" aria-label="Search execution path"></div><div class="graph-scroll" id="graphScroll"><div class="graph-track" id="graphTrack"></div></div><div class="graph-tooltip" id="graphTooltip"></div></section><div class="full-graph" id="fullGraph"><div class="full-graph-toolbar"><div><strong>Execution graph</strong><small>Methods connected to the methods they called in this exact test run. <span id="graphStats"></span></small></div><label><input id="graphCollapseRepeats" type="checkbox" checked> Collapse repeated calls</label><button id="graphFit">Fit</button><button id="graphZoomOut">−</button><button id="graphZoomIn">+</button><button id="graphToggleInspector">Hide details</button></div><div class="full-graph-body" id="fullGraphBody"><div class="full-graph-canvas" id="fullGraphCanvas"><svg id="fullGraphSvg" role="img" aria-label="Execution graph"></svg></div><aside class="graph-inspector"><div class="pane-head"><strong id="graphInspectorTitle">Select a node</strong><small id="graphInspectorHint">Click a method or line node to inspect its source and runtime data.</small></div><div class="scroll" id="graphInspector"></div></aside></div></div><div class="workspace" id="sourceWorkspace"><aside class="pane"><div class="pane-head"><strong id="leftTitle">Executed files</strong><small id="leftHint">Choose the code you want to investigate.</small></div><div class="scroll" id="leftList"></div></aside><main class="pane"><div class="source-head"><div><b id="fileName">Select a file</b><span id="filePath"></span></div><span id="lineSummary"></span></div><div class="scroll" id="sourceScroll"><div class="code" id="code"></div></div></main><aside class="pane activity-pane"><div class="pane-head"><strong id="activityTitle">What happened here</strong><small id="activityHint">Select an executed line to inspect its runtime activity.</small></div><div class="activity-head"><span class="occ" id="occurrence"></span><div class="occ-nav"><button id="prevOcc">←</button><button id="nextOcc">→</button></div></div><div class="scroll" id="activity"></div></aside></div></div><script>
  const vscode=acquireVsCodeApi();const model=${payload};let mode='source';let fileIndex=0;let selectedLine=0;let occurrenceIndex=0;let selectedEventIndex=-1;const replayEvents=model.events.filter(e=>e.event==='line').slice().sort((a,b)=>Number(a.sequence??a.__index)-Number(b.sequence??b.__index)||a.__index-b.__index);let replayPosition=0;let replayTimer=null;let replaySearchMatches=[];let replaySearchCursor=-1;
  const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  const simple=e=>String(e.className||'').split('.').pop()||'Unknown';
  const eventLabel=e=>e.event==='callsite'?'Call '+String(e.calleeClassName||'').split('.').pop()+'.'+e.calleeMethodName+'()':e.event==='enter'?'Enter '+simple(e)+'.'+e.methodName+'()':e.event==='exit'?(e.thrown?'Exception from ':'Exit ')+simple(e)+'.'+e.methodName+'()':e.event==='resume'?'Resume '+simple(e)+'.'+e.methodName+'()':'Line '+e.line;
  const eventKind=e=>e.event==='callsite'?'Call':e.event==='enter'?'Entry':e.event==='exit'?(e.thrown?'Exception':'Exit'):e.event==='resume'?'Resume':'Line';
  const valueText=v=>{if(v===undefined)return 'not available';if(v===null)return 'null';if(typeof v==='string'||typeof v==='number'||typeof v==='boolean')return String(v);if(v.display!==undefined)return String(v.display);if(v.value!==undefined&&typeof v.value!=='object')return String(v.value);if(v.summary!==undefined)return String(v.summary);if(Array.isArray(v))return '['+v.map(valueText).join(', ')+']';const type=objectType(v);return type+(objectCount(v)!==null?' ('+objectCount(v)+')':'')};
  const fieldsOf=s=>{if(!s||typeof s!=='object')return {};if(s.fields&&typeof s.fields==='object'&&!Array.isArray(s.fields))return s.fields;const out={};for(const[k,v]of Object.entries(s)){if(!['type','className','display','identity','identityHash','id','value','summary','size','items','entries','snapshotId','checkpointSequence','__fromCheckpoint','__checkpointSequence'].includes(k))out[k]=v}return out};
  const objectType=v=>{const raw=String(v?.type||v?.className||v?.summary||'Object');return raw.includes('@')?raw.slice(0,raw.indexOf('@')).split('.').pop():raw.split('.').pop()};
  const objectIdentity=v=>String(v?.identity||v?.identityHash||v?.id||v?.summary||'').match(/@([0-9a-fA-F]+)/)?.[1]||'';
  const objectCount=v=>v?.size!==undefined?Number(v.size):Array.isArray(v?.items)?v.items.length:Array.isArray(v?.entries)?v.entries.length:null;
  function section(root,title,count,cls=''){const wrap=document.createElement('section');wrap.className='section '+cls;const head=document.createElement('div');head.className='section-head';head.innerHTML='<strong>'+esc(title)+'</strong>'+(count!==undefined?'<span>'+esc(count)+'</span>':'');wrap.appendChild(head);root.appendChild(wrap);return wrap}
  function scalarNode(value){const span=document.createElement('span');span.className='scalar '+(value===null||value===undefined?'nullish':typeof value==='string'?'string':'');span.textContent=valueText(value);return span}
  function entryParts(entry,index){if(entry&&typeof entry==='object'){if('key' in entry&&'value' in entry)return [entry.key,entry.value];const f=fieldsOf(entry);if('key' in f&&'value' in f)return [f.key,f.value];if(Array.isArray(entry)&&entry.length>=2)return [entry[0],entry[1]]}return ['['+index+']',entry]}
  function renderValue(root,value,depth=0){root.classList.add('value');if(value===undefined||value===null||typeof value!=='object'){root.appendChild(scalarNode(value));return}const fields=fieldsOf(value),items=Array.isArray(value.items)?value.items:null,entries=Array.isArray(value.entries)?value.entries:null;const hasChildren=Object.keys(fields).length||items?.length||entries?.length;if(!hasChildren||depth>=6){root.appendChild(scalarNode(value));return}const details=document.createElement('details');details.className='value-tree';const summary=document.createElement('summary');const label=document.createElement('span');label.className='object-label';label.textContent=objectType(value);summary.appendChild(label);const count=objectCount(value),identity=objectIdentity(value);const meta=document.createElement('span');meta.className='object-meta';meta.textContent=(count!==null?count+' item'+(count===1?'':'s'):'')+(identity?(count!==null?' · ':'')+'id '+identity:'');if(identity)summary.title='Object identity: '+identity;summary.appendChild(meta);details.appendChild(summary);const body=document.createElement('div');body.className='tree-body';for(const[k,v]of Object.entries(fields))kv(body,k,v,'',depth+1);if(items)items.forEach((v,i)=>kv(body,'['+i+']',v,'',depth+1));if(entries)entries.forEach((entry,i)=>{const [key,val]=entryParts(entry,i);const row=document.createElement('div');row.className='map-entry';const k=document.createElement('span');k.className='map-key';k.textContent=valueText(key);const vr=document.createElement('span');renderValue(vr,val,depth+1);row.append(k,vr);body.appendChild(row)});details.appendChild(body);root.appendChild(details)}
  function kv(root,key,value,cls,depth=0){const row=document.createElement('div');row.className='kv '+(cls||'');const keySpan=document.createElement('span');keySpan.className='key';keySpan.textContent=key;keySpan.title=key;const valueSpan=document.createElement('span');row.appendChild(keySpan);row.appendChild(valueSpan);renderValue(valueSpan,value,depth);root.appendChild(row);return row}
  function snapshot(root,title,s,options={}){const wrap=section(root,title,options.count,'state-section '+(options.focusHidden?'focus-hidden':''));if(!s){wrap.insertAdjacentHTML('beforeend','<div class="state-empty">Not available</div>');return wrap}const card=document.createElement('div');card.className='state-card';const head=document.createElement('div');head.className='state-card-head';const type=objectType(s),identity=objectIdentity(s);head.innerHTML='<b>'+esc(options.label||'this')+'</b><small>'+esc(type)+(identity?' · id '+esc(identity):'')+'</small>';card.appendChild(head);const fields=document.createElement('div');fields.className='state-fields';const values=fieldsOf(s);if(Object.keys(values).length){for(const[k,v]of Object.entries(values))kv(fields,k,v)}else kv(fields,options.label||'this',s);card.appendChild(fields);wrap.appendChild(card);return wrap}
  function collectChanges(before,after,prefix='',depth=0,out=[]){if(depth>4)return out;if(before===after)return out;if(before===null||after===null||before===undefined||after===undefined||typeof before!=='object'||typeof after!=='object'){if(valueText(before)!==valueText(after))out.push({path:prefix||'value',before:valueText(before),after:valueText(after)});return out}const bf=fieldsOf(before),af=fieldsOf(after),keys=new Set([...Object.keys(bf),...Object.keys(af)]);for(const k of keys){const path=prefix?prefix+'.'+k:k;const a=bf[k],b=af[k];if(a&&b&&typeof a==='object'&&typeof b==='object')collectChanges(a,b,path,depth+1,out);else if(valueText(a)!==valueText(b))out.push({path,before:valueText(a),after:valueText(b)})}return out}
  function renderChanges(root,title,changes,emptyText='No captured state changed since the previous line in this invocation.'){const wrap=section(root,title,changes.length?changes.length+' change'+(changes.length===1?'':'s'):'No changes','changes-section');if(!changes.length){wrap.insertAdjacentHTML('beforeend','<div class="no-changes">'+esc(emptyText)+'</div>');return wrap}const list=document.createElement('div');list.className='change-list';for(const change of changes){const row=document.createElement('div');row.className='change-row';row.innerHTML='<div class="change-path">'+esc(change.path)+'</div><div class="change-values"><span class="change-before">'+esc(change.before)+'</span><span class="change-arrow">→</span><span class="change-after">'+esc(change.after)+'</span></div>';list.appendChild(row)}wrap.appendChild(list);return wrap}
  function diff(root,before,after){renderChanges(root,'Changes',collectChanges(before,after),'No receiver fields changed.')}
  function eventsForLine(file,line){return (file?.eventsByLine?.[line]||[]).map(i=>model.events[i]).filter(Boolean)}
  function chooseFile(i){fileIndex=Math.max(0,Math.min(model.files.length-1,i));const f=model.files[fileIndex];const eventLines=Object.keys(f?.eventsByLine||{}).map(Number).sort((a,b)=>a-b);selectedLine=eventLines[0]||f?.coveredLines?.[0]||1;occurrenceIndex=0;selectedEventIndex=-1;render()}
  function replayOccurrences(sourcePath,line){return replayEvents.map((e,i)=>({e,i})).filter(x=>x.e.sourcePath===sourcePath&&Number(x.e.line||0)===Number(line||0)).map(x=>x.i)}
  function seekReplayLine(sourcePath,line,which='first'){const matches=replayOccurrences(sourcePath,line);if(!matches.length)return false;const target=which==='last'?matches[matches.length-1]:matches[0];if(mode!=='replay')setMode('replay');setReplayPosition(target);return true}
  function chooseLine(line){selectedLine=Number(line);occurrenceIndex=0;const f=model.files[fileIndex];if(seekReplayLine(f?.sourcePath,selectedLine,'first'))return;const ev=eventsForLine(f,selectedLine);selectedEventIndex=ev[0]?.__index??-1;renderSource();renderActivity();}
  function renderFiles(){const root=document.getElementById('leftList');root.innerHTML='';model.files.forEach((f,i)=>{const b=document.createElement('button');b.className='file-row '+(i===fileIndex?'active':'');const eventCount=Object.values(f.eventsByLine||{}).reduce((a,v)=>a+v.length,0);b.innerHTML='<span class="file-meta">'+eventCount+' events</span><b>'+esc(f.name)+'</b><small>'+esc(f.relativePath)+'</small>';b.onclick=()=>chooseFile(i);root.appendChild(b)})}
  function renderSource(){const f=model.files[fileIndex];document.getElementById('fileName').textContent=f?.name||'No source';document.getElementById('filePath').textContent=f?'  ·  '+f.relativePath:'';document.getElementById('lineSummary').textContent=f&&selectedLine?'line '+selectedLine:'';const root=document.getElementById('code');root.innerHTML='';if(!f){root.innerHTML='<div class="empty">No source files were captured.</div>';return}const covered=new Set(f.coveredLines||[]);for(let i=0;i<f.lines.length;i++){const line=i+1,m=f.markerLines?.[line]||{};const isCovered=covered.has(line);const row=document.createElement('div');row.className='code-line '+(isCovered?'covered ':'')+(line===selectedLine?'selected':'');const icons=[];if(m.calls)icons.push('<span class="g-marker g-call" title="'+m.calls+' call event(s)">◇'+(m.calls>1?m.calls:'')+'</span>');if(m.entries)icons.push('<span class="g-marker g-entry" title="Method entry">▶</span>');if(m.exits)icons.push('<span class="g-marker g-exit" title="Method exit">↩</span>');if(m.resumes)icons.push('<span class="g-marker g-resume" title="Caller resumes">←</span>');if(m.changes)icons.push('<span class="g-marker g-change" title="State changed">Δ</span>');if(m.exceptions)icons.push('<span class="g-marker g-error" title="Exception">⚠</span>');if(!icons.length&&m.events>1)icons.push('<span class="g-marker">'+m.events+'</span>');const summary=[];if(isCovered)summary.push('Executed');if(m.calls)summary.push(m.calls+' call'+(m.calls===1?'':'s'));if(m.entries)summary.push(m.entries+' entr'+(m.entries===1?'y':'ies'));if(m.exits)summary.push(m.exits+' exit'+(m.exits===1?'':'s'));if(m.resumes)summary.push(m.resumes+' resume'+(m.resumes===1?'':'s'));if(m.changes)summary.push('state changed');if(m.exceptions)summary.push('exception');row.title=summary.length?('Line '+line+': '+summary.join(' · ')):('Line '+line);const replayCount=replayOccurrences(f.sourcePath,line).length;row.innerHTML='<span class="gutter">'+icons.join('')+'</span><span class="ln">'+line+'</span><span class="src">'+esc(f.lines[i])+'</span>'+(replayCount?'<span class="execution-count">'+replayCount+'×</span>':'');row.onclick=()=>chooseLine(line);root.appendChild(row)}requestAnimationFrame(()=>document.querySelector('.code-line.selected')?.scrollIntoView({block:'center',behavior:'smooth'}))}
  function callPathAt(eventIndex){const stack=[];for(const e of model.events){if(e.__index>eventIndex)break;if(e.event==='enter')stack.push(e);else if(e.event==='exit'){const id=String(e.callId??e.call??e.invocationId??'');let idx=-1;if(id){idx=stack.map(x=>String(x.callId??x.call??x.invocationId??'')).lastIndexOf(id)}if(idx<0)idx=stack.length-1;if(idx>=0)stack.splice(idx,1)} }return stack}
  function eventContextText(e){if(e.event==='callsite')return 'The caller is about to invoke '+eventLabel(e)+'. Inspect caller state before the call and compare it with the resume boundary.';if(e.event==='enter')return 'Execution has entered '+eventLabel(e)+'. This is the callee frame with its receiver and arguments.';if(e.event==='exit')return e.thrown?'The method exits by throwing an exception.':'The method has completed. Inspect receiver mutations and the returned value.';if(e.event==='resume')return 'Control has returned to the caller at this source line. Compare caller state before and after the nested call.';return 'Runtime activity associated with the selected source line.'}
  function eventCallId(e){return String(e?.callId??e?.call??e?.invocationId??'')}
  function findCallSiteForEntry(entry){const id=eventCallId(entry);if(!id)return null;for(let i=entry.__index-1;i>=0;i--){const e=model.events[i];if(e.event==='callsite'&&eventCallId(e)===id)return e}return null}
  function graphNodeTitle(e){if(e.event==='callsite'){const f=model.files.find(x=>x.sourcePath===e.sourcePath);const text=f?.lines?.[Math.max(0,Number(e.line||1)-1)]?.trim();return text||('Call '+eventLabel(e))}if(e.event==='resume'){const f=model.files.find(x=>x.sourcePath===e.sourcePath);const text=f?.lines?.[Math.max(0,Number(e.line||1)-1)]?.trim();return text||('Resume '+eventLabel(e))}return eventLabel(e)}
  function graphNodeKind(e){if(e.thrown)return 'Exception';if(e.event==='callsite')return 'Call site';if(e.event==='enter')return 'Method';if(e.event==='exit')return 'Return';if(e.event==='resume')return 'Resume';return 'Execution'}
  function sourceLineForEvent(e){const f=model.files.find(x=>x.sourcePath===e?.sourcePath);const line=Number(e?.line||0);return f&&line>0?String(f.lines[line-1]||'').trim():''}
  function graphSearchText(e){return [graphNodeKind(e),graphNodeTitle(e),eventLabel(e),e.className,e.methodName,e.calleeClassName,e.calleeMethodName,e.sourceFile,e.sourcePath,e.line,sourceLineForEvent(e)].filter(Boolean).join(' ').toLowerCase()}
  function showGraphTooltip(e,node){const tip=document.getElementById('graphTooltip');const line=sourceLineForEvent(e);const method=[e.className,e.methodName].filter(Boolean).join('.');tip.innerHTML='<div class="tooltip-meta">'+esc(graphNodeKind(e))+' · '+esc(method||graphNodeTitle(e))+' · '+esc(e.sourceFile||'')+(e.line?':'+e.line:'')+'</div><div class="tooltip-code">'+(line?esc(line):'<span class="empty">Source line unavailable</span>')+'</div>';const r=node.getBoundingClientRect();tip.classList.add('show');const tr=tip.getBoundingClientRect();let left=Math.min(window.innerWidth-tr.width-8,Math.max(8,r.left));let top=r.bottom+6;if(top+tr.height>window.innerHeight-8)top=Math.max(8,r.top-tr.height-6);tip.style.left=left+'px';tip.style.top=top+'px'}
  function hideGraphTooltip(){document.getElementById('graphTooltip')?.classList.remove('show')}
  function executionGraphEvents(current){if(!current)return[];const result=[];const seen=new Set();const add=e=>{if(e&&!seen.has(e.__index)){seen.add(e.__index);result.push(e)}};const path=callPathAt(current.__index);for(const entry of path){add(findCallSiteForEntry(entry));add(entry)}add(current);let depth=Number(current.depth||0);for(let i=current.__index+1;i<model.events.length&&result.length<12;i++){const e=model.events[i];add(e);if(e.event==='resume'&&Number(e.depth||0)<depth)break;if(e.event==='exit'&&Number(e.depth||0)<Math.max(0,depth-1))break}return result}
  function renderExecutionGraph(){const track=document.getElementById('graphTrack');const hint=document.getElementById('graphHint');const search=(document.getElementById('graphSearch')?.value||'').trim().toLowerCase();if(!track)return;track.innerHTML='';hideGraphTooltip();const current=model.events[selectedEventIndex]||eventsForLine(model.files[fileIndex],selectedLine)[occurrenceIndex]||null;let graphEvents;if(search){graphEvents=model.events.filter(e=>graphSearchText(e).includes(search)).slice(0,100);hint.textContent=graphEvents.length+' match'+(graphEvents.length===1?'':'es')+' across this test run';if(!graphEvents.length){track.innerHTML='<div class="empty" style="padding:6px 2px">No matching method or source line.</div>';return}}else{if(!current){hint.textContent='Select a runtime event to inspect its call path.';track.innerHTML='<div class="empty" style="padding:6px 2px">No execution boundary selected.</div>';return}graphEvents=executionGraphEvents(current);hint.textContent='Actual path for this test run · '+graphEvents.length+' visible step'+(graphEvents.length===1?'':'s')}graphEvents.forEach((e,i)=>{if(i){const edge=document.createElement('span');edge.className='graph-edge';edge.textContent=e.event==='resume'?'↩':'→';track.appendChild(edge)}const b=document.createElement('button');b.className='graph-node '+e.event+' '+(e.thrown?'exception ':'')+(e.__index===current?.__index?'active ':'')+(search?'search-match':'');b.innerHTML='<span class="node-kind">'+esc(graphNodeKind(e))+'</span><b>'+esc(graphNodeTitle(e))+'</b><small>'+esc(e.sourceFile||'')+(e.line?':'+e.line:'')+'</small>';b.onclick=()=>selectEvent(e.__index);b.addEventListener('mouseenter',()=>showGraphTooltip(e,b));b.addEventListener('mouseleave',hideGraphTooltip);b.addEventListener('focus',()=>showGraphTooltip(e,b));b.addEventListener('blur',hideGraphTooltip);track.appendChild(b)});if(!search)requestAnimationFrame(()=>document.querySelector('.graph-node.active')?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'}))}
  function selectEvent(index){const e=model.events[index];if(!e)return;selectedEventIndex=e.__index;const fi=model.files.findIndex(f=>f.sourcePath===e.sourcePath);if(fi>=0)fileIndex=fi;selectedLine=Number(e.line||selectedLine||1);const lineEvents=eventsForLine(model.files[fileIndex],selectedLine);occurrenceIndex=Math.max(0,lineEvents.findIndex(x=>x.__index===e.__index));renderFiles();renderSource();renderActivity()}
  function renderActivity(){const root=document.getElementById('activity');root.innerHTML='';const f=model.files[fileIndex];const list=eventsForLine(f,selectedLine);document.getElementById('activityTitle').textContent=f?f.name+':'+selectedLine:'What happened here';document.getElementById('activityHint').textContent=list.length?list.length+' runtime event'+(list.length===1?'':'s')+' associated with this source line.':'This line was covered, but no method boundary was recorded here.';document.getElementById('occurrence').textContent=list.length?'Occurrence '+(Math.min(occurrenceIndex,list.length-1)+1)+' of '+list.length:'';document.getElementById('prevOcc').disabled=occurrenceIndex<=0;document.getElementById('nextOcc').disabled=occurrenceIndex>=list.length-1;if(!list.length){root.innerHTML='<div class="empty">No call, entry, exit, resume, or exception boundary was captured for this line.</div>';renderExecutionGraph();return}occurrenceIndex=Math.max(0,Math.min(list.length-1,occurrenceIndex));list.forEach((e,i)=>{const b=document.createElement('button');b.className='event-row '+e.event+' '+(e.thrown?'exception ':'')+(i===occurrenceIndex?'active':'');b.innerHTML='<span class="kind">'+esc(eventKind(e))+'</span><b>'+esc(eventLabel(e))+'</b><small>Depth '+Number(e.depth||0)+' · Thread '+esc(e.thread||e.threadId||'main')+'</small>';b.onclick=()=>{occurrenceIndex=i;selectedEventIndex=e.__index;renderActivity()};root.appendChild(b)});const e=list[occurrenceIndex];selectedEventIndex=e.__index;renderExecutionGraph();const detail=document.createElement('div');detail.className='detail';if(e.event==='callsite'){snapshot(detail,'Caller before call',e.callerReceiver);snapshot(detail,'Caller after return',e.callerReceiverAfter);const h=document.createElement('h3');h.textContent='Changes across call';detail.appendChild(h);diff(detail,e.callerReceiver,e.callerReceiverAfter);if(e.targetReceiver)snapshot(detail,'Callee target',e.targetReceiver);if(e.arguments?.length){const h2=document.createElement('h3');h2.textContent='Callee arguments';detail.appendChild(h2);e.arguments.forEach((v,i)=>kv(detail,'arg'+i,v))}if(e.thrown||e.returnValue!==undefined){const h3=document.createElement('h3');h3.textContent='Outcome';detail.appendChild(h3);kv(detail,e.thrown?'thrown':'return',e.thrown||e.returnValue)}}else if(e.event==='enter'){snapshot(detail,'Receiver at entry',e.receiver);if(e.arguments?.length){const h=document.createElement('h3');h.textContent='Arguments';detail.appendChild(h);e.arguments.forEach((v,i)=>kv(detail,'arg'+i,v))}if(e.__outcome){const h=document.createElement('h3');h.textContent='Eventual outcome';detail.appendChild(h);kv(detail,e.__outcome.thrown?'thrown':'return',e.__outcome.thrown||e.__outcome.returnValue)}}else if(e.event==='exit'){snapshot(detail,'Receiver at entry',e.__entrySnapshot?.receiver);snapshot(detail,'Receiver at exit',e.receiverAfter);const h=document.createElement('h3');h.textContent='Changes';detail.appendChild(h);diff(detail,e.__entrySnapshot?.receiver,e.receiverAfter);const h2=document.createElement('h3');h2.textContent='Outcome';detail.appendChild(h2);kv(detail,e.thrown?'thrown':'return',e.thrown||e.returnValue)}else if(e.event==='resume'){snapshot(detail,'Caller before call',e.callerReceiver);snapshot(detail,'Caller after return',e.callerReceiverAfter);const h=document.createElement('h3');h.textContent='Changes';detail.appendChild(h);diff(detail,e.callerReceiver,e.callerReceiverAfter);const h2=document.createElement('h3');h2.textContent='Callee outcome';detail.appendChild(h2);kv(detail,e.thrown?'thrown':'return',e.thrown||e.returnValue)}root.appendChild(detail)}
  function traceEvents(filter){const root=document.getElementById('leftList');root.innerHTML='';model.events.filter(filter||(()=>true)).forEach(e=>{const b=document.createElement('button');b.className='trace-row '+(e.__index===selectedEventIndex?'active':'');b.innerHTML='<span class="badge">'+eventKind(e)+'</span><b>'+esc(eventLabel(e))+'</b><small>'+esc(e.sourceFile||'')+(e.line?':'+e.line:'')+'</small>';b.onclick=()=>{selectEvent(e.__index);traceEvents(filter)};root.appendChild(b)})}
  function replayCallId(e){const raw=e?.callId??e?.call??e?.invocationId;return raw===undefined||raw===null||raw===''?'':String(raw)}
  function eventThreadKey(e){return String(e?.threadId??e?.thread??'main')}
  function sameMethodFrame(a,b){return !!a&&!!b&&String(a.className||'')===String(b.className||'')&&String(a.methodName||'')===String(b.methodName||'')&&String(a.descriptor||'')===String(b.descriptor||'')&&Number(a.depth||0)===Number(b.depth||0)&&eventThreadKey(a)===eventThreadKey(b)}
  function replayEntryFor(e){const id=replayCallId(e);if(id){for(let i=e.__index;i>=0;i--){const x=model.events[i];if(x.event==='enter'&&replayCallId(x)===id)return x}}for(let i=e.__index;i>=0;i--){const x=model.events[i];if(x.event==='enter'&&sameMethodFrame(x,e))return x}return null}
  function previousReplayLineInInvocation(e){if(!e)return null;const id=replayCallId(e);const entry=replayEntryFor(e);const lowerBound=entry?Number(entry.__index):-1;for(let i=replayPosition-1;i>=0;i--){const candidate=replayEvents[i];if(Number(candidate.__index)<=lowerBound)break;if(id){if(replayCallId(candidate)===id)return candidate}else if(sameMethodFrame(candidate,e))return candidate}return null}
  function replayExitFor(e){const id=replayCallId(e);if(!id)return null;for(let i=e.__index;i<model.events.length;i++){const x=model.events[i];if(x.event==='exit'&&replayCallId(x)===id)return x}return null}
  function replayCallsFromLine(e){if(!e)return[];const sequence=Number(e.sequence??e.__index??0);return model.events.filter(x=>x.event==='callsite'&&x.sourcePath===e.sourcePath&&Number(x.line||0)===Number(e.line||0)&&Number(x.sequence??x.__index??0)>=sequence-1&&Number(x.sequence??x.__index??0)<=sequence+2).sort((a,b)=>Number(a.sequence??a.__index)-Number(b.sequence??b.__index))}
  function replaySourceText(e){const f=model.files.find(x=>x.sourcePath===e?.sourcePath);return f&&Number(e?.line)>0?String(f.lines[Number(e.line)-1]||'').trim():''}
  function replaySearchText(e){const parts=[replaySourceText(e),e?.sourceFile,e?.sourcePath,e?.className,e?.methodName,e?.line,e?.thrown,e?.returnValue];for(const key of ['frameReceiver','receiver','receiverAfter','arguments','locals','frameLocals']){const value=e?.[key];if(value!==undefined){try{parts.push(JSON.stringify(value))}catch(_){parts.push(String(value))}}}return parts.filter(v=>v!==undefined&&v!==null).join(' ').toLowerCase()}
  function updateReplaySearch(){const input=document.getElementById('replaySearch');const q=String(input?.value||'').trim().toLowerCase();replaySearchMatches=q?replayEvents.map((e,i)=>({e,i})).filter(x=>replaySearchText(x.e).includes(q)).map(x=>x.i):[];replaySearchCursor=replaySearchMatches.indexOf(replayPosition);if(replaySearchCursor<0&&replaySearchMatches.length)replaySearchCursor=0;renderReplayList();updateReplaySearchStatus()}
  function updateReplaySearchStatus(){const status=document.getElementById('replaySearchStatus');if(!status)return;if(!String(document.getElementById('replaySearch')?.value||'').trim()){status.textContent='';return}status.textContent=replaySearchMatches.length?(Math.max(0,replaySearchMatches.indexOf(replayPosition))+1)+'/'+replaySearchMatches.length:'0/0'}
  function seekReplaySearch(delta){if(!replaySearchMatches.length)return;let current=replaySearchMatches.indexOf(replayPosition);if(current<0)current=delta>0?-1:0;current=(current+delta+replaySearchMatches.length)%replaySearchMatches.length;replaySearchCursor=current;setReplayPosition(replaySearchMatches[current])}
  function replayFrameDepth(e){const entry=replayEntryFor(e);return entry?Number(entry.depth||0):Math.max(0,Number(e?.depth||0)-1)}
  function replayIndexOfEvent(event){if(!event)return-1;return replayEvents.findIndex(x=>x.__index===event.__index)}
  function firstReplayLineForCall(callId,afterSequence=-Infinity){const id=String(callId||'');if(!id)return null;for(const e of replayEvents){if(replayCallId(e)!==id)continue;if(Number(e.sequence??e.__index??0)+0.0001<Number(afterSequence))continue;return e}return null}
  function nextReplayLineInFrame(current,afterSequence){if(!current)return null;const id=replayCallId(current),thread=eventThreadKey(current),depth=replayFrameDepth(current);const start=Number(afterSequence??current.sequence??current.__index??0);for(let i=replayPosition+1;i<replayEvents.length;i++){const e=replayEvents[i];if(eventThreadKey(e)!==thread)continue;if(Number(e.sequence??e.__index??0)<=start)continue;if(id&&replayCallId(e)===id)return e;if(!id&&replayFrameDepth(e)===depth&&sameMethodFrame(e,current))return e}return null}
  function replayCallsFromCurrentLine(current){if(!current)return[];const thread=eventThreadKey(current),currentSeq=Number(current.sequence??current.__index??0),currentId=replayCallId(current);const nextSameFrame=nextReplayLineInFrame(current,currentSeq);const upper=nextSameFrame?Number(nextSameFrame.sequence??nextSameFrame.__index??Infinity):Infinity;return model.events.filter(e=>{if(e.event!=='callsite'||eventThreadKey(e)!==thread)return false;if(String(e.sourcePath||'')!==String(current.sourcePath||'')||Number(e.line||0)!==Number(current.line||0))return false;const seq=Number(e.sequence??e.__index??0);if(seq<currentSeq-0.5||seq>=upper)return false;const entry=replayEntryFor(e);if(!entry)return false;const callerDepth=Number(entry.depth||0)-1;return !currentId||callerDepth===replayFrameDepth(current)||String(entry.callerClassName||'')===String(current.className||'')}) .sort((a,b)=>Number(a.sequence??a.__index??0)-Number(b.sequence??b.__index??0))}
  function stepReplayInto(){const current=replayEvents[replayPosition];if(!current)return;const calls=replayCallsFromCurrentLine(current);for(const call of calls){const target=firstReplayLineForCall(replayCallId(call),Number(call.sequence??call.__index??0)-1);const index=replayIndexOfEvent(target);if(index>=0){setReplayPosition(index);return}}for(let i=replayPosition+1;i<replayEvents.length;i++){if(eventThreadKey(replayEvents[i])===eventThreadKey(current)){setReplayPosition(i);return}}}
  function replayOwningEntry(lineEvent){if(!lineEvent)return null;const thread=eventThreadKey(lineEvent),seq=Number(lineEvent.sequence??lineEvent.__index??0),depth=Number(lineEvent.depth||0);let best=null;for(const e of model.events){if(e.event!=='enter'||eventThreadKey(e)!==thread)continue;if(String(e.className||'')!==String(lineEvent.className||'')||String(e.methodName||'')!==String(lineEvent.methodName||''))continue;if(String(e.descriptor||'')!==String(lineEvent.descriptor||''))continue;if(Number(e.depth||0)!==depth)continue;const entrySeq=Number(e.sequence??e.__index??0);if(entrySeq>seq+0.25)continue;const exit=replayExitFor(e);const exitSeq=exit?Number(exit.sequence??exit.__index??Infinity):Infinity;if(exitSeq+0.25<seq)continue;if(!best||entrySeq>Number(best.sequence??best.__index??-Infinity))best=e}return best||replayEntryFor(lineEvent)}
  function sameReplayOwningFrame(a,b){if(!a||!b||eventThreadKey(a)!==eventThreadKey(b))return false;const ae=replayOwningEntry(a),be=replayOwningEntry(b);if(ae&&be){const aid=replayCallId(ae),bid=replayCallId(be);if(aid&&bid)return aid===bid;return ae.__index===be.__index}return sameMethodFrame(a,b)}
  function sameReplayMethod(a,b){return !!a&&!!b&&eventThreadKey(a)===eventThreadKey(b)&&String(a.sourcePath||'')===String(b.sourcePath||'')&&String(a.className||'')===String(b.className||'')&&String(a.methodName||'')===String(b.methodName||'')&&String(a.descriptor||'')===String(b.descriptor||'')}
  function nextReplayLineInSameMethod(current,fromPosition=replayPosition+1,minSequence=-Infinity){if(!current)return null;for(let i=Math.max(0,fromPosition);i<replayEvents.length;i++){const e=replayEvents[i];if(Number(e.sequence??e.__index??0)<=Number(minSequence))continue;if(sameReplayMethod(current,e))return {event:e,index:i}}return null}
  function stepReplayOver(){
    const current=replayEvents[replayPosition];if(!current)return;
    const thread=eventThreadKey(current),currentSeq=Number(current.sequence??current.__index??0);

    // Step Over is source-frame navigation: remain in the method that owns the
    // highlighted line. Do not use the next LINE event's callId/depth to decide
    // whether it belongs to the caller; the first callee LINE can be emitted
    // before ENTER and therefore temporarily carries misleading frame metadata.
    const nextCallerLine=nextReplayLineInSameMethod(current,replayPosition+1,currentSeq);
    if(nextCallerLine){
      // If this line recursively invokes the same method, a child invocation can
      // also look like the same source method. Skip through any child call(s)
      // launched from this exact source-line occurrence before accepting it.
      const upperSeq=Number(nextCallerLine.event.sequence??nextCallerLine.event.__index??Infinity);
      let skipThrough=currentSeq;
      for(const call of model.events){
        if(call.event!=='callsite'||eventThreadKey(call)!==thread)continue;
        if(String(call.sourcePath||'')!==String(current.sourcePath||'')||Number(call.line||0)!==Number(current.line||0))continue;
        const callSeq=Number(call.sequence??call.__index??0);
        if(callSeq<currentSeq-0.5||callSeq>=upperSeq)continue;
        const exit=replayExitFor(call);
        if(exit)skipThrough=Math.max(skipThrough,Number(exit.sequence??exit.__index??skipThrough));
      }
      const target=nextReplayLineInSameMethod(current,replayPosition+1,skipThrough);
      if(target){setReplayPosition(target.index);return}
      setReplayPosition(nextCallerLine.index);return;
    }

    // No later line exists in this method (for example we are at its final
    // executable line). In that case behave like a debugger and continue at the
    // first replay line after this invocation exits.
    const owner=replayOwningEntry(current)||replayEntryFor(current);
    const exit=owner?replayExitFor(owner):null;
    const boundary=exit?Number(exit.sequence??exit.__index??currentSeq):currentSeq;
    for(let i=replayPosition+1;i<replayEvents.length;i++){
      const e=replayEvents[i];
      if(eventThreadKey(e)!==thread)continue;
      if(Number(e.sequence??e.__index??0)<=boundary)continue;
      setReplayPosition(i);return;
    }
  }
  function stepReplayOut(){const current=replayEvents[replayPosition];if(!current)return;const entry=replayEntryFor(current);if(!entry)return;const callerPath=entry.callerSourcePath,callerLine=Number(entry.callerLine||0),thread=eventThreadKey(current);if(callerPath&&callerLine>0){const boundary=Number(entry.sequence??entry.__index??Infinity);let target=-1;for(let i=0;i<replayEvents.length;i++){const e=replayEvents[i];if(eventThreadKey(e)!==thread)continue;if(String(e.sourcePath||'')!==String(callerPath)||Number(e.line||0)!==callerLine)continue;if(Number(e.sequence??e.__index??0)>=boundary)continue;target=i}if(target>=0){setReplayPosition(target);return}}const currentDepth=replayFrameDepth(current);for(let i=replayPosition-1;i>=0;i--){const e=replayEvents[i];if(eventThreadKey(e)===thread&&replayFrameDepth(e)<currentDepth){setReplayPosition(i);return}}}
  function currentLineOccurrences(){const e=replayEvents[replayPosition];return e?replayOccurrences(e.sourcePath,e.line):[]}
  function seekLineOccurrence(delta){const occurrences=currentLineOccurrences();if(!occurrences.length)return;let index=occurrences.indexOf(replayPosition);if(index<0)index=0;index=Math.max(0,Math.min(occurrences.length-1,index+delta));setReplayPosition(occurrences[index])}

  function replayStepLabel(e){return simple(e)+'.'+e.methodName+'() · line '+e.line}
  function stopReplay(){if(replayTimer){clearInterval(replayTimer);replayTimer=null}const b=document.getElementById('replayPlay');if(b)b.textContent='▶'}
  function updateReplayControls(){const slider=document.getElementById('replaySlider');const status=document.getElementById('replayStatus');if(!slider||!status)return;slider.max=String(Math.max(0,replayEvents.length-1));slider.value=String(Math.max(0,replayPosition));const e=replayEvents[replayPosition];status.textContent=e?'Step '+(replayPosition+1)+' / '+replayEvents.length+' · #'+String(e.sequence??e.__index):'No ordered events';document.getElementById('replayPrev').disabled=replayPosition<=0;document.getElementById('replayStart').disabled=replayPosition<=0;document.getElementById('replayInto').disabled=replayPosition>=replayEvents.length-1;document.getElementById('replayOver').disabled=replayPosition>=replayEvents.length-1;document.getElementById('replayOut').disabled=!e||Number(e.depth||0)<=0;document.getElementById('replayEnd').disabled=replayPosition>=replayEvents.length-1;updateReplaySearchStatus()}
  function setReplayPosition(position){if(!replayEvents.length)return;replayPosition=Math.max(0,Math.min(replayEvents.length-1,Number(position)||0));const e=replayEvents[replayPosition];selectedEventIndex=e.__index;const fi=model.files.findIndex(f=>f.sourcePath===e.sourcePath);if(fi>=0)fileIndex=fi;selectedLine=Number(e.line||selectedLine||1);occurrenceIndex=Math.max(0,eventsForLine(model.files[fileIndex],selectedLine).findIndex(x=>x.__index===e.__index));renderFiles();renderSource();renderReplayList();renderReplayDetail();renderExecutionGraph();updateReplayControls()}
  function renderReplayList(){const root=document.getElementById('leftList');root.innerHTML='';const start=Math.max(0,replayPosition-80),end=Math.min(replayEvents.length,replayPosition+81);if(start>0){const more=document.createElement('div');more.className='empty';more.textContent=start+' earlier steps';root.appendChild(more)}for(let i=start;i<end;i++){const e=replayEvents[i];const b=document.createElement('button');b.className='replay-step '+(i===replayPosition?'active ':'')+(replaySearchMatches.includes(i)?'search-match':'');const text=replaySourceText(e);b.innerHTML='<span class="seq">#'+esc(e.sequence??i+1)+'</span><b>'+esc(replayStepLabel(e))+'</b><small>'+esc(text||((e.sourceFile||'')+(e.line?':'+e.line:'')))+'</small>';b.onclick=()=>setReplayPosition(i);root.appendChild(b)}if(end<replayEvents.length){const more=document.createElement('div');more.className='empty';more.textContent=(replayEvents.length-end)+' later steps';root.appendChild(more)}requestAnimationFrame(()=>root.querySelector('.replay-step.active')?.scrollIntoView({block:'center'}))}
  function renderReplayDetail(){
    const root=document.getElementById('activity');root.innerHTML='';const e=replayEvents[replayPosition];
    document.getElementById('activityTitle').textContent=e?'Replay step '+(replayPosition+1):'Replay';
    document.getElementById('activityHint').textContent=e?(simple(e)+'.'+(e.methodName||'')+'() · line '+e.line):'No ordered line events were captured.';
    const lineOccurrences=e?currentLineOccurrences():[];const lineOccurrenceIndex=lineOccurrences.indexOf(replayPosition);document.getElementById('occurrence').textContent=e?('Occurrence '+(lineOccurrenceIndex+1)+' of '+lineOccurrences.length+' · #'+String(e.sequence??e.__index)+' · '+(e.sourceFile||'Source')+':'+e.line):'';
    document.getElementById('prevOcc').disabled=lineOccurrenceIndex<=0;document.getElementById('nextOcc').disabled=lineOccurrenceIndex<0||lineOccurrenceIndex>=lineOccurrences.length-1;
    if(!e){root.innerHTML='<div class="empty">Run Code Flow with ordered line recording enabled.</div>';return}

    const context=document.createElement('div');context.className='detail replay-current';
    const summary=document.createElement('div');summary.className='replay-summary';const code=replaySourceText(e);
    summary.innerHTML='<strong>'+esc(code||replayStepLabel(e))+'</strong><small>'+esc(simple(e)+'.'+(e.methodName||'')+'() · '+(e.sourceFile||'Source')+':'+e.line)+'</small>';
    context.appendChild(summary);

    // The captured snapshot belongs to this exact ordered source-line event.
    // Keep it as the primary content instead of making inferred diffs the gatekeeper.
    if(e.frameReceiver)snapshot(context,'State at this line',e.frameReceiver,{label:'this'});
    else {
      const unavailable=section(context,'State at this line');
      unavailable.insertAdjacentHTML('beforeend','<div class="state-empty">Receiver state was not captured for this line.</div>');
    }

    const namedLocals=e.frameLocals&&typeof e.frameLocals==='object'
      ?Object.fromEntries(Object.entries(e.frameLocals).filter(([name])=>{
        const text=String(name||'');
        if(!text.startsWith('slot'))return true;
        const suffix=text.slice(4);
        return !suffix||String(Number(suffix))!==suffix;
      }))
      :{};
    if(Object.keys(namedLocals).length){
      const locals=section(context,'Visible locals',Object.keys(namedLocals).length+' captured');
      const card=document.createElement('div');card.className='state-card';
      const fields=document.createElement('div');fields.className='state-fields';
      for(const[k,v]of Object.entries(namedLocals))kv(fields,k,v);
      card.appendChild(fields);locals.appendChild(card);
    }

    const calls=replayCallsFromLine(e);
    if(calls.length){
      const callsSection=section(context,calls.length===1?'Call from this line':'Calls from this line',calls.length);
      for(const call of calls){
        const card=document.createElement('div');card.className='state-card';
        const head=document.createElement('div');head.className='state-card-head';
        head.innerHTML='<b>'+esc(simple(call.calleeClassName?{className:call.calleeClassName}:call)+'.'+(call.calleeMethodName||call.methodName||'')+'()')+'</b><small>call</small>';
        card.appendChild(head);
        const fields=document.createElement('div');fields.className='state-fields';
        if(call.callerReceiver)snapshot(card,'Caller before call',call.callerReceiver,{label:'this'});
        if(call.arguments?.length)call.arguments.forEach((v,i)=>kv(fields,'arg'+i,v));
        if(call.thrown)kv(fields,'throws',call.thrown);else if(call.returnValue!==undefined)kv(fields,'returns',call.returnValue);
        card.appendChild(fields);
        if(call.callerReceiverAfter)snapshot(card,'Caller after return',call.callerReceiverAfter,{label:'this'});
        callsSection.appendChild(card);
      }
    }

    const entry=replayEntryFor(e),exit=replayExitFor(e);
    if(entry?.arguments?.length){
      const args=section(context,'Method arguments',entry.arguments.length);
      const card=document.createElement('div');card.className='state-card';const fields=document.createElement('div');fields.className='state-fields';
      entry.arguments.forEach((v,i)=>kv(fields,'arg'+i,v));card.appendChild(fields);args.appendChild(card);
    }

    const path=callPathAt(e.__index);
    const stackSection=section(context,'Active call stack',path.length+' frame'+(path.length===1?'':'s'));
    const stack=document.createElement('div');stack.className='replay-callstack';
    for(const frame of path){const chip=document.createElement('span');chip.className='replay-frame';chip.textContent=simple(frame)+'.'+frame.methodName+'()';stack.appendChild(chip)}
    if(!path.length)stack.innerHTML='<span class="empty">No active method frame found.</span>';stackSection.appendChild(stack);

    if(exit){
      const out=section(context,'Recorded method outcome');const card=document.createElement('div');card.className='state-card';const fields=document.createElement('div');fields.className='state-fields';
      kv(fields,exit.thrown?'thrown':'return',exit.thrown||exit.returnValue);card.appendChild(fields);out.appendChild(card);
      if(exit.receiverAfter)snapshot(out,'Receiver at method exit',exit.receiverAfter,{label:'this'});
    }

    const meta=section(context,'Execution details');const grid=document.createElement('div');grid.className='metadata-grid';
    kv(grid,'event',eventKind(e));kv(grid,'sequence',e.sequence??e.__index);kv(grid,'thread',e.thread||e.threadId||'main');kv(grid,'call id',replayCallId(e)||'n/a');kv(grid,'depth',e.depth||0);meta.appendChild(grid);
    root.appendChild(context);
  }
  function toggleReplay(){if(replayTimer){stopReplay();return}if(replayPosition>=replayEvents.length-1)replayPosition=0;const delay=Number(document.getElementById('replaySpeed').value||500);document.getElementById('replayPlay').textContent='⏸';replayTimer=setInterval(()=>{if(replayPosition>=replayEvents.length-1){stopReplay();return}setReplayPosition(replayPosition+1)},delay)}
  let fullGraphScale=1;let selectedGraphNode=null;
  function graphMethodKey(e){return String(e.className||'')+'#'+String(e.methodName||'')+String(e.descriptor||'')}
  function buildFullGraph(){
    const collapse=!!document.getElementById('graphCollapseRepeats')?.checked;
    const nodes=[];const edges=[];const stacks=new Map();const pendingCalls=new Map();
    const simpleName=e=>(e.className?e.className.split('.').pop()+'.':'')+(e.methodName||'<method>')+'()';
    const invocationKey=(parent,e)=>String(parent?.id||'root')+'>'+graphMethodKey(e);
    const grouped=new Map();
    const createNode=(e,parent)=>{
      const key=invocationKey(parent,e);
      if(collapse&&grouped.has(key)){
        const existing=grouped.get(key);existing.count++;existing.events.push(e);return existing;
      }
      const node={id:'n'+nodes.length,type:'method',key,label:simpleName(e),sub:(e.sourceFile||'')+(e.line?':'+e.line:''),event:e,events:[e],count:1,children:[],outcome:null,parent:parent||null,depth:Number(e.depth||0)};
      nodes.push(node);if(collapse)grouped.set(key,node);return node;
    };
    const addEdge=(from,to,call)=>{
      if(!from||!to||from===to)return;
      let edge=edges.find(x=>x.from===from&&x.to===to);
      if(edge){edge.count++;return}
      edge={key:from.id+'>'+to.id,from,to,count:1,line:Number(call?.line||0),sourceFile:call?.sourceFile||'',sourcePath:call?.sourcePath||'',label:sourceLineForEvent(call)||((call?.calleeMethodName||to.event.methodName||'call')+'()'),event:call||to.event,outcome:null};
      edges.push(edge);from.children.push(to);
    };
    for(const event of model.events||[]){
      const thread=String(event.thread||event.threadId||'main');const stack=stacks.get(thread)||[];
      if(event.event==='callsite'){pendingCalls.set(thread,event);continue}
      if(event.event==='enter'){
        const parent=stack[stack.length-1]||null;const node=createNode(event,parent);const call=pendingCalls.get(thread)||null;
        addEdge(parent,node,call);pendingCalls.delete(thread);stack.push(node);stacks.set(thread,stack);continue;
      }
      if(event.event==='exit'){
        const node=stack[stack.length-1];if(node){node.outcome={returnValue:event.returnValue,thrown:event.thrown,event};for(const edge of edges.filter(x=>x.to===node))edge.outcome=node.outcome}
        if(stack.length)stack.pop();stacks.set(thread,stack);
      }
    }
    const roots=nodes.filter(n=>!edges.some(e=>e.to===n));return {nodes,edges,roots:roots.length?roots:nodes.slice(0,1)};
  }
  function layoutFullGraph(nodes,edges,roots){
    const visible=new Set();const depth=new Map();const walk=(node,d)=>{if(!node||visible.has(node.id))return;visible.add(node.id);depth.set(node.id,d);for(const edge of edges.filter(e=>e.from===node))walk(edge.to,d+1)};for(const root of roots)walk(root,0);for(const node of nodes)if(!visible.has(node.id)){visible.add(node.id);depth.set(node.id,0)}
    const columns=new Map();for(const node of nodes){const d=depth.get(node.id)||0;if(!columns.has(d))columns.set(d,[]);columns.get(d).push(node)}
    let maxX=420,maxY=220;const width=330;for(const [d,column] of [...columns.entries()].sort((a,b)=>a[0]-b[0])){let y=36;for(const node of column){node.w=width;node.h=94;node.x=64+d*520;node.y=y;y+=node.h+72;maxX=Math.max(maxX,node.x+node.w);maxY=Math.max(maxY,node.y+node.h)}}return {width:maxX+110,height:maxY+80};
  }
  function edgeOutcomeText(edge){const o=edge.outcome;if(!o)return '';if(o.thrown)return 'throws '+String(o.thrown).split(/[.:]/).pop();if(o.returnValue===undefined)return 'returns';const v=String(o.returnValue);return 'returns '+(v.length>28?v.slice(0,27)+'…':v)}
  function svgText(parent,x,y,text,size,fill,weight){const t=document.createElementNS('http://www.w3.org/2000/svg','text');t.setAttribute('x',String(x));t.setAttribute('y',String(y));t.setAttribute('font-size',String(size));t.setAttribute('fill',fill||'var(--vscode-editor-foreground)');if(weight)t.setAttribute('font-weight',weight);t.textContent=text;parent.appendChild(t);return t}
  function renderFullGraph(){
    const svg=document.getElementById('fullGraphSvg');if(!svg)return;
    try{
      const graph=buildFullGraph();const nodes=graph.nodes,edges=graph.edges;const size=layoutFullGraph(nodes,edges,graph.roots);const stats=document.getElementById('graphStats');if(stats)stats.textContent=' · '+nodes.length+' methods · '+edges.length+' calls · '+graph.roots.length+' root'+(graph.roots.length===1?'':'s');
      svg.setAttribute('width',String(Math.max(320,size.width*fullGraphScale)));svg.setAttribute('height',String(Math.max(180,size.height*fullGraphScale)));svg.setAttribute('viewBox','0 0 '+size.width+' '+size.height);svg.replaceChildren();
      const defs=document.createElementNS('http://www.w3.org/2000/svg','defs');const marker=document.createElementNS('http://www.w3.org/2000/svg','marker');marker.setAttribute('id','fgArrow');marker.setAttribute('markerWidth','8');marker.setAttribute('markerHeight','8');marker.setAttribute('refX','7');marker.setAttribute('refY','3');marker.setAttribute('orient','auto');const arrow=document.createElementNS('http://www.w3.org/2000/svg','path');arrow.setAttribute('d','M0,0 L0,6 L8,3 z');arrow.setAttribute('fill','var(--vscode-descriptionForeground)');marker.appendChild(arrow);defs.appendChild(marker);svg.appendChild(defs);
      if(!nodes.length){svgText(svg,30,45,'No method events were captured for this run.',12,'var(--vscode-descriptionForeground)');return}
      for(const edge of edges){const x1=edge.from.x+edge.from.w,y1=edge.from.y+32,x2=edge.to.x,y2=edge.to.y+32,mid=x1+(x2-x1)*.50;const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M'+x1+','+y1+' C'+mid+','+y1+' '+mid+','+y2+' '+x2+','+y2);path.setAttribute('class','fg-edge');svg.appendChild(path);const label=(edge.line?'L'+edge.line+' · ':'')+String(edge.label||'call').replace(/\s+/g,' ').slice(0,38)+(edge.count>1?' ×'+edge.count:'');const lx=(x1+x2)/2,ly=(y1+y2)/2-5;const bg=document.createElementNS('http://www.w3.org/2000/svg','rect');bg.setAttribute('x',String(lx-118));bg.setAttribute('y',String(ly-11));bg.setAttribute('width','236');bg.setAttribute('height','17');bg.setAttribute('rx','4');bg.setAttribute('fill','var(--vscode-editor-background)');bg.setAttribute('stroke','var(--vscode-panel-border)');svg.appendChild(bg);svgText(svg,lx,ly,label,8,'var(--vscode-descriptionForeground)','500').setAttribute('text-anchor','middle')}
      for(const node of nodes){const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.setAttribute('class','fg-node method'+(selectedGraphNode===node.id?' selected':''));group.setAttribute('transform','translate('+node.x+','+node.y+')');const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('width',String(node.w));rect.setAttribute('height',String(node.h));rect.setAttribute('rx','7');group.appendChild(rect);svgText(group,14,17,'METHOD',8,'var(--vscode-descriptionForeground)');svgText(group,14,38,node.label,12,'var(--vscode-editor-foreground)','600');svgText(group,14,55,node.sub,9,'var(--vscode-descriptionForeground)');const callers=edges.filter(x=>x.to===node).length,callees=edges.filter(x=>x.from===node).length;const context=callees+' call'+(callees===1?'':'s')+' · depth '+node.depth+(callers?' · '+callers+' caller'+(callers===1?'':'s'):' · root');const ct=svgText(group,14,72,context,9,'var(--vscode-descriptionForeground)');ct.setAttribute('class','fg-context');const outcome=edgeOutcomeText({outcome:node.outcome});if(outcome){const ot=svgText(group,14,87,outcome,9,node.outcome?.thrown?'var(--vscode-testing-iconFailed)':'var(--vscode-testing-iconPassed)','600');ot.setAttribute('class','fg-outcome')}if(node.count>1)svgText(group,node.w-14,18,'×'+node.count,9,'var(--vscode-badge-foreground)','600').setAttribute('text-anchor','end');group.addEventListener('click',()=>selectFullGraphNode(node));svg.appendChild(group)}
    }catch(error){svg.setAttribute('viewBox','0 0 900 160');svg.replaceChildren();svgText(svg,30,45,'Graph rendering failed: '+String(error&&error.message||error),18,'var(--vscode-testing-iconFailed)');console.error('[CGTL Graph]',error)}
  }
  function selectFullGraphNode(n){selectedGraphNode=n.id;renderFullGraph();const e=n.event;const root=document.getElementById('graphInspector');root.innerHTML='';document.getElementById('graphInspectorTitle').textContent=n.label;document.getElementById('graphInspectorHint').textContent=(e.sourceFile||'Source')+(e.line?':'+e.line:'');const detail=document.createElement('div');detail.className='detail';if(e.sourcePath&&e.line){const pre=document.createElement('div');pre.className='source-preview';pre.textContent=(e.sourceFile||'')+':'+e.line+'\\n'+sourceLineForEvent(e);pre.onclick=()=>vscode.postMessage({command:'openLine',sourcePath:e.sourcePath,className:e.className,line:e.line});detail.appendChild(pre)}const open=document.createElement('button');open.className='action';open.textContent='Open source';open.onclick=()=>vscode.postMessage({command:'openLine',sourcePath:e.sourcePath,className:e.className,line:e.line});detail.appendChild(open);const h=document.createElement('h3');h.textContent='Runtime event';detail.appendChild(h);kv(detail,'kind',eventKind(e));kv(detail,'method',eventLabel(e));kv(detail,'depth',e.depth||0);kv(detail,'thread',e.thread||e.threadId||'main');if(e.event==='enter'){snapshot(detail,'Receiver at entry',e.receiver);if(e.arguments?.length)e.arguments.forEach((v,i)=>kv(detail,'arg'+i,v));if(e.__outcome)kv(detail,e.__outcome.thrown?'thrown':'return',e.__outcome.thrown||e.__outcome.returnValue)}else if(e.event==='callsite'){snapshot(detail,'Caller before call',e.callerReceiver);snapshot(detail,'Caller after return',e.callerReceiverAfter);if(e.targetReceiver)snapshot(detail,'Callee target',e.targetReceiver)}root.appendChild(detail)}
  function setMode(next){if(mode==='replay'&&next!=='replay')stopReplay();mode=next;for(const id of ['source','replay','calls','timeline','changes','graph'])document.getElementById(id+'Tab').classList.toggle('active',id===mode);document.getElementById('sourceWorkspace').style.display=mode==='graph'?'none':'grid';document.getElementById('fullGraph').classList.toggle('active',mode==='graph');document.getElementById('executionGraph').classList.toggle('replay-active',mode==='replay');if(mode==='graph'){renderFullGraph();return}else if(mode==='replay'){document.getElementById('leftTitle').textContent='Ordered execution';document.getElementById('leftHint').textContent='Every recorded source line in exact execution order. Method boundaries remain available in Timeline and Call Tree.';if(replayEvents.length){const current=replayEvents.findIndex(e=>e.__index===selectedEventIndex);if(current>=0)replayPosition=current;setReplayPosition(replayPosition)}else{renderReplayList();renderReplayDetail();updateReplayControls()}return}else if(mode==='source'){document.getElementById('leftTitle').textContent='Executed files';document.getElementById('leftHint').textContent='Choose the code you want to investigate.';renderFiles()}else if(mode==='calls'){document.getElementById('leftTitle').textContent='Method calls';document.getElementById('leftHint').textContent='Select a call, then inspect its source and state.';traceEvents(e=>e.event==='enter')}else if(mode==='timeline'){document.getElementById('leftTitle').textContent='Full timeline';document.getElementById('leftHint').textContent='All boundaries in chronological order.';traceEvents()}else{document.getElementById('leftTitle').textContent='State changes';document.getElementById('leftHint').textContent='Only boundaries where receiver state changed or an exception occurred.';traceEvents(e=>{const b=e.callerReceiver||e.__entrySnapshot?.receiver||e.receiver,a=e.callerReceiverAfter||e.receiverAfter;return !!e.thrown||(b&&a&&JSON.stringify(b)!==JSON.stringify(a))})}}
  function render(){setMode(mode);renderSource();if(mode==='replay')renderReplayDetail();else renderActivity();renderExecutionGraph()}
  document.getElementById('sourceTab').onclick=()=>setMode('source');document.getElementById('replayTab').onclick=()=>setMode('replay');document.getElementById('graphTab').onclick=()=>setMode('graph');document.getElementById('callsTab').onclick=()=>setMode('calls');document.getElementById('timelineTab').onclick=()=>setMode('timeline');document.getElementById('changesTab').onclick=()=>setMode('changes');const graphSearch=document.getElementById('graphSearch');graphSearch.addEventListener('input',renderExecutionGraph);graphSearch.addEventListener('keydown',e=>{if(e.key==='Enter'){const first=document.querySelector('.graph-node.search-match');if(first){first.click();e.preventDefault()}}if(e.key==='Escape'){graphSearch.value='';renderExecutionGraph();graphSearch.blur();e.preventDefault()}});document.getElementById('replayStart').onclick=()=>setReplayPosition(0);document.getElementById('replayPrev').onclick=()=>setReplayPosition(replayPosition-1);document.getElementById('replayInto').onclick=stepReplayInto;document.getElementById('replayOver').onclick=stepReplayOver;document.getElementById('replayOut').onclick=stepReplayOut;document.getElementById('replayPlay').onclick=toggleReplay;document.getElementById('replayEnd').onclick=()=>setReplayPosition(replayEvents.length-1);document.getElementById('replaySlider').oninput=e=>setReplayPosition(Number(e.target.value));const replaySearch=document.getElementById('replaySearch');replaySearch.oninput=updateReplaySearch;replaySearch.onkeydown=e=>{if(e.key==='Enter'){seekReplaySearch(e.shiftKey?-1:1);e.preventDefault()}else if(e.key==='Escape'){replaySearch.value='';updateReplaySearch();replaySearch.blur();e.preventDefault()}};document.getElementById('replaySearchPrev').onclick=()=>seekReplaySearch(-1);document.getElementById('replaySearchNext').onclick=()=>seekReplaySearch(1);document.getElementById('replaySpeed').onchange=()=>{if(replayTimer){stopReplay();toggleReplay()}};document.getElementById('graphCollapseRepeats').onchange=renderFullGraph;document.getElementById('graphFit').onclick=()=>{fullGraphScale=1;renderFullGraph();document.getElementById('fullGraphCanvas').scrollTo(0,0)};document.getElementById('graphZoomIn').onclick=()=>{fullGraphScale=Math.min(2,fullGraphScale+.15);renderFullGraph()};document.getElementById('graphZoomOut').onclick=()=>{fullGraphScale=Math.max(.5,fullGraphScale-.15);renderFullGraph()};document.getElementById('graphToggleInspector').onclick=()=>{const body=document.getElementById('fullGraphBody');const collapsed=body.classList.toggle('inspector-collapsed');document.getElementById('graphToggleInspector').textContent=collapsed?'Show details':'Hide details';requestAnimationFrame(renderFullGraph)};document.getElementById('prevOcc').onclick=()=>{if(mode==='replay')seekLineOccurrence(-1);else{occurrenceIndex=Math.max(0,occurrenceIndex-1);renderActivity()}};document.getElementById('nextOcc').onclick=()=>{if(mode==='replay')seekLineOccurrence(1);else{const n=eventsForLine(model.files[fileIndex],selectedLine).length;occurrenceIndex=Math.min(n-1,occurrenceIndex+1);renderActivity()}};document.getElementById('openSource').onclick=()=>{const f=model.files[fileIndex];const e=model.events[selectedEventIndex];vscode.postMessage({command:'openLine',sourcePath:e?.sourcePath||f?.sourcePath,className:e?.className,line:e?.line||selectedLine})};window.addEventListener('keydown',e=>{const replaySearchInput=document.getElementById('replaySearch');if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){const target=mode==='replay'?replaySearchInput:graphSearch;target.focus();target.select();e.preventDefault();return}if(document.activeElement===graphSearch||document.activeElement===replaySearchInput)return;if(mode==='replay'&&(e.key==='ArrowRight'||e.key==='l')){stepReplayInto();e.preventDefault();return}if(mode==='replay'&&(e.key==='ArrowLeft'||e.key==='h')){setReplayPosition(replayPosition-1);e.preventDefault();return}if(mode==='replay'&&e.key.toLowerCase()==='o'){stepReplayOver();e.preventDefault();return}if(mode==='replay'&&e.key.toLowerCase()==='u'){stepReplayOut();e.preventDefault();return}if(mode==='replay'&&e.key===' '){toggleReplay();e.preventDefault();return}if(e.key==='j'||e.key==='ArrowDown'){document.getElementById('nextOcc').click();e.preventDefault()}if(e.key==='k'||e.key==='ArrowUp'){document.getElementById('prevOcc').click();e.preventDefault()}if(e.key==='Enter')document.getElementById('openSource').click()});if(model.files.length)chooseFile(0);else render();
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


async function openDebugEvaluatePanel() {
  const viewId = 'compositeGradleTests.evaluateView';
  const focusCommand = `${viewId}.focus`;

  // A contributed WebviewView in the Panel is revealed by its generated
  // `<viewId>.focus` command. `workbench.action.openView` may resolve without
  // revealing panel-hosted views, so do not use it as the primary path.
  await vscode.commands.executeCommand('workbench.action.focusPanel');

  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(focusCommand)) {
    throw new Error(`Evaluate panel view command '${focusCommand}' was not registered by VS Code.`);
  }

  await vscode.commands.executeCommand(focusCommand);

  // Wait for VS Code to resolve the provider. Failing loudly here is better
  // than leaving the command looking like it did nothing.
  const deadline = Date.now() + 2000;
  while (!debugEvaluatePanelProvider?.view && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!debugEvaluatePanelProvider?.view) {
    throw new Error('Evaluate panel was focused, but its webview provider was not resolved. Reload the VS Code window and try again.');
  }
  debugEvaluatePanelProvider.view.show?.(true);
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
  await openDebugEvaluatePanel();
  await ensureDebugEvaluateResultPanel();
  renderDebugEvaluateResult(debugEvaluateCurrentModel || { status: 'idle', message: 'Enter an expression and press Ctrl+Enter.', frame });
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
  if (debugEvaluatePanelProvider?.view) {
    debugEvaluateResultPanel = debugEvaluatePanelProvider.view;
    return debugEvaluateResultPanel;
  }
  await openDebugEvaluatePanel();
  return debugEvaluatePanelProvider?.view;
}

class DebugEvaluatePanelProvider {
  resolveWebviewView(view) {
    this.view = view;
    debugEvaluateResultPanel = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(handleDebugEvaluateMessage);
    view.onDidDispose(() => {
      if (debugEvaluateResultPanel === view) debugEvaluateResultPanel = undefined;
      this.view = undefined;
    });
    renderDebugEvaluateResult(debugEvaluateCurrentModel || {
      status: 'idle',
      message: 'Pause a Java debug session, enter an expression, and press Ctrl+Enter.',
      frame: debugEvaluateCurrentFrame
    });
  }
}

async function handleDebugEvaluateMessage(message) {
  try {
    if (message.command === 'evaluate') {
      await evaluateCurrentExpression(String(message.expression || ''));
      return;
    }
    if (message.command === 'complete') {
      const requestId = Number(message.requestId || 0);
      const completions = await requestDebugEvaluateCompletions(
        String(message.expression || ''),
        Number(message.cursor || 0)
      );
      debugEvaluateResultPanel?.webview.postMessage({ command: 'completions', requestId, completions });
      return;
    }
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
      if (!item) return;
      debugEvaluateResultPanel?.webview.postMessage({ command: 'setExpression', expression: item.expression });
      renderDebugEvaluateResult(item.model || { status: 'idle', message: 'Expression restored.', frame: debugEvaluateCurrentFrame });
      return;
    }
    if (message.command === 'clearHistory') {
      debugEvaluateHistory = [];
      if (extensionContext) await extensionContext.workspaceState.update('debugEvaluateHistory', debugEvaluateHistory);
      renderDebugEvaluateResult(debugEvaluateCurrentModel || { status: 'idle', message: 'History cleared.', frame: debugEvaluateCurrentFrame });
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
  const history = debugEvaluateHistory.map((item, index) => {
    const summary = escape(item.expression.replace(/\s+/g, ' ').slice(0, 110));
    const value = item.model?.status === 'success' ? escape(formatDebugValue(item.model.result)) : item.model?.status === 'error' ? 'Error' : '';
    return `<button class="history-item" data-history="${index}" title="${escape(item.expression)}"><span class="history-expression">${summary}</span><span class="history-value">${value}</span></button>`;
  }).join('');
  const vars = Array.isArray(model?.variables) ? model.variables : [];
  const rootRows = vars.map((v, index) => renderEvaluateVariable(v, `root-${index}`, 0, escape)).join('');
  const resultLine = status === 'success'
    ? `<div class="root-result"><span class="value">${escape(formatDebugValue(model.result))}</span><span class="type">${escape(model.type || '')}</span></div>`
    : status === 'error'
      ? `<div class="error">${escape(model.message)}</div>`
      : status === 'running'
        ? `<div class="running">Evaluating…</div>`
        : `<div class="idle">${escape(model.message || 'Ready')}</div>`;
  const nonce = Math.random().toString(36).slice(2);
  const initialExpression = escape(model?.expression || '');
  debugEvaluateResultPanel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
    *{box-sizing:border-box}html,body{height:100%;margin:0}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-panel-background,var(--vscode-editor-background));font-size:12px;overflow:hidden}
    .shell{height:100%;display:flex;flex-direction:column}.context{height:30px;display:flex;align-items:center;padding:0 10px;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.context strong{color:var(--vscode-foreground);margin-right:5px}
    .main{min-height:0;flex:1;display:grid;grid-template-columns:minmax(260px,42%) minmax(360px,58%)}.expressions{min-width:0;border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column}.output{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) 220px}
    .pane-title{height:29px;display:flex;align-items:center;justify-content:space-between;padding:0 9px;border-bottom:1px solid var(--vscode-panel-border);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.hint{font-weight:400;letter-spacing:0;text-transform:none;color:var(--vscode-descriptionForeground)}
    .editor-wrap{position:relative;flex:1;min-height:0;display:flex}textarea{flex:1;min-height:0;width:100%;resize:none;border:0;outline:0;padding:10px 11px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:13px/1.5 var(--vscode-editor-font-family);tab-size:2}.suggestions{position:absolute;z-index:20;left:10px;right:10px;top:34px;max-height:190px;overflow:auto;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));background:var(--vscode-editorSuggestWidget-background,var(--vscode-editor-background));box-shadow:0 4px 14px var(--vscode-widget-shadow,rgba(0,0,0,.28))}.suggestions[hidden]{display:none}.suggestion{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;width:100%;border:0;background:transparent;color:var(--vscode-editorSuggestWidget-foreground,var(--vscode-foreground));padding:5px 8px;text-align:left;cursor:pointer;font-family:var(--vscode-editor-font-family)}.suggestion:hover,.suggestion.selected{background:var(--vscode-editorSuggestWidget-selectedBackground,var(--vscode-list-activeSelectionBackground));color:var(--vscode-editorSuggestWidget-selectedForeground,var(--vscode-list-activeSelectionForeground))}.suggestion-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.suggestion-detail{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}.actions{height:34px;display:flex;align-items:center;gap:6px;padding:4px 7px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
    button{font:inherit}.primary{border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:4px 12px;cursor:pointer}.primary:hover{background:var(--vscode-button-hoverBackground)}.secondary{border:1px solid var(--vscode-button-secondaryBackground);background:transparent;color:var(--vscode-foreground);padding:3px 8px;cursor:pointer}
    .result-pane{min-width:0;overflow:auto;padding:9px 10px 22px}.history{min-width:0;overflow:auto;border-left:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}.history-head{height:29px;display:flex;align-items:center;justify-content:space-between;padding:0 8px;border-bottom:1px solid var(--vscode-panel-border);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.clear{border:0;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer}.clear:hover{color:var(--vscode-foreground)}
    .history-item{display:grid;width:100%;grid-template-columns:minmax(0,1fr) auto;gap:8px;border:0;border-bottom:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-foreground);text-align:left;padding:7px 8px;cursor:pointer}.history-item:hover{background:var(--vscode-list-hoverBackground)}.history-expression{font-family:var(--vscode-editor-font-family);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.history-value{color:var(--vscode-descriptionForeground);max-width:70px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .root-result{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:baseline;padding:8px;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);margin-bottom:8px}.value{font:13px var(--vscode-editor-font-family);overflow-wrap:anywhere}.type{color:var(--vscode-descriptionForeground);font-size:10px}.error{border-left:3px solid var(--vscode-testing-iconFailed);background:var(--vscode-inputValidation-errorBackground);padding:9px;white-space:pre-wrap}.running,.idle{color:var(--vscode-descriptionForeground);padding:8px 0}.section-label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--vscode-descriptionForeground);font-weight:700;padding:8px 0 5px}
    .tree{border:1px solid var(--vscode-panel-border)}.var-row{display:grid;grid-template-columns:minmax(120px,.9fr) minmax(140px,1.1fr) minmax(80px,.55fr);border-top:1px solid var(--vscode-panel-border);position:relative}.child-wrap:first-child>.var-row{border-top:0}.cell{min-width:0;padding:5px 7px;font-family:var(--vscode-editor-font-family);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.name{display:flex;align-items:center;gap:3px;color:var(--vscode-symbolIcon-variableForeground,var(--vscode-foreground))}.var-value{border-left:1px solid var(--vscode-panel-border)}.var-type{border-left:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:10px}.toggle{width:15px;padding:0;border:0;background:transparent;color:var(--vscode-foreground);cursor:pointer}.toggle.empty{visibility:hidden}.children{grid-column:1/-1}
    @media(max-width:800px){.main{grid-template-columns:1fr}.expressions{border-right:0;border-bottom:1px solid var(--vscode-panel-border);min-height:130px}.output{grid-template-columns:minmax(0,1fr) 180px}}
  </style></head><body><div class="shell"><div class="context"><strong>Paused:</strong>${frameLabel}</div><div class="main"><section class="expressions"><div class="pane-title"><span>Expressions</span><span class="hint">Ctrl+Enter to evaluate</span></div><div class="editor-wrap"><textarea id="expression" spellcheck="false" placeholder="Enter a Java expression…">${initialExpression}</textarea><div id="suggestions" class="suggestions" hidden></div></div><div class="actions"><button id="evaluate" class="primary">Evaluate</button><button id="clearExpression" class="secondary">Clear</button></div></section><section class="output"><div class="result-pane"><div class="pane-title" style="margin:-9px -10px 9px"><span>Output</span></div>${resultLine}${rootRows ? `<div class="section-label">Fields</div><div class="tree">${rootRows}</div>` : ''}</div><aside class="history"><div class="history-head"><span>History</span><button id="clearHistory" class="clear">Clear</button></div>${history || '<div class="idle" style="padding:10px">No evaluations</div>'}</aside></section></div></div><script nonce="${nonce}">
    const vscode=acquireVsCodeApi();const input=document.getElementById('expression');const suggestions=document.getElementById('suggestions');let completionTimer;let completionRequest=0;let activeCompletionRequest=0;let completionItems=[];let selectedCompletion=0;
    document.getElementById('evaluate').addEventListener('click',()=>vscode.postMessage({command:'evaluate',expression:input.value}));
    document.getElementById('clearExpression').addEventListener('click',()=>{input.value='';hideSuggestions();input.focus();});
    document.getElementById('clearHistory').addEventListener('click',()=>vscode.postMessage({command:'clearHistory'}));
    input.addEventListener('input',()=>scheduleCompletions(false));
    input.addEventListener('click',()=>scheduleCompletions(false));
    input.addEventListener('keydown',event=>{
      if(!suggestions.hidden&&completionItems.length){
        if(event.key==='ArrowDown'){event.preventDefault();selectedCompletion=(selectedCompletion+1)%completionItems.length;renderSuggestions();return;}
        if(event.key==='ArrowUp'){event.preventDefault();selectedCompletion=(selectedCompletion-1+completionItems.length)%completionItems.length;renderSuggestions();return;}
        if(event.key==='Escape'){event.preventDefault();hideSuggestions();return;}
        if(event.key==='Tab'||event.key==='Enter'&&!(event.ctrlKey||event.metaKey)){event.preventDefault();applyCompletion(completionItems[selectedCompletion]);return;}
      }
      if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();hideSuggestions();vscode.postMessage({command:'evaluate',expression:input.value});return;}
      if(event.ctrlKey&&event.code==='Space'){event.preventDefault();scheduleCompletions(true);}
    });
    function scheduleCompletions(force){clearTimeout(completionTimer);completionTimer=setTimeout(()=>requestCompletions(force),force?0:140);}
    function requestCompletions(force){const cursor=input.selectionStart||0;const before=input.value.slice(0,cursor);if(!force&&!/[A-Za-z0-9_$.)]$/.test(before)){hideSuggestions();return;}const requestId=++completionRequest;activeCompletionRequest=requestId;vscode.postMessage({command:'complete',requestId,expression:input.value,cursor});}
    function renderSuggestions(){if(!completionItems.length){hideSuggestions();return;}suggestions.innerHTML=completionItems.map((item,index)=>'<button class="suggestion '+(index===selectedCompletion?'selected':'')+'" data-completion="'+index+'"><span class="suggestion-label">'+esc(item.label||item.text||'')+'</span><span class="suggestion-detail">'+esc(item.detail||item.type||'')+'</span></button>').join('');suggestions.hidden=false;suggestions.querySelector('.selected')?.scrollIntoView({block:'nearest'});}
    function hideSuggestions(){completionItems=[];selectedCompletion=0;suggestions.hidden=true;suggestions.innerHTML='';}
    function applyCompletion(item){if(!item)return;const cursor=input.selectionStart||0;const start=Number.isInteger(item.start)?item.start:cursor;const end=Number.isInteger(item.end)?item.end:cursor;const text=item.text||item.label||'';input.setRangeText(text,start,end,'end');hideSuggestions();input.focus();scheduleCompletions(false);}
    suggestions.addEventListener('mousedown',event=>{event.preventDefault();const button=event.target.closest('[data-completion]');if(button)applyCompletion(completionItems[Number(button.dataset.completion)]);});
    document.addEventListener('click',event=>{const h=event.target.closest('[data-history]');if(h){vscode.postMessage({command:'history',index:Number(h.dataset.history)});return;}const b=event.target.closest('[data-ref]');if(!b)return;const id=b.dataset.node;const target=document.getElementById(id);if(!target)return;if(target.dataset.loaded==='true'){target.hidden=!target.hidden;b.textContent=target.hidden?'▸':'▾';return;}b.textContent='…';vscode.postMessage({command:'expand',nodeId:id,variablesReference:Number(b.dataset.ref)});});
    window.addEventListener('message',event=>{const m=event.data;if(m.command==='setExpression'){input.value=m.expression||'';hideSuggestions();input.focus();return;}if(m.command==='completions'){if(Number(m.requestId)!==activeCompletionRequest)return;completionItems=Array.isArray(m.completions)?m.completions:[];selectedCompletion=0;renderSuggestions();return;}if(m.command!=='expanded')return;const target=document.getElementById(m.nodeId);const button=document.querySelector('[data-node="'+m.nodeId+'"]');if(!target)return;target.innerHTML=(m.variables||[]).map((v,i)=>renderVar(v,m.nodeId+'-'+i,Number(target.dataset.depth||0)+1)).join('');target.dataset.loaded='true';target.hidden=false;if(button)button.textContent='▾';});
    function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function renderVar(v,id,depth){const ref=Number(v.variablesReference||0);const pad=depth*12;return '<div class="child-wrap"><div class="var-row"><div class="cell name" style="padding-left:'+(7+pad)+'px"><button class="toggle '+(ref?'':'empty')+'" data-ref="'+ref+'" data-node="'+id+'">▸</button><span title="'+esc(v.name)+'">'+esc(v.name)+'</span></div><div class="cell var-value" title="'+esc(v.value)+'">'+esc(v.value)+'</div><div class="cell var-type" title="'+esc(v.type||'')+'">'+esc(v.type||'')+'</div><div id="'+id+'" class="children" data-depth="'+depth+'" hidden></div></div></div>';}
    input.focus();
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

async function evaluateCurrentExpression(expressionOverride) {
  let expression = typeof expressionOverride === 'string' ? expressionOverride : '';
  if (!expression) {
    const editor = vscode.window.activeTextEditor;
    if (editor && debugEvaluateScratchUri && editor.document.uri.toString() === debugEvaluateScratchUri.toString()) {
      const selection = editor.selection;
      expression = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
    }
  }
  expression = expression
    .split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line) && !/^\s*import\s+/.test(line))
    .join('\n')
    .trim();
  if (!expression) throw new Error('Enter an expression to evaluate.');

  const session = vscode.debug.activeDebugSession || debugEvaluateSession;
  if (!session || session.type !== 'java') throw new Error('The Java debug session has ended.');
  const frame = await resolveCurrentDebugFrame(session);
  if (!frame) throw new Error('Pause the debugger at a breakpoint before evaluating.');
  debugEvaluateSession = session;
  debugEvaluateFrameId = frame.id;
  debugEvaluateCurrentFrame = frame;

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
    debugEvaluateHistory = [{ expression, model: successModel }, ...debugEvaluateHistory.filter(item => item.expression !== expression)].slice(0, 30);
    if (extensionContext) await extensionContext.workspaceState.update('debugEvaluateHistory', debugEvaluateHistory);
    renderDebugEvaluateResult(successModel);
    vscode.window.setStatusBarMessage(`$(check) ${String(result?.result ?? '').slice(0, 120) || '(no value)'}`, 5000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugEvaluateOutput.appendLine(`ERROR: ${message}`);
    const errorModel = { status: 'error', expression, message, frame };
    debugEvaluateHistory = [{ expression, model: errorModel }, ...debugEvaluateHistory.filter(item => item.expression !== expression)].slice(0, 30);
    if (extensionContext) await extensionContext.workspaceState.update('debugEvaluateHistory', debugEvaluateHistory);
    renderDebugEvaluateResult(errorModel);
    vscode.window.showErrorMessage(`Evaluate failed: ${message}`);
  }
}

async function requestDebugEvaluateCompletions(text, cursor) {
  const session = vscode.debug.activeDebugSession || debugEvaluateSession;
  if (!session || session.type !== 'java') return [];
  const frame = await resolveCurrentDebugFrame(session);
  if (!frame) return [];
  debugEvaluateSession = session;
  debugEvaluateFrameId = frame.id;

  const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  const before = text.slice(0, safeCursor);
  const lines = before.split(/\r?\n/);
  const line = lines.length;
  const column = (lines[lines.length - 1] || '').length + 1;
  let response;
  try {
    response = await session.customRequest('completions', {
      frameId: debugEvaluateFrameId,
      text,
      line,
      column
    });
  } catch (_) {
    return [];
  }

  const identifier = /[A-Za-z_$][\w$]*$/.exec(before);
  const fallbackStart = identifier ? safeCursor - identifier[0].length : safeCursor;
  return (response?.targets || []).slice(0, 250).map(target => {
    let start = fallbackStart;
    let end = safeCursor;
    if (Number.isInteger(target.start) && Number.isInteger(target.length)) {
      start = Math.max(0, Math.min(target.start, text.length));
      end = Math.max(start, Math.min(start + target.length, text.length));
    }
    return {
      label: String(target.label || target.text || ''),
      text: String(target.text || target.label || ''),
      detail: String(target.detail || target.type || ''),
      type: String(target.type || ''),
      start,
      end
    };
  }).filter(item => item.label);
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


// ---- Native Execution Replay workbench -------------------------------------------------
// Replay is intentionally modeled as workspace state, not as a Webview-local cursor. The
// normal VS Code editor remains the source editor; sidebar/panel views observe this model.
let nativeReplaySession;
let replayFilesProvider;
let instrumentationProvider;
let replayStateProvider;
let replayCallStackProvider;
let replayTimelineProvider;
let replayExecutedDecoration;
let replayCurrentDecoration;
let replayEditorColumn;

function replayEventCallId(event) {
  const value = event?.callId ?? event?.call ?? event?.invocationId;
  return value === undefined || value === null ? '' : String(value);
}
function replayEventThread(event) { return String(event?.threadId ?? event?.thread ?? 'main'); }
function replayEventSequence(event) {
  const value = Number(event?.sequence ?? event?.__index ?? 0);
  return Number.isFinite(value) ? value : 0;
}
function replaySimpleClass(event) {
  const value = String(event?.className || 'Unknown');
  return value.split('.').pop() || value;
}
function replaySameMethod(a, b) {
  return !!a && !!b && replayEventThread(a) === replayEventThread(b)
    && String(a.sourcePath || '') === String(b.sourcePath || '')
    && String(a.className || '') === String(b.className || '')
    && String(a.methodName || '') === String(b.methodName || '')
    && String(a.descriptor || '') === String(b.descriptor || '');
}
function replaySourceText(event) {
  if (!event?.sourcePath || !event.line) return '';
  try {
    const lines = fs.readFileSync(event.sourcePath, 'utf8').split(/\r?\n/);
    return String(lines[Math.max(0, Number(event.line) - 1)] || '').trim();
  } catch (_) { return ''; }
}
function replayValueLabel(value) {
  if (value === undefined) return 'not captured';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `Array (${value.length})`;
  if (typeof value === 'object') {
    if (value.display !== undefined) return String(value.display);
    if (value.value !== undefined && typeof value.value !== 'object') return String(value.value);
    if (value.summary !== undefined) return String(value.summary);
    const type = String(value.type || value.className || '').split('.').pop();
    if (type) return type;
  }
  return String(value);
}
function replayObjectFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  if (value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields)) return Object.entries(value.fields);
  const ignored = new Set(['type','className','display','identity','identityHash','id','value','summary','size','snapshotId','checkpointSequence','__fromCheckpoint','__checkpointSequence']);
  return Object.entries(value).filter(([key]) => !ignored.has(key));
}

class NativeReplaySession {
  constructor(result) {
    this.result = result;
    this.rawEvents = (result?.flowEvents || []).map((event, index) => ({ ...event, __nativeIndex: index }));
    this.normalizeBoundaryLines();
    this.entries = this.rawEvents.filter(e => e.event === 'enter').sort((a,b) => replayEventSequence(a)-replayEventSequence(b));
    this.exits = this.rawEvents.filter(e => e.event === 'exit').sort((a,b) => replayEventSequence(a)-replayEventSequence(b));
    this.entryByCallId = new Map();
    this.exitByCallId = new Map();
    for (const e of this.entries) { const id = replayEventCallId(e); if (id) this.entryByCallId.set(id, e); }
    for (const e of this.exits) { const id = replayEventCallId(e); if (id) this.exitByCallId.set(id, e); }
    this.lineEvents = this.rawEvents.filter(e => e.event === 'line' && e.sourcePath && Number(e.line || 0) > 0)
      .sort((a,b) => replayEventSequence(a)-replayEventSequence(b) || a.__nativeIndex-b.__nativeIndex);
    this.files = this.buildFiles();
    this.position = 0;
  }

  normalizeBoundaryLines() {
    // Byte Buddy entry advice can follow the first ASM line callback. Re-home that
    // first line to the callee invocation so Into/Out and state ownership agree.
    const bySequence = new Map(this.rawEvents.map(e => [replayEventSequence(e), e]));
    for (const entry of this.rawEvents) {
      if (entry.event !== 'enter') continue;
      const preceding = bySequence.get(replayEventSequence(entry) - 1);
      if (!preceding || preceding.event !== 'line') continue;
      const sameMethod = String(preceding.className || '') === String(entry.className || '')
        && String(preceding.methodName || '') === String(entry.methodName || '')
        && String(preceding.descriptor || '') === String(entry.descriptor || '');
      const sameThread = replayEventThread(preceding) === replayEventThread(entry);
      const sameDepth = Number(preceding.depth || 0) === Number(entry.depth || 0);
      const id = replayEventCallId(entry);
      if (sameMethod && sameThread && sameDepth && id) {
        preceding.__originalCallId = replayEventCallId(preceding);
        preceding.callId = id;
        preceding.invocationId = id;
      }
    }
  }

  buildFiles() {
    const map = new Map();
    for (const event of this.lineEvents) {
      const key = normalizePath(event.sourcePath);
      let file = map.get(key);
      if (!file) {
        file = { sourcePath: event.sourcePath, name: path.basename(event.sourcePath), relativePath: vscode.workspace.asRelativePath(event.sourcePath, false), lines: new Set(), classNames: new Set(), events: 0, test: /[\\/]src[\\/]test[\\/]/i.test(event.sourcePath) };
        map.set(key, file);
      }
      file.lines.add(Number(event.line));
      if (event.className) file.classNames.add(String(event.className));
      file.events++;
    }
    return [...map.values()].map(file => {
      const classNames = [...file.classNames];
      const primaryClass = classNames[0] || '';
      const packageName = primaryClass.includes('.') ? primaryClass.split('.').slice(0, -1).join('.') : '';
      return { ...file, classNames, primaryClass, packageName, lineCount: file.lines.size };
    }).sort((a,b) => Number(b.test)-Number(a.test) || b.events-a.events || a.name.localeCompare(b.name));
  }

  get current() { return this.lineEvents[this.position]; }
  setPosition(position) {
    if (!this.lineEvents.length) return;
    this.position = Math.max(0, Math.min(this.lineEvents.length - 1, Number(position) || 0));
    updateNativeReplayWorkbench().catch(error => output?.appendLine(`[replay] ${error?.stack || error}`));
  }
  first() { this.setPosition(0); }
  last() { this.setPosition(this.lineEvents.length - 1); }
  previous() { this.setPosition(this.position - 1); }
  next() { this.setPosition(this.position + 1); }

  firstLineForCall(callId, minimum = -Infinity) {
    if (!callId) return null;
    return this.lineEvents.find(e => replayEventCallId(e) === callId && replayEventSequence(e) >= minimum) || null;
  }
  indexOf(event) { return event ? this.lineEvents.indexOf(event) : -1; }
  entryForLine(event) {
    const direct = this.entryByCallId.get(replayEventCallId(event));
    if (direct) return direct;
    const seq = replayEventSequence(event);
    let best;
    for (const entry of this.entries) {
      if (replayEventThread(entry) !== replayEventThread(event)) continue;
      if (String(entry.className || '') !== String(event.className || '') || String(entry.methodName || '') !== String(event.methodName || '') || String(entry.descriptor || '') !== String(event.descriptor || '')) continue;
      const start = replayEventSequence(entry), exit = this.exitByCallId.get(replayEventCallId(entry)), end = exit ? replayEventSequence(exit) : Infinity;
      if (start <= seq + .25 && end + .25 >= seq && (!best || start > replayEventSequence(best))) best = entry;
    }
    return best;
  }
  stateForLine(event) {
    if (!event) return { receiver: undefined, locals: undefined, arguments: undefined, entry: undefined };
    const entry = this.entryForLine(event);
    // LINE events carry the state captured immediately before the source line executes.
    // The agent names these frameReceiver/frameLocals; receiver/locals are primarily
    // method-boundary fields and are only fallbacks here. Arguments normally live on ENTER.
    const receiver = event.frameReceiver !== undefined ? event.frameReceiver
      : (event.receiver !== undefined ? event.receiver : entry?.receiver);
    const locals = event.frameLocals !== undefined ? event.frameLocals
      : (event.locals !== undefined ? event.locals : event.localVariables);
    const args = event.arguments !== undefined ? event.arguments : entry?.arguments;
    return { receiver, locals, arguments: args, entry };
  }

  childEntriesFromCurrentLine(current) {
    const nextCaller = this.lineEvents.slice(this.position + 1).find(e => replaySameMethod(current, e));
    const upper = nextCaller ? replayEventSequence(nextCaller) : Infinity;
    const currentSeq = replayEventSequence(current);
    return this.entries.filter(entry => replayEventThread(entry) === replayEventThread(current)
      && String(entry.callerSourcePath || '') === String(current.sourcePath || '')
      && Number(entry.callerLine || 0) === Number(current.line || 0)
      && replayEventSequence(entry) >= currentSeq - .5 && replayEventSequence(entry) < upper)
      .sort((a,b) => replayEventSequence(a)-replayEventSequence(b));
  }
  stepInto() {
    const current = this.current; if (!current) return;
    for (const entry of this.childEntriesFromCurrentLine(current)) {
      const target = this.firstLineForCall(replayEventCallId(entry), replayEventSequence(entry) - 1);
      const index = this.indexOf(target);
      if (index >= 0) { this.setPosition(index); return; }
    }
    const thread = replayEventThread(current);
    for (let i=this.position+1;i<this.lineEvents.length;i++) if (replayEventThread(this.lineEvents[i]) === thread) { this.setPosition(i); return; }
  }
  stepOver() {
    const current = this.current; if (!current) return;
    const currentSeq = replayEventSequence(current);
    // Deliberately navigate by source method. This is the working 0.3.29 rule:
    // the first callee LINE can precede ENTER and therefore cannot be trusted as
    // frame metadata for Step Over.
    let skipThrough = currentSeq;
    for (const entry of this.childEntriesFromCurrentLine(current)) {
      const exit = this.exitByCallId.get(replayEventCallId(entry));
      if (exit) skipThrough = Math.max(skipThrough, replayEventSequence(exit));
    }
    for (let i=this.position+1;i<this.lineEvents.length;i++) {
      const event = this.lineEvents[i];
      if (replayEventSequence(event) <= skipThrough) continue;
      if (replaySameMethod(current, event)) { this.setPosition(i); return; }
    }
    const owner = this.entryForLine(current);
    const exit = owner ? this.exitByCallId.get(replayEventCallId(owner)) : null;
    const boundary = exit ? replayEventSequence(exit) : currentSeq;
    const thread = replayEventThread(current);
    for (let i=this.position+1;i<this.lineEvents.length;i++) {
      const event = this.lineEvents[i];
      if (replayEventThread(event) === thread && replayEventSequence(event) > boundary) { this.setPosition(i); return; }
    }
  }
  stepOut() {
    const current = this.current; if (!current) return;
    const entry = this.entryForLine(current); if (!entry) return;
    const callerPath = entry.callerSourcePath, callerLine = Number(entry.callerLine || 0), boundary = replayEventSequence(entry), thread = replayEventThread(current);
    if (callerPath && callerLine > 0) {
      let target = -1;
      for (let i=0;i<this.lineEvents.length;i++) {
        const event = this.lineEvents[i];
        if (replayEventThread(event) !== thread || String(event.sourcePath || '') !== String(callerPath) || Number(event.line || 0) !== callerLine) continue;
        if (replayEventSequence(event) >= boundary) continue;
        target = i;
      }
      if (target >= 0) { this.setPosition(target); return; }
    }
  }
  occurrencesForLocation(sourcePath, line) {
    const source = normalizePath(sourcePath || '');
    const targetLine = Number(line || 0);
    if (!source || targetLine <= 0) return [];
    return this.lineEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => normalizePath(event.sourcePath || '') === source && Number(event.line || 0) === targetLine)
      .map(({ index }) => index);
  }
  seekToSourceLine(sourcePath, line) {
    const occurrences = this.occurrencesForLocation(sourcePath, line);
    if (!occurrences.length) return false;

    // A source click is random-access navigation. For repeated lines (loops, retries,
    // recursion), land on the occurrence closest to the replay position the developer
    // is currently investigating instead of arbitrarily rewinding to occurrence #1.
    let target = occurrences[0];
    let distance = Math.abs(target - this.position);
    for (const candidate of occurrences.slice(1)) {
      const candidateDistance = Math.abs(candidate - this.position);
      if (candidateDistance < distance || (candidateDistance === distance && candidate >= this.position && target < this.position)) {
        target = candidate;
        distance = candidateDistance;
      }
    }
    this.setPosition(target);
    return true;
  }
  occurrences() {
    const current = this.current; if (!current) return [];
    return this.occurrencesForLocation(current.sourcePath, current.line);
  }
  moveOccurrence(delta) {
    const occurrences = this.occurrences(); if (!occurrences.length) return;
    let cursor = occurrences.indexOf(this.position); if (cursor < 0) cursor = 0;
    cursor = Math.max(0, Math.min(occurrences.length - 1, cursor + delta)); this.setPosition(occurrences[cursor]);
  }
  callStack() {
    const current = this.current; if (!current) return [];
    const seq = replayEventSequence(current), thread = replayEventThread(current);
    return this.entries.filter(entry => {
      if (replayEventThread(entry)!==thread) return false;
      const start=replayEventSequence(entry), exit=this.exitByCallId.get(replayEventCallId(entry)), end=exit?replayEventSequence(exit):Infinity;
      return start <= seq + .25 && end + .25 >= seq;
    }).sort((a,b)=>Number(a.depth||0)-Number(b.depth||0) || replayEventSequence(a)-replayEventSequence(b));
  }
}

class ReplayFilesProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren() {
    if (!nativeReplaySession) return [];
    return nativeReplaySession.files.map(file => {
      const item = new vscode.TreeItem(file.name, vscode.TreeItemCollapsibleState.None);
      item.description = `${file.lineCount} lines · ${file.events} events`;
      item.tooltip = `${file.relativePath}\n${file.lineCount} executed lines · ${file.events} replay events`;
      item.iconPath = new vscode.ThemeIcon(file.test ? 'beaker' : 'file-code');
      item.contextValue = file.test ? 'replayTestFile' : 'replaySourceFile';
      item.command = { command:'compositeGradleTests.replay.openFile', title:'Open Executed File', arguments:[file] };
      return item;
    });
  }
}

class ReplayInstrumentationProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren(parent) {
    const includes = flowPackagePrefixes();
    if (!parent) {
      const roots = [];
      const includeRoot = new vscode.TreeItem(`Included Packages / Classes (${includes.length})`, vscode.TreeItemCollapsibleState.Expanded);
      includeRoot.contextValue = 'replayInstrumentationIncludeRoot'; includeRoot.__kind = 'includeRoot'; roots.push(includeRoot);
      if (nativeReplaySession?.files?.length) {
        const previousRoot = new vscode.TreeItem(`Previous Run (${nativeReplaySession.files.length} files)`, vscode.TreeItemCollapsibleState.Expanded);
        previousRoot.contextValue = 'replayInstrumentationPreviousRoot'; previousRoot.__kind = 'previousRoot'; roots.push(previousRoot);
      }
      return roots;
    }
    if (parent.__kind === 'includeRoot') return includes.map(prefix => this.prefixItem(prefix, 'include'));
    if (parent.__kind === 'previousRoot') return nativeReplaySession.files.map(file => this.fileItem(file));
    return [];
  }
  prefixItem(prefix, kind) {
    const item = new vscode.TreeItem(prefix, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(kind === 'include' ? 'check' : 'circle-slash');
    item.contextValue = kind === 'include' ? 'replayInstrumentationIncludedPrefix' : 'replayInstrumentationExcludedPrefix';
    item.__kind = kind; item.prefix = prefix;
    item.tooltip = kind === 'include' ? `Instrument ${prefix}` : `Do not instrument ${prefix}`;
    return item;
  }
  fileItem(file) {
    const className = file.primaryClass || '';
    const status = flowInstrumentationStatus(className);
    const item = new vscode.TreeItem(file.name, vscode.TreeItemCollapsibleState.None);
    item.description = file.packageName || file.relativePath;
    item.iconPath = new vscode.ThemeIcon(status === 'included' ? 'check' : 'history');
    item.contextValue = 'replayInstrumentationPreviousFile';
    item.__kind = 'file'; item.file = file; item.className = className; item.packageName = file.packageName;
    const statusText = status === 'included' ? 'explicitly included' : 'captured by automatic test/package instrumentation';
    item.tooltip = `${file.relativePath}\n${className || 'Class name unavailable'}\nPrevious run: ${file.lineCount} lines · ${file.events} events\nInstrumentation: ${statusText}`;
    return item;
  }
}

class ReplayValueItem extends vscode.TreeItem {
  constructor(label, value, depth=0) {
    const fields = depth < 5 ? replayObjectFields(value) : [];
    const array = Array.isArray(value) && depth < 5 ? value.map((v,i)=>[`[${i}]`,v]) : [];
    const children = fields.length ? fields : array;
    super(String(label), children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.value = value; this.depth = depth; this.children = children;
    this.description = replayValueLabel(value);
    this.tooltip = `${label}: ${replayValueLabel(value)}`;
    this.iconPath = new vscode.ThemeIcon(children.length ? 'symbol-object' : 'symbol-field');
  }
}
class ReplayStateProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData=this.emitter.event; }
  refresh(){this.emitter.fire();}
  getTreeItem(item){return item;}
  getChildren(parent) {
    if (!nativeReplaySession?.current) return [];
    if (parent instanceof ReplayValueItem) return parent.children.map(([k,v])=>new ReplayValueItem(k,v,parent.depth+1));
    const e=nativeReplaySession.current, out=[];
    const state=nativeReplaySession.stateForLine(e);
    if (state.receiver !== undefined) out.push(new ReplayValueItem('this',state.receiver));
    const args=state.arguments;
    if (args !== undefined) {
      if (Array.isArray(args)) args.forEach((v,i)=>out.push(new ReplayValueItem(`arg ${i}`,v)));
      else if (args && typeof args==='object') Object.entries(args).forEach(([k,v])=>out.push(new ReplayValueItem(k,v)));
      else out.push(new ReplayValueItem('arguments',args));
    }
    const locals=state.locals;
    if (locals && typeof locals==='object') {
      Object.entries(locals)
        .filter(([name])=>{ const text=String(name||''); if(!text.startsWith('slot')) return true; const suffix=text.slice(4); return !suffix || String(Number(suffix))!==suffix; })
        .forEach(([k,v])=>out.push(new ReplayValueItem(k,v)));
    }
    if (!out.length) {
      const empty=new vscode.TreeItem('No state captured'); empty.description='for this line'; empty.iconPath=new vscode.ThemeIcon('info'); out.push(empty);
    }
    return out;
  }
}
class ReplayCallStackProvider {
  constructor(){this.emitter=new vscode.EventEmitter();this.onDidChangeTreeData=this.emitter.event;}
  refresh(){this.emitter.fire();}
  getTreeItem(item){return item;}
  getChildren(){
    if(!nativeReplaySession)return[];
    return nativeReplaySession.callStack().map(entry=>{
      const label=`${replaySimpleClass(entry)}.${entry.methodName || '?'}()`;
      const item=new vscode.TreeItem(label,vscode.TreeItemCollapsibleState.None);
      item.description=entry.sourceFile && entry.line ? `${entry.sourceFile}:${entry.line}` : `depth ${entry.depth || 0}`;
      item.iconPath=new vscode.ThemeIcon('debug-stackframe');
      if(entry.sourcePath && entry.line)item.command={command:'compositeGradleTests.replay.openLocation',title:'Open Replay Frame',arguments:[entry.sourcePath,Number(entry.line)]};
      return item;
    });
  }
}

class ReplayTimelineProvider {
  constructor(){this.view=undefined;this.searchQuery='';}
  resolveWebviewView(view){
    this.view=view; view.webview.options={enableScripts:true};
    view.webview.onDidReceiveMessage(message=>{
      if(message.command==='search'){this.searchQuery=String(message.query||'');return;}
      if(!nativeReplaySession)return;
      if(message.command==='seek')nativeReplaySession.setPosition(Number(message.index));
      else if(message.command==='into')nativeReplaySession.stepInto();
      else if(message.command==='over')nativeReplaySession.stepOver();
      else if(message.command==='out')nativeReplaySession.stepOut();
      else if(message.command==='previous')nativeReplaySession.previous();
      else if(message.command==='next')nativeReplaySession.next();
    });
    this.render();
  }
  render(){
    if(!this.view)return;
    const session=nativeReplaySession;
    if(!session){this.view.webview.html='<!doctype html><body style="font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding:12px">Run a test with Code Flow, then open Execution Replay.</body>';return;}
    const events=session.lineEvents.map((e,index)=>({index,sequence:e.sequence??e.__nativeIndex,file:e.sourceFile||path.basename(e.sourcePath||''),line:Number(e.line||0),method:`${replaySimpleClass(e)}.${e.methodName||'?'}()`,text:replaySourceText(e)}));
    const payload=JSON.stringify({events,position:session.position,title:session.result?.displayName||'Test',query:this.searchQuery}).replace(/</g,'\\u003c');
    this.view.webview.html=`<!doctype html><html><head><meta charset="UTF-8"><style>
      *{box-sizing:border-box}html,body{height:100%;margin:0}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-panel-background,var(--vscode-editor-background));overflow:hidden}.app{height:100%;display:grid;grid-template-rows:auto 1fr}.bar{display:flex;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-editor-background) 72%,transparent)}input{flex:1;min-width:120px;height:27px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;padding:4px 8px;outline:none}input:focus{border-color:var(--vscode-focusBorder)}.status{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}.rows{overflow:auto;font-family:var(--vscode-editor-font-family);font-size:12px;padding:2px 0}.row{position:relative;width:100%;display:grid;grid-template-columns:48px minmax(0,1fr);grid-template-areas:'seq head' '. code';column-gap:10px;row-gap:3px;padding:6px 10px 7px;border:0;border-bottom:1px solid color-mix(in srgb,var(--vscode-panel-border) 42%,transparent);background:transparent;color:inherit;text-align:left;cursor:pointer;min-height:39px}.row:hover{background:var(--vscode-list-hoverBackground)}.row.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.row.active:before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--vscode-focusBorder)}.seq{grid-area:seq;color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums;white-space:nowrap;padding-top:1px}.head{grid-area:head;display:flex;align-items:baseline;gap:8px;min-width:0}.method{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650;color:var(--vscode-foreground)}.loc{flex:0 1 auto;min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-size:11px}.loc:before{content:'·';margin-right:8px;opacity:.7}.code{grid-area:code;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--vscode-editor-foreground);opacity:.82;font-size:11px}.row.active .seq,.row.active .loc,.row.active .code{color:inherit;opacity:.86}@media(max-width:620px){.row{grid-template-columns:40px minmax(0,1fr);column-gap:7px;padding-left:8px;padding-right:8px}.loc{max-width:38%}.bar{padding-left:8px;padding-right:8px}}.hidden{display:none}</style></head><body><div class="app"><div class="bar"><input id="search" placeholder="Search replay — AND terms separated by spaces…"><span id="status" class="status"></span></div><div id="rows" class="rows"></div></div><script>
      const vscode=acquireVsCodeApi(),model=${payload},root=document.getElementById('rows'),search=document.getElementById('search'),status=document.getElementById('status');let query=String(model.query||'');
      const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
      function terms(){return query.trim().toLowerCase().split(/\\s+/).filter(Boolean)}
      function render(){root.innerHTML='';let shown=0;const needles=terms();for(const e of model.events){const hay=[e.sequence,e.method,e.file,e.line,e.text,e.file+':'+e.line].join(' ').toLowerCase();if(needles.length&&!needles.every(term=>hay.includes(term)))continue;shown++;const b=document.createElement('button');b.className='row '+(e.index===model.position?'active':'');b.title=e.method+'  '+e.file+':'+e.line+'\\n'+e.text;b.innerHTML='<span class="seq">#'+esc(e.sequence)+'</span><span class="head"><span class="method">'+esc(e.method)+'</span><span class="loc">'+esc(e.file)+':'+e.line+'</span></span><span class="code">'+esc(e.text)+'</span>';b.onclick=()=>vscode.postMessage({command:'seek',index:e.index});root.appendChild(b)}status.textContent=(model.position+1)+' / '+model.events.length+(needles.length?' · '+shown+' matches':'');requestAnimationFrame(()=>root.querySelector('.active')?.scrollIntoView({block:'center'}))}
      search.value=query;search.oninput=()=>{query=search.value;vscode.postMessage({command:'search',query});render()};render();</script></body></html>`;
  }
}

async function openReplayEditorLocation(sourcePath, line, preserveFocus=false) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return;
  const document=await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  const targetLine=Math.max(0,Math.min(document.lineCount-1,Number(line||1)-1));
  const targetColumn = replayEditorColumn || vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
  const editor=await vscode.window.showTextDocument(document,{preview:true,preserveFocus,viewColumn:targetColumn});
  const position=new vscode.Position(targetLine,Math.min(document.lineAt(targetLine).firstNonWhitespaceCharacterIndex,document.lineAt(targetLine).text.length));
  editor.selection=new vscode.Selection(position,position);
  editor.revealRange(document.lineAt(targetLine).range,vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  applyReplayDecorations(editor);
}
function applyReplayDecorations(editor) {
  if(!nativeReplaySession||!editor)return;
  const source=normalizePath(editor.document.uri.fsPath);
  const lines=[...new Set(nativeReplaySession.lineEvents.filter(e=>normalizePath(e.sourcePath)===source).map(e=>Number(e.line||0)).filter(Boolean))];
  editor.setDecorations(replayExecutedDecoration,lines.map(line=>editor.document.lineAt(Math.max(0,Math.min(editor.document.lineCount-1,line-1))).range));
  const current=nativeReplaySession.current;
  const currentRanges=current&&normalizePath(current.sourcePath)===source?[editor.document.lineAt(Math.max(0,Math.min(editor.document.lineCount-1,Number(current.line||1)-1))).range]:[];
  editor.setDecorations(replayCurrentDecoration,currentRanges);
}
async function updateNativeReplayWorkbench() {
  const session=nativeReplaySession;if(!session)return;
  replayFilesProvider?.refresh();instrumentationProvider?.refresh();replayStateProvider?.refresh();replayCallStackProvider?.refresh();replayTimelineProvider?.render();
  for(const editor of vscode.window.visibleTextEditors)applyReplayDecorations(editor);
  const current=session.current;if(current)await openReplayEditorLocation(current.sourcePath,current.line,false);
  vscode.commands.executeCommand('setContext','compositeGradleTests.replayActive',true);
  const occ=session.occurrences(),occIndex=occ.indexOf(session.position);
  const status=`Replay ${session.position+1}/${session.lineEvents.length}${occ.length>1?` · occurrence ${occIndex+1}/${occ.length}`:''}`;
  vscode.window.setStatusBarMessage(status,1800);
}
async function openNativeReplay(result) {
  if(!result?.flowEvents?.some(event=>event.event==='line')){
    vscode.window.showWarningMessage('Composite Gradle Tests: this result has no ordered replay lines. Run the test with Code Flow first.');return;
  }
  // Remember the editor group the developer is currently working in before any Replay
  // sidebar/panel receives focus. All replay source navigation stays in that group.
  replayEditorColumn = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;
  nativeReplaySession=new NativeReplaySession(result);
  await vscode.commands.executeCommand('setContext','compositeGradleTests.replayActive',true);
  const first=nativeReplaySession.current;
  if(first) await openReplayEditorLocation(first.sourcePath,first.line,false);
  // Custom view containers are public workbench surfaces. VS Code exposes the generated
  // workbench.view.extension.<container id> command for revealing them.
  await vscode.commands.executeCommand('workbench.view.extension.compositeGradleTests.replay');
  try{await vscode.commands.executeCommand('workbench.view.extension.compositeGradleTests.replayPanel');}catch(_){}
  await updateNativeReplayWorkbench();
}
function closeNativeReplay() {
  nativeReplaySession=undefined;
  replayEditorColumn=undefined;
  replayFilesProvider?.refresh();instrumentationProvider?.refresh();replayStateProvider?.refresh();replayCallStackProvider?.refresh();replayTimelineProvider?.render();
  for(const editor of vscode.window.visibleTextEditors){editor.setDecorations(replayExecutedDecoration,[]);editor.setDecorations(replayCurrentDecoration,[]);}
  vscode.commands.executeCommand('setContext','compositeGradleTests.replayActive',false);
}
function showFlowReplayPanel(result){ return openNativeReplay(result); }


function deactivate() {
  if (runningProcess) terminateProcessTree(runningProcess);
  debugEvaluatePanel?.panel?.dispose();
  debugEvaluateResultPanel = undefined;
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

  replayExecutedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });
  replayCurrentDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('debugIcon.startForeground'),
    overviewRulerColor: new vscode.ThemeColor('debugIcon.startForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    after: { contentText: '  ◀ REPLAY', color: new vscode.ThemeColor('debugIcon.startForeground'), fontStyle: 'italic' }
  });
  replayFilesProvider = new ReplayFilesProvider();
  instrumentationProvider = new ReplayInstrumentationProvider();
  replayStateProvider = new ReplayStateProvider();
  replayCallStackProvider = new ReplayCallStackProvider();
  replayTimelineProvider = new ReplayTimelineProvider();
  context.subscriptions.push(replayExecutedDecoration, replayCurrentDecoration);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('compositeGradleTests.replayFiles', replayFilesProvider));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('compositeGradleTests.replayInstrumentation', instrumentationProvider));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('compositeGradleTests.replayState', replayStateProvider));
  context.subscriptions.push(vscode.window.registerTreeDataProvider('compositeGradleTests.replayCallStack', replayCallStackProvider));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('compositeGradleTests.replayTimeline', replayTimelineProvider, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.open', async () => {
    const result = testHistory.find(item => item?.flowEvents?.some(event => event.event === 'line'));
    if (result) await openNativeReplay(result); else vscode.window.showWarningMessage('Composite Gradle Tests: no captured execution replay is available yet.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.openLegacy', () => {
    const result = nativeReplaySession?.result || testHistory.find(item => item?.flowEvents?.some(event => event.event === 'line'));
    if (result) showLegacyFlowReplayPanel(result);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.exit', closeNativeReplay));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.first', () => nativeReplaySession?.first()));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.previous', () => nativeReplaySession?.previous()));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.stepInto', () => nativeReplaySession?.stepInto()));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.stepOver', () => nativeReplaySession?.stepOver()));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.stepOut', () => nativeReplaySession?.stepOut()));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.next', () => nativeReplaySession?.next()));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.last', () => nativeReplaySession?.last()));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.previousOccurrence', () => nativeReplaySession?.moveOccurrence(-1)));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.nextOccurrence', () => nativeReplaySession?.moveOccurrence(1)));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.instrumentation.addInclude', async () => {
    const value = await vscode.window.showInputBox({ prompt: 'Package or fully-qualified class to instrument', placeHolder: 'com.mycompany.orders' });
    const prefix = normalizeFlowPrefix(value); if (!prefix) return;
    await updateFlowPrefixSetting('flowPackagePrefixes', values => [...values, prefix]);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.instrumentation.addExclude', async () => vscode.window.showInformationMessage('Replay exclusions are temporarily disabled in 0.4.9 while additional-package instrumentation is restored.')));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.instrumentation.removePrefix', async item => {
    if (!item?.prefix) return;
    const key = item.__kind === 'exclude' ? 'flowExcludePrefixes' : 'flowPackagePrefixes';
    await updateFlowPrefixSetting(key, values => values.filter(v => v !== item.prefix));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.instrumentation.includeFile', async item => {
    const prefix = normalizeFlowPrefix(item?.className || item?.file?.primaryClass); if (!prefix) return;
    await updateFlowPrefixSetting('flowPackagePrefixes', values => [...values, prefix]);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.instrumentation.excludeFile', async () => vscode.window.showInformationMessage('Replay exclusions are temporarily disabled in 0.4.9 while additional-package instrumentation is restored.')));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.instrumentation.includePackage', async item => {
    const prefix = normalizeFlowPrefix(item?.packageName || item?.file?.packageName); if (!prefix) return;
    await updateFlowPrefixSetting('flowPackagePrefixes', values => [...values, prefix]);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.instrumentation.excludePackage', async () => vscode.window.showInformationMessage('Replay exclusions are temporarily disabled in 0.4.9 while additional-package instrumentation is restored.')));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.openFile', async file => {
    if (!nativeReplaySession || !file?.sourcePath) return;
    const index=nativeReplaySession.lineEvents.findIndex(event=>normalizePath(event.sourcePath)===normalizePath(file.sourcePath));
    if(index>=0)nativeReplaySession.setPosition(index);else await openReplayEditorLocation(file.sourcePath,1,false);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests.replay.openLocation', (sourcePath,line) => openReplayEditorLocation(sourcePath,line,false)));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    if (!nativeReplaySession || event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
    const editor = event.textEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;

    // The normal editor is the Replay navigation surface: clicking an executed line
    // seeks the captured execution directly to that source location. Non-executed
    // lines retain normal VS Code cursor behavior and do not alter Replay.
    const line = Number(event.selections?.[0]?.active?.line ?? -1) + 1;
    if (line <= 0) return;
    nativeReplaySession.seekToSourceLine(editor.document.uri.fsPath, line);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('compositeGradleTests.flowPackagePrefixes')) instrumentationProvider?.refresh();
  }));
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(editors => { if(nativeReplaySession)for(const editor of editors)applyReplayDecorations(editor); }));
};
