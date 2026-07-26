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
const latestResults = new Map();

async function activate(context) {
  extensionContext = context;
  testHistory = context.workspaceState.get('testHistory', []);
  output = vscode.window.createOutputChannel('Composite Gradle Tests');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  statusItem.command = 'compositeGradleTests.stop';
  context.subscriptions.push(output, statusItem);

  register(context, 'compositeGradleTests.runMethod', () => launchFromEditor('method', false));
  register(context, 'compositeGradleTests.debugMethod', () => launchFromEditor('method', true));
  register(context, 'compositeGradleTests.runClass', () => launchFromEditor('class', false));
  register(context, 'compositeGradleTests.debugClass', () => launchFromEditor('class', true));
  register(context, 'compositeGradleTests.repeatLast', repeatLast);
  register(context, 'compositeGradleTests.stop', stopCurrent);
  register(context, 'compositeGradleTests.copyLastCommand', copyLastCommand);
  register(context, 'compositeGradleTests.showResults', () => showResultsView());
  register(context, 'compositeGradleTests.showHistory', () => showResultsView());
  register(context, 'compositeGradleTests.clearHistory', clearHistory);

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
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    codeLensProviderInstance.refresh();
  }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    if (event.textEditor.document.languageId === 'java') codeLensProviderInstance.refresh();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.languageId === 'java') codeLensProviderInstance.refresh();
  }));
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

  const invocation = createInvocation(editor.document.uri, target, debug);
  await executeInvocation(invocation);
}

