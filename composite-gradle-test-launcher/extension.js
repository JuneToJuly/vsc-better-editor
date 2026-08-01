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
let lastPassedDecoration;
let lastFailedDecoration;
const invalidatedSourcePaths = new Set();
const latestResults = new Map();

async function activate(context) {
  extensionContext = context;
  testHistory = context.workspaceState.get('testHistory', []);
  debugEvaluateHistory = context.workspaceState.get('debugEvaluateHistory', []);
  output = vscode.window.createOutputChannel('Composite Gradle Tests');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  statusItem.command = 'compositeGradleTests.stop';
  debugEvaluateOutput = vscode.window.createOutputChannel('Composite Gradle Evaluate');
  context.subscriptions.push(output, debugEvaluateOutput, statusItem);

  register(context, 'compositeGradleTests.runMethod', () => launchFromEditor('method', false));
  register(context, 'compositeGradleTests.debugMethod', () => launchFromEditor('method', true));
  register(context, 'compositeGradleTests.runClass', () => launchFromEditor('class', false));
  register(context, 'compositeGradleTests.debugClass', () => launchFromEditor('class', true));
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
  context.subscriptions.push(lastPassedDecoration, lastFailedDecoration);

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

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.languageId === 'java') {
      invalidatedSourcePaths.add(normalizePath(event.document.uri.fsPath));
      codeLensProviderInstance.refresh();
      refreshLastRunDecorations();
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

async function launchFromEditor(scope, debug, providedTarget) {
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
  await executeInvocation(invocation);
}

async function repeatLast() {
  if (!lastInvocation) {
    throw new Error('No test has been run yet.');
  }
  await executeInvocation({ ...lastInvocation });
}

async function openLastTest() {
  const result = testHistory[0];
  const invocation = result?.invocation || lastInvocation;
  const sourcePath = result?.sourcePath || invocation?.sourcePath;
  if (!sourcePath) {
    throw new Error('No previously run test source is available.');
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  let line = Number.isInteger(invocation?.targetLine) ? invocation.targetLine : undefined;
  let character = Number.isInteger(invocation?.targetCharacter) ? invocation.targetCharacter : 0;
  if (!Number.isInteger(line)) {
    const target = await findTargetByFilter(document, result?.filter || invocation?.filter, invocation?.scope);
    line = target?.range?.start?.line || 0;
    character = target?.range?.start?.character || 0;
  }
  const position = new vscode.Position(Math.max(0, Math.min(line, document.lineCount - 1)), Math.max(0, character));
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(document.lineAt(position.line).range, vscode.TextEditorRevealType.InCenter);
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
  const args = [task, '--tests', target.filter, ...config.get('arguments', ['--console=plain'])];

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
    targetCharacter: target.range?.start?.character
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

async function executeInvocation(invocation) {
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

  lastInvocation = invocation;
  output.clear();
  output.appendLine(`> ${formatCommand(invocation.executable, invocation.args)}`);
  output.appendLine(`cwd: ${invocation.cwd}`);
  output.appendLine('');
  if (invocation.showOutput) output.show(true);

  const runningResult = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    invocation: { ...invocation, args: [...invocation.args] }
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
      output: rawOutput,
      exitCode: code
    };

    await recordResult(result);
    showResultsView(result);
    latestResults.set(invocation.filter, result);

    if (parsed.status === 'passed') {
      vscode.window.setStatusBarMessage(`$(testing-passed-icon) ${invocation.displayName} passed (${seconds}s)`, 5000);
    } else if (parsed.status === 'failed') {
      vscode.window.setStatusBarMessage(`$(testing-failed-icon) ${invocation.displayName} failed (${seconds}s)`, 8000);
    } else if (code !== null) {
      vscode.window.showErrorMessage(`${invocation.displayName} could not be completed. See test results.`);
    }
  });
}

