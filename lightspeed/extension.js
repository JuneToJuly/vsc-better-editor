const vscode = require('vscode');

/**
 * LightSpeed 0.0.9
 *
 * Interaction:
 *   invoke -> all visible targets immediately show <initial><selector>
 *   type initial -> type selector -> jump immediately
 *
 * All target codes use one uniform color. There is no InputBox and no
 * confirmation key. For unusually large same-initial buckets, selectors may
 * require more than one character; the full code is still shown up front.
 */

const LABEL_KEYS = 'asdfghjklqwertyuiopzxcvbnm';

const labelDecoration = vscode.window.createTextEditorDecorationType({
  opacity: '0',
  letterSpacing: '-1ch'
});

const flashDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgb(0, 174, 255)',
  borderRadius: '5px'
});

let session = null;

function activate(context) {
  context.subscriptions.push(
    labelDecoration,
    flashDecoration,
    vscode.commands.registerCommand('lightspeed.start', startLightspeed),
    vscode.commands.registerCommand('lightspeed.type', typeLightspeedKey),
    vscode.commands.registerCommand('lightspeed.cancel', cancelLightspeed),
    vscode.commands.registerCommand('lightspeed.backspace', backspaceLightspeed),
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (session) cancelLightspeed();
    })
  );
}

exports.activate = activate;

async function startLightspeed() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  if (session) {
    clearLabels(session.editor);
  }

  const targets = getWordStarts(editor).map(pos => ({
    pos,
    rawInitial: editor.document.getText(
      new vscode.Range(pos, pos.translate(0, 1))
    ),
    initial: editor.document.getText(
      new vscode.Range(pos, pos.translate(0, 1))
    ).toLowerCase(),
    label: ''
  }));

  const buckets = new Map();
  for (const target of targets) {
    if (!buckets.has(target.initial)) buckets.set(target.initial, []);
    buckets.get(target.initial).push(target);
  }

  const bucketInfo = new Map();
  for (const [initial, candidates] of buckets) {
    const labelLength = requiredLabelLength(candidates.length);
    const labelMap = new Map();

    candidates.forEach((target, index) => {
      target.label = indexToLabel(index, labelLength);
      labelMap.set(target.label, target);
    });

    bucketInfo.set(initial, {
      candidates,
      labelLength,
      labelMap
    });
  }

  session = {
    editor,
    targets,
    buckets: bucketInfo,
    mode: 'initial',
    selectedInitial: '',
    typedLabel: ''
  };

  // Render the complete code immediately. No first-key wait.
  renderAllCodes();
  await vscode.commands.executeCommand('setContext', 'lightspeed.active', true);
}

function typeLightspeedKey(arg) {
  if (!session) return;

  const key = typeof arg === 'string' ? arg : arg && arg.key;
  if (!key || key.length !== 1) return;

  if (session.editor !== vscode.window.activeTextEditor) {
    cancelLightspeed();
    return;
  }

  const normalized = key.toLowerCase();

  if (session.mode === 'initial') {
    chooseInitial(normalized);
    return;
  }

  if (session.mode === 'label') {
    chooseLabel(normalized);
  }
}

function chooseInitial(initial) {
  const bucket = session.buckets.get(initial);

  if (!bucket) {
    cancelLightspeed();
    return;
  }

  session.mode = 'label';
  session.selectedInitial = initial;
  session.typedLabel = '';

  // The selector was already visible before this key was typed. Narrowing now
  // only removes visual noise; it does not introduce another display/wait step.
  renderBucket(initial);
}

function chooseLabel(key) {
  if (!LABEL_KEYS.includes(key)) {
    cancelLightspeed();
    return;
  }

  const bucket = session.buckets.get(session.selectedInitial);
  if (!bucket) {
    cancelLightspeed();
    return;
  }

  session.typedLabel += key;

  if (session.typedLabel.length < bucket.labelLength) {
    renderBucket(session.selectedInitial, session.typedLabel);
    return;
  }

  const target = bucket.labelMap.get(session.typedLabel);
  if (!target) {
    cancelLightspeed();
    return;
  }

  finishJump(target.pos);
}