async function repeatLast() {
  if (!lastInvocation) {
    throw new Error('No test has been run yet.');
  }
  await executeInvocation({ ...lastInvocation });
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

function createInvocation(documentUri, target, debug) {
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
    showOutput: config.get('showOutput', false),
    documentUri: documentUri.toString(),
    sourcePath: documentUri.fsPath,
    scope: target.scope || (target.filter === target.classFilter ? 'class' : 'method'),
    classFilter: target.classFilter || target.filter,
    classDisplayName: target.classDisplayName || target.displayName
  };
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

  const includedBuildRoot = findIncludedBuildRoot(projectDirectory, absoluteRoot);
  if (!includedBuildRoot) return undefined;

  const buildName = readGradleBuildName(includedBuildRoot) || path.basename(includedBuildRoot);
  const relativeProject = path.relative(includedBuildRoot, projectDirectory);
  if (relativeProject.startsWith('..') || path.isAbsolute(relativeProject)) return undefined;

  const sourceSet = findSourceSetName(absoluteFile, projectDirectory);
  const taskName = sourceSet && sourceSet !== 'test' ? sourceSet : String(defaultTask || 'test');
  const projectParts = relativeProject === ''
    ? []
    : relativeProject.split(path.sep).filter(Boolean);

  return [buildName, ...projectParts, taskName].join(':');
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

function findSourceSetName(filePath, projectDirectory) {
  const relative = path.relative(projectDirectory, filePath).split(path.sep);
  const srcIndex = relative.indexOf('src');
  return srcIndex >= 0 && relative[srcIndex + 1] ? relative[srcIndex + 1] : undefined;
}

function findIncludedBuildRoot(startDirectory, compositeRoot) {
  let current = path.resolve(startDirectory);
  const root = path.resolve(compositeRoot);

  while (isPathInside(normalizePath(current), normalizePath(root)) && current !== root) {
    if (hasGradleSettings(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
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
  if (extensionContext) await extensionContext.workspaceState.update('testHistory', testHistory);
}

async function clearHistory() {
  testHistory = [];
  latestResults.clear();
  if (extensionContext) await extensionContext.workspaceState.update('testHistory', []);
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
      } else if ((message.command === 'openSource' || message.command === 'openLocation') && selected.sourcePath) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selected.sourcePath));
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        let position;
        if (message.command === 'openLocation' && Number.isInteger(message.line)) {
          position = new vscode.Position(Math.max(0, Math.min(message.line - 1, document.lineCount - 1)), 0);
        } else {
          const scope = selected.invocation?.scope === 'method' ? 'method' : 'class';
          const target = await resolveTestTarget(document, new vscode.Position(0, 0), scope).catch(() => undefined);
          position = target?.range?.start || new vscode.Position(0, 0);
        }
        editor.selection = new vscode.Selection(position, position);
        const range = new vscode.Range(position, position);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        const highlight = vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground')
        });
        editor.setDecorations(highlight, [range]);
        setTimeout(() => highlight.dispose(), 900);
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
    .history{flex:0 0 auto;max-height:34vh;display:flex;flex-direction:column;background:color-mix(in srgb,var(--vscode-sideBar-background) 90%,var(--vscode-editor-background));border-bottom:1px solid var(--vscode-panel-border)}
    .header{padding:8px 10px 6px;display:flex;justify-content:space-between;align-items:center}.header h3,.detail-label{font-size:10px;font-weight:700;margin:0;text-transform:uppercase;letter-spacing:.1em;color:var(--vscode-descriptionForeground)}.header button{border:0;border-radius:3px;padding:2px 6px;cursor:pointer;background:transparent;color:var(--vscode-descriptionForeground);font-size:10px}.header button:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}
    .history-list{overflow:auto;min-height:0}.history-row{width:100%;border:0;border-top:1px solid var(--vscode-panel-border);border-left:2px solid transparent;background:transparent;color:inherit;text-align:left;padding:6px 9px;display:grid;grid-template-columns:17px minmax(0,1fr) auto;gap:7px;align-items:center;cursor:pointer}.history-row:hover{background:var(--vscode-list-hoverBackground)}.history-row.selected{border-left-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.history-status{font-size:14px}.history-copy{min-width:0;display:flex;flex-direction:column}.history-copy strong{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history-copy small{font-size:9px;color:var(--vscode-descriptionForeground);text-transform:capitalize}.history-time{color:var(--vscode-descriptionForeground);font-size:9px;font-variant-numeric:tabular-nums}.history-row.selected .history-time,.history-row.selected .history-copy small{color:inherit;opacity:.78}.empty-history{padding:10px;color:var(--vscode-descriptionForeground);font-size:11px}
    .detail-wrap{min-height:0;flex:1 1 auto;display:flex;flex-direction:column;background:var(--vscode-sideBar-background)}.detail-label{flex:0 0 auto;padding:9px 10px 7px;border-top:5px solid color-mix(in srgb,var(--vscode-focusBorder) 45%,var(--vscode-panel-border));border-bottom:1px solid var(--vscode-panel-border);background:color-mix(in srgb,var(--vscode-sideBar-background) 82%,var(--vscode-editor-background))}.detail{min-height:0;overflow:auto;padding:10px 10px 22px}.hero{display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;align-items:start}.hero .big{font-size:20px;line-height:1}.hero h1{font-size:14px;font-weight:650;line-height:1.25;margin:0;word-break:break-word}.subtitle{margin-top:3px;color:var(--vscode-descriptionForeground);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.subtitle code{font-family:var(--vscode-editor-font-family);font-size:10px}
    .actions{display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin:9px 0 0;padding:4px 0;border-top:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border)}.actions button{border:0;border-radius:3px;padding:3px 6px;cursor:pointer;background:transparent;color:var(--vscode-foreground);font-size:11px}.actions button:hover{background:var(--vscode-toolbar-hoverBackground)}.actions .primary{color:var(--vscode-textLink-foreground);font-weight:600}.actions .separator{width:1px;height:14px;background:var(--vscode-panel-border);margin:0 2px}.actions .raw{margin-left:auto;color:var(--vscode-descriptionForeground)}
    .status.passed{color:var(--vscode-testing-iconPassed)}.status.failed{color:var(--vscode-testing-iconFailed)}.status.skipped{color:var(--vscode-testing-iconSkipped)}.status.running{color:var(--vscode-progressBar-background)}.status.stopped{color:var(--vscode-descriptionForeground)}
    .section{margin-top:14px}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}.section h3{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--vscode-descriptionForeground);margin:0}.console{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.55;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-radius:var(--radius);padding:9px 10px;margin:0;max-height:260px;overflow:auto}.failure-groups{display:flex;flex-direction:column;gap:12px}.failure-group{min-width:0}.failure-test{display:flex;align-items:center;gap:7px;margin:0 0 5px 2px;font-family:var(--vscode-editor-font-family);font-size:11px;font-weight:600}.failure-test-mark{color:var(--vscode-testing-iconFailed);font-size:13px}.failure-card{border:1px solid color-mix(in srgb,var(--vscode-testing-iconFailed) 60%,var(--vscode-panel-border));border-left:3px solid var(--vscode-testing-iconFailed);border-radius:var(--radius);background:color-mix(in srgb,var(--vscode-testing-iconFailed) 5%,var(--vscode-textCodeBlock-background));overflow:hidden}.failure-head{padding:9px 10px;border-bottom:1px solid var(--vscode-panel-border)}.failure-type{font-family:var(--vscode-editor-font-family);font-size:11px;font-weight:700}.failure-message{font-size:11px;margin-top:3px;color:var(--vscode-descriptionForeground)}.comparison{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--vscode-panel-border)}.comparison>div{padding:8px 10px;min-width:0}.comparison>div+div{border-left:1px solid var(--vscode-panel-border)}.comparison label{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin-bottom:3px}.comparison code{font-family:var(--vscode-editor-font-family);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.location{display:block;width:100%;border:0;background:transparent;text-align:left;color:var(--vscode-textLink-foreground);cursor:pointer;padding:7px 10px;font-family:var(--vscode-editor-font-family);font-size:11px}.location:hover{background:var(--vscode-toolbar-hoverBackground)}.frames{margin:0;padding:8px 10px;white-space:pre;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:10px;line-height:1.55}.framework-toggle{width:100%;border:0;border-top:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer;text-align:left;padding:6px 10px;font-size:10px}.framework-toggle:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.framework-frames{display:none;border-top:1px solid var(--vscode-panel-border)}.framework-frames.open{display:block}
    .event-list{display:flex;flex-direction:column;gap:2px}.event{display:grid;grid-template-columns:14px minmax(0,1fr);gap:6px;padding:5px 6px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px}.event:hover{background:var(--vscode-list-hoverBackground)}.event .event-name{overflow-wrap:anywhere}.event.passed .event-mark{color:var(--vscode-testing-iconPassed)}.event.failed .event-mark{color:var(--vscode-testing-iconFailed)}.event.skipped .event-mark{color:var(--vscode-testing-iconSkipped)}
    .empty-output{padding:8px 10px;border:1px dashed var(--vscode-panel-border);border-radius:var(--radius);color:var(--vscode-descriptionForeground);font-size:11px}.empty-state{min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--vscode-descriptionForeground);gap:5px}.empty-state strong{color:var(--vscode-foreground);font-size:13px}.empty-icon{font-size:24px}
  </style></head><body><section class="history"><div class="header"><h3>Recent runs</h3><button data-command="clear">Clear</button></div><div class="history-list">${rows || '<div class="empty-history">No recent runs.</div>'}</div></section><section class="detail-wrap"><div class="detail-label">Selected run</div><main class="detail">${detail}</main></section>
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();let selectedIndex=Math.max(0,[...document.querySelectorAll('.history-row')].findIndex(x=>x.classList.contains('selected')));function selectIndex(next){const rows=[...document.querySelectorAll('.history-row')];if(!rows.length)return;selectedIndex=Math.max(0,Math.min(next,rows.length-1));rows[selectedIndex].click();rows[selectedIndex].scrollIntoView({block:'nearest'});}document.addEventListener('click',event=>{const button=event.target.closest('button[data-command]');if(!button)return;if(button.dataset.command==='toggleFramework'){const target=document.getElementById(button.dataset.target);if(target){target.classList.toggle('open');button.textContent=target.classList.contains('open')?'Hide framework frames':button.dataset.label;}return;}const message={command:button.dataset.command,id:button.dataset.id};if(button.dataset.line)message.line=Number(button.dataset.line);vscode.postMessage(message);});document.addEventListener('keydown',event=>{if(['INPUT','TEXTAREA'].includes(event.target.tagName))return;const key=event.key.toLowerCase();if(key==='j'||event.key==='ArrowDown'){event.preventDefault();selectIndex(selectedIndex+1);}else if(key==='k'||event.key==='ArrowUp'){event.preventDefault();selectIndex(selectedIndex-1);}else if(key==='enter'||key==='o'){event.preventDefault();document.querySelector('[data-command="openSource"]')?.click();}else if(key==='r'){event.preventDefault();document.querySelector('[data-command="rerun"]')?.click();}else if(key==='d'){event.preventDefault();document.querySelector('[data-command="debug"]')?.click();}else if(key==='f'){event.preventDefault();document.querySelector('.failure-card')?.scrollIntoView({behavior:'smooth',block:'start'});}});document.body.tabIndex=0;document.body.focus();</script></body></html>`;
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
    ? `<div class="section"><div class="section-title"><h3>Failures · ${failureItems.length}</h3></div><div class="failure-groups">${failureItems.map((item, index) => renderFailureCard(analyzeFailure(item.failure, result, item), result, index, item.displayName)).join('')}</div></div>`
    : '';
  const consoleSection = result.testOutput
    ? `<div class="section"><div class="section-title"><h3>Test output</h3></div><pre class="console">${escapeHtml(result.testOutput)}</pre></div>`
    : (result.status === 'failed' ? `<div class="section"><div class="section-title"><h3>Test output</h3></div><div class="empty-output">No output was written by this test.</div></div>` : '');
  const eventLines = String(result.summary || '').split('\n').filter(Boolean);
  const showResults = isClass || eventLines.length > 1;
  const resultSection = showResults && eventLines.length
    ? `<div class="section"><div class="section-title"><h3>Results · ${eventLines.length}</h3></div><div class="event-list">${eventLines.map(line => {
        const match = line.match(/\s(PASSED|FAILED|SKIPPED)$/);
        const state = match ? match[1].toLowerCase() : result.status;
        const mark = state === 'passed' ? '✓' : state === 'failed' ? '✕' : '○';
        const name = match ? line.slice(0, -match[0].length) : line;
        return `<div class="event ${escapeHtml(state)}"><span class="event-mark">${mark}</span><span class="event-name">${escapeHtml(name)}</span></div>`;
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
  return { type, message, expected, actual, userFrames, frameworkFrames, primary, file: locationMatch?.[1], line: locationMatch ? Number(locationMatch[2]) : undefined };
}

function renderFailureCard(info, result, index = 0, testName = '') {
  const comparison = info.expected || info.actual ? `<div class="comparison"><div><label>Expected</label><code>${escapeHtml(info.expected || '—')}</code></div><div><label>Actual</label><code>${escapeHtml(info.actual || '—')}</code></div></div>` : '';
  const location = info.line ? `<button class="location" data-command="openLocation" data-id="${escapeHtml(result.id)}" data-line="${info.line}">↗ ${escapeHtml(info.file || 'Open failure')} : ${info.line}</button>` : '';
  const userFrames = info.userFrames.length ? `<pre class="frames">${escapeHtml(info.userFrames.join('\n'))}</pre>` : '';
  const frameworkId = `frameworkFrames-${index}`;
  const framework = info.frameworkFrames.length ? `<button class="framework-toggle" data-command="toggleFramework" data-target="${frameworkId}" data-label="Show ${info.frameworkFrames.length} framework frames">Show ${info.frameworkFrames.length} framework frames</button><pre id="${frameworkId}" class="frames framework-frames">${escapeHtml(info.frameworkFrames.join('\n'))}</pre>` : '';
  const testHeader = testName ? `<div class="failure-test"><span class="failure-test-mark">✕</span><span>${escapeHtml(testName)}</span></div>` : '';
  return `<article class="failure-group">${testHeader}<div class="failure-card"><div class="failure-head"><div class="failure-type">${escapeHtml(info.type)}</div>${info.message ? `<div class="failure-message">${escapeHtml(info.message)}</div>` : ''}</div>${comparison}${location}${userFrames}${framework}</div></article>`;
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
  output.appendLine(`\n[debug] Attaching Java debugger to localhost:${invocation.debugPort}...`);
  const started = await vscode.debug.startDebugging(undefined, {
    type: 'java',
    request: 'attach',
    name: `Composite Gradle: ${invocation.displayName}`,
    hostName: 'localhost',
    port: invocation.debugPort,
    timeout: 120000
  });
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
        methods.push({
          name: stripMethodSignature(symbol.name),
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
    methods.push({
      name: methodName,
      range: new vscode.Range(document.positionAt(match.index), document.positionAt(closeOffset + 1)),
      selectionRange: new vscode.Range(document.positionAt(nameOffset), document.positionAt(nameOffset + methodName.length)),
      parentClass,
      isTest: true
    });
  }

  return { classes, methods };
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
  const invocation = createInvocation(document.uri, target, debug);
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

function deactivate() {
  if (runningProcess) terminateProcessTree(runningProcess);
}

module.exports = { activate, deactivate };

// Internal target command registration is kept outside the public manifest.
const originalActivate = module.exports.activate;
module.exports.activate = async function patchedActivate(context) {
  await originalActivate(context);
  context.subscriptions.push(vscode.commands.registerCommand('compositeGradleTests._runTarget', runProvidedTarget));
};