function ensureTestLoggingInitScript() {
  if (!extensionContext) throw new Error('Extension context is unavailable.');
  const directory = extensionContext.globalStorageUri.fsPath;
  fs.mkdirSync(directory, { recursive: true });
  const scriptPath = path.join(directory, 'composite-test-logging.init.gradle');
  const contents = `
allprojects {
    tasks.withType(org.gradle.api.tasks.testing.Test).configureEach {
        testLogging {
            events "passed", "failed", "skipped", "standardOut", "standardError"
            showStandardStreams = true
            exceptionFormat = "full"
            showExceptions = true
            showCauses = true
            showStackTraces = true
        }
    }
}
`;
  if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf8') !== contents) {
    fs.writeFileSync(scriptPath, contents, 'utf8');
  }
  return scriptPath;
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
      } else if (message.command === 'openSource' || message.command === 'openLocation') {
        let sourcePath = selected.sourcePath;
        if (message.command === 'openLocation') {
          sourcePath = await resolveFailureSourcePath(selected, message.file, message.className) || sourcePath;
        }
        if (!sourcePath) throw new Error('The source file for this result could not be located.');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
        const editor = await vscode.window.showTextDocument(document, { preview: false });
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
        editor.selection = new vscode.Selection(position, position);
        const range = document.lineAt(position.line).range;
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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
    .detail-wrap{min-height:0;flex:1 1 auto;display:flex;flex-direction:column;background:var(--vscode-sideBar-background)}.detail-label{flex:0 0 auto;padding:9px 10px 7px;border-top:5px solid color-mix(in srgb,var(--vscode-focusBorder) 45%,var(--vscode-panel-border));border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-sideBar-background) 82%,var(--vscode-editor-background))}.detail{min-height:0;overflow:auto;padding:12px 12px 28px;scroll-behavior:smooth}.hero{display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;align-items:start}.hero .big{font-size:20px;line-height:1}.hero h1{font-size:14px;font-weight:650;line-height:1.25;margin:0;word-break:break-word}.subtitle{margin-top:3px;color:var(--vscode-descriptionForeground);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.subtitle code{font-family:var(--vscode-editor-font-family);font-size:10px}
    .actions{display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin:10px 0 0;padding:6px 0;border-top:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border)}.actions button{border:0;border-radius:3px;padding:3px 6px;cursor:pointer;background:transparent;color:var(--vscode-foreground);font-size:11px}.actions button:hover{background:var(--vscode-toolbar-hoverBackground)}.actions .primary{color:var(--vscode-textLink-foreground);font-weight:600}.actions .separator{width:1px;height:14px;background:var(--vscode-panel-border);margin:0 2px}.actions .raw{margin-left:auto;color:var(--vscode-descriptionForeground)}
    .status.passed{color:var(--vscode-testing-iconPassed)}.status.failed{color:var(--vscode-testing-iconFailed)}.status.skipped{color:var(--vscode-testing-iconSkipped)}.status.running{color:var(--vscode-progressBar-background)}.status.stopped{color:var(--vscode-descriptionForeground)}
    .section{margin-top:16px}.failure-section{margin-top:12px}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}.section h3{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--vscode-descriptionForeground);margin:0}.console{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.55;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-radius:var(--radius);padding:9px 10px;margin:0;max-height:260px;overflow:auto}.failure-nav{display:flex;gap:5px;overflow-x:auto;padding:0 0 8px;margin-bottom:4px}.failure-nav button{flex:0 0 auto;max-width:220px;border:1px solid var(--vscode-panel-border);border-radius:999px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:4px 8px;cursor:pointer;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.failure-nav button span{color:var(--vscode-testing-iconFailed);margin-right:5px}.failure-nav button:hover{background:var(--vscode-button-secondaryHoverBackground)}.failure-groups{display:flex;flex-direction:column;gap:16px}.failure-group{min-width:0}.failure-test{display:flex;align-items:center;gap:7px;margin:0 0 6px 1px;padding-top:2px;font-family:var(--vscode-editor-font-family);font-size:11px;font-weight:600}.failure-test-mark{color:var(--vscode-testing-iconFailed);font-size:13px}.failure-card{scroll-margin-top:10px;border:1px solid color-mix(in srgb,var(--vscode-testing-iconFailed) 60%,var(--vscode-panel-border));border-left:3px solid var(--vscode-testing-iconFailed);border-radius:var(--radius);background:color-mix(in srgb,var(--vscode-testing-iconFailed) 5%,var(--vscode-textCodeBlock-background));overflow:hidden}.failure-head{padding:9px 10px;border-bottom:1px solid var(--vscode-panel-border)}.failure-type{font-family:var(--vscode-editor-font-family);font-size:11px;font-weight:700}.failure-message{font-size:11px;margin-top:3px;color:var(--vscode-descriptionForeground)}.comparison{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--vscode-panel-border)}.comparison>div{padding:8px 10px;min-width:0}.comparison>div+div{border-left:1px solid var(--vscode-panel-border)}.comparison label{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin-bottom:3px}.comparison code{font-family:var(--vscode-editor-font-family);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.location{display:block;width:100%;border:0;background:transparent;text-align:left;color:var(--vscode-textLink-foreground);cursor:pointer;padding:7px 10px;font-family:var(--vscode-editor-font-family);font-size:11px}.location:hover{background:var(--vscode-toolbar-hoverBackground)}.frames{margin:0;padding:8px 10px;white-space:pre;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:10px;line-height:1.55}.framework-toggle{width:100%;border:0;border-top:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer;text-align:left;padding:6px 10px;font-size:10px}.framework-toggle:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.framework-frames{display:none;border-top:1px solid var(--vscode-panel-border)}.framework-frames.open{display:block}
    .event-list{display:flex;flex-direction:column;gap:3px}.event{width:100%;border:0;text-align:left;background:transparent;color:inherit;display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:6px;padding:5px 6px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px}.event:hover{background:var(--vscode-list-hoverBackground)}.event .event-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.event-open{font-family:var(--vscode-font-family);font-size:9px;color:var(--vscode-textLink-foreground);opacity:0}.event.failed:hover .event-open,.event.failed:focus .event-open{opacity:1}.event.failed{cursor:pointer}.event.passed .event-mark{color:var(--vscode-testing-iconPassed)}.event.failed .event-mark{color:var(--vscode-testing-iconFailed)}.event.skipped .event-mark{color:var(--vscode-testing-iconSkipped)}
    .empty-output{padding:8px 10px;border:1px dashed var(--vscode-panel-border);border-radius:var(--radius);color:var(--vscode-descriptionForeground);font-size:11px}.empty-state{min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--vscode-descriptionForeground);gap:5px}.empty-state strong{color:var(--vscode-foreground);font-size:13px}.empty-icon{font-size:24px}
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

  return `<div class="hero"><span class="big status ${escapeHtml(result.status)}">${statusGlyph(result.status)}</span><div><h1>${escapeHtml(simpleName)}</h1><div class="subtitle" title="${escapeHtml(result.filter)}">${escapeHtml(subtitle)}</div></div></div>
    <div class="actions"><button class="primary" data-command="rerun" data-id="${escapeHtml(result.id)}">↻ ${rerunLabel}</button><button data-command="debug" data-id="${escapeHtml(result.id)}">◇ ${debugLabel}</button><span class="separator"></span><button data-command="openSource" data-id="${escapeHtml(result.id)}">Open</button><button data-command="copy" data-id="${escapeHtml(result.id)}">Copy</button><button class="raw" data-command="raw" data-id="${escapeHtml(result.id)}">Raw</button></div>
    ${failureSection}${consoleSection}${resultSection}`;
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
  if (!annotationNames) return { classes, methods };

  // This intentionally targets annotated test methods rather than attempting
  // to parse the complete Java grammar. It supports modifiers, generics,
  // arrays, throws clauses, and annotations on the same or previous lines.
  const methodPattern = new RegExp(
    `((?:\\s*@(?:${annotationNames})\\b(?:\\s*\\([^)]*\\))?\\s*)+)` +
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
      isTest: true
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
      return this.tasks.map(task => this.taskItem(task));
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
  const document=await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  const editor=await vscode.window.showTextDocument(document,{preview:false});
  const position=new vscode.Position(Math.max(0,Math.min(line,document.lineCount-1)),0);
  editor.selection=new vscode.Selection(position,position);
  editor.revealRange(document.lineAt(position.line).range,vscode.TextEditorRevealType.InCenter);
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
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'java', scheme: 'untitled' }, new DebugEvaluateCompletionProvider(), '.'));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    const active = !!editor && !!debugEvaluateScratchUri && editor.document.uri.toString() === debugEvaluateScratchUri.toString();
    vscode.commands.executeCommand('setContext', 'compositeGradleTests.evaluateEditorActive', active);
  }));
  context.subscriptions.push(vscode.workspace.onDidCreateFiles(() => projectTestsProvider.refresh()));
  context.subscriptions.push(vscode.workspace.onDidDeleteFiles(() => projectTestsProvider.refresh()));
  context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => projectTestsProvider.refresh()));
};