function backspaceLightspeed() {
  if (!session) return;

  if (session.mode === 'initial') {
    cancelLightspeed();
    return;
  }

  if (session.typedLabel.length > 0) {
    session.typedLabel = session.typedLabel.slice(0, -1);
    renderBucket(session.selectedInitial, session.typedLabel);
    return;
  }

  session.mode = 'initial';
  session.selectedInitial = '';
  renderAllCodes();
}

function requiredLabelLength(count) {
  let length = 1;
  let capacity = LABEL_KEYS.length;

  while (capacity < count) {
    length += 1;
    capacity *= LABEL_KEYS.length;
  }

  return length;
}

function indexToLabel(index, length) {
  const radix = LABEL_KEYS.length;
  const chars = new Array(length);
  let value = index;

  for (let i = length - 1; i >= 0; i--) {
    chars[i] = LABEL_KEYS[value % radix];
    value = Math.floor(value / radix);
  }

  return chars.join('');
}

function renderAllCodes() {
  if (!session) return;
  renderTargets(session.targets);
}

function renderBucket(initial, labelPrefix = '') {
  if (!session) return;

  const bucket = session.buckets.get(initial);
  if (!bucket) return;

  const targets = labelPrefix
    ? bucket.candidates.filter(target => target.label.startsWith(labelPrefix))
    : bucket.candidates;

  renderTargets(targets);
}

function renderTargets(targets) {
  if (!session) return;

  const editor = session.editor;
  const decorations = [];

  for (const target of targets) {
    const code = target.rawInitial + target.label;
    const line = editor.document.lineAt(target.pos.line).text;
    const replaceLength = Math.max(
      1,
      Math.min(code.length, line.length - target.pos.character)
    );

    const range = new vscode.Range(
      target.pos,
      target.pos.translate(0, replaceLength)
    );

    decorations.push({
      range,
      renderOptions: {
        before: {
          contentText: code,
          color: vscode.workspace.getConfiguration('lightspeed').get('labelColor', '#ffd54a'),
          fontWeight: 'bold',
          margin: '0',
          textDecoration: 'none; position: relative; left: 0ch;'
        }
      }
    });
  }

  editor.setDecorations(labelDecoration, decorations);
}

function getWordStarts(editor) {
  const results = [];
  const seen = new Set();

  for (const vr of editor.visibleRanges) {
    for (let line = vr.start.line; line <= vr.end.line; line++) {
      const text = editor.document.lineAt(line).text;

      for (let i = 0; i < text.length; i++) {
        if (/[a-zA-Z0-9]/.test(text[i]) && (i === 0 || /\W/.test(text[i - 1]))) {
          const key = `${line}:${i}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push(new vscode.Position(line, i));
          }
        }
      }
    }
  }

  return results;
}

function finishJump(pos) {
  if (!session) return;

  const editor = session.editor;
  clearLabels(editor);

  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));

  endSession();
  flashPosition(editor, pos);
}

function flashPosition(editor, pos) {
  const range = editor.document.getWordRangeAtPosition(pos) ||
    new vscode.Range(pos, pos.translate(0, 1));

  editor.setDecorations(flashDecoration, [{ range }]);

  setTimeout(() => {
    editor.setDecorations(flashDecoration, []);
  }, 350);
}

function clearLabels(editor) {
  if (editor) {
    editor.setDecorations(labelDecoration, []);
  }
}

function cancelLightspeed() {
  if (!session) return;

  clearLabels(session.editor);
  endSession();
}

function endSession() {
  session = null;
  void vscode.commands.executeCommand('setContext', 'lightspeed.active', false);
}

function deactivate() {
  if (session) clearLabels(session.editor);
  void vscode.commands.executeCommand('setContext', 'lightspeed.active', false);
}

exports.deactivate = deactivate;
