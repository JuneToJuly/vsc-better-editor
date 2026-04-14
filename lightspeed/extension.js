const vscode = require('vscode');

/**
 * CONFIG
 */
const COLORS = [
  { key: 'a', hex: '#757d84' },
  { key: 'y', hex: '#ffd700' },
  { key: 'w', hex: '#ffffff' },
  { key: 'r', hex: '#ff4646' },
  { key: 'b', hex: '#64aaff' },
  { key: 'g', hex: '#50dc82' },
  { key: 'o', hex: '#ff8c00' },
  { key: 'p', hex: '#a064ff' },
];
const flashDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgb(0, 174, 255)', 
  borderRadius: '5px'
});

function flashPosition(editor, pos) {
  const range = editor.document.getWordRangeAtPosition(pos);

  editor.setDecorations(flashDecoration, [{ range }]);

  setTimeout(() => {
    editor.setDecorations(flashDecoration, []);
  }, 500); // 🔥 duration (tweak this)
}

const decorationMap = new Map();
const targetMap = new Map();

/**
 * ACTIVATE
 */
function activate(context) {

  createDecorations();

  const editor = vscode.window.activeTextEditor;
  if (editor) applyDecorations(editor);

  context.subscriptions.push(
    vscode.commands.registerCommand('lightspeed.start', async () => {

      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      applyDecorations(editor);

      const inputBox = vscode.window.createInputBox();

      inputBox.prompt = "Lightspeed: <letter><encoding>";
      inputBox.placeholder = "ea / eeg / eaa / eeaa";
      inputBox.ignoreFocusOut = true;

      let currentValue = '';

      inputBox.onDidChangeValue(value => {
        currentValue = value;

        // 🔥 SPACE = CONFIRM
        if (value.endsWith(' ') || value.endsWith(';')) {
          inputBox.hide();
          executeJump(value.trim());
        }
      });

      inputBox.onDidAccept(() => {
        inputBox.hide();
        executeJump(currentValue.trim());
      });

      inputBox.onDidHide(() => {
        clearDecorations(editor);
        inputBox.dispose();
      });

      inputBox.show();

      if (!input) {
        clearDecorations(editor);
        return;
      }

      executeJump(input);
    })
  );
}

exports.activate = activate;

/**
 * CREATE DECORATIONS
 */
function createDecorations() {
  for (let c of COLORS) {
    for (let letterHold of [false, true]) {
      for (let colorHold of [false, true]) {

        const key = `${c.key}-${letterHold}-${colorHold}`;

        decorationMap.set(key, vscode.window.createTextEditorDecorationType({
          opacity: '0',
          letterSpacing: '-1ch'
        }));
      }
    }
  }
}

/**
 * FIND WORD STARTS
 */
function getWordStarts(editor) {
  const results = [];

  for (const vr of editor.visibleRanges) {
    for (let line = vr.start.line; line <= vr.end.line; line++) {
      const text = editor.document.lineAt(line).text;

      let i = 0;
      while (i < text.length) {
        if (/[a-zA-Z0-9]/.test(text[i]) && (i === 0 || /\W/.test(text[i - 1]))) {
          results.push(new vscode.Position(line, i));
        }
        i++;
      }
    }
  }

  return results;
}

/**
 * APPLY DECORATIONS
 */
function applyDecorations(editor) {
  const starts = getWordStarts(editor);

  const buckets = new Map();
  targetMap.clear();

  const letterBuckets = new Map();

  for (const pos of starts) {
    const rawLetter = editor.document.getText(
      new vscode.Range(pos, pos.translate(0, 1))
    );

    const letter = rawLetter.toLowerCase();

    if (!letterBuckets.has(letter)) {
      letterBuckets.set(letter, []);
    }

    letterBuckets.get(letter).push({ pos, rawLetter });
  }

  for (const [letter, entries] of letterBuckets) {

    entries.forEach(({ pos, rawLetter }, index) => {

      const colorIndex = index % 8;
      const color = COLORS[colorIndex];

      const letterHold = ((index >> 3) & 1) === 1;
      const colorHold = ((index >> 4) & 1) === 1;

      const key = `${letter}-${color.key}-${letterHold}-${colorHold}`;
      const decoKey = `${color.key}-${letterHold}-${colorHold}`;

      const encoded =
        (letterHold ? rawLetter + rawLetter : rawLetter) +
        color.key +
        (colorHold ? color.key : '');

      const line = editor.document.lineAt(pos.line).text;
      const maxLength = Math.min(encoded.length, line.length - pos.character);

      const range = new vscode.Range(pos, pos.translate(0, maxLength));

      if (!buckets.has(decoKey)) buckets.set(decoKey, []);

      buckets.get(decoKey).push({
        range,
        renderOptions: {
          before: {
            contentText: encoded,
            color: color.hex,
            margin: '0',
            textDecoration: 'none; position: relative; left: 0ch;'
          }
        }
      });

      if (!targetMap.has(key)) {
        targetMap.set(key, []);
      }

      targetMap.get(key).push(pos);
    });
  }

  for (const [key, ranges] of buckets) {
    const deco = decorationMap.get(key);
    if (deco) {
      editor.setDecorations(deco, ranges);
    }
  }
}

/**
 * PARSE INPUT
 */
function executeJump(input) {

  const cleaned = input.replace(/\s+/g, '').toLowerCase();

  if (cleaned.length < 2) return;

  let i = 0;

  let letter = cleaned[i];
  let letterHold = false;

  if (cleaned[i + 1] === letter && cleaned.length > 2) {
    letterHold = true;
    i += 2;
  } else {
    i += 1;
  }

  let colorKey = cleaned[i];
  if (!colorKey) return;

  let colorHold = false;

  if (cleaned[i + 1] === colorKey) {
    colorHold = true;
  }

  jump(letter, letterHold, colorKey, colorHold);
}

/**
 * JUMP
 */
function jump(letter, letterHold, colorKey, colorHold) {

  const key = `${letter}-${colorKey}-${letterHold}-${colorHold}`;

  const positions = targetMap.get(key);

  if (!positions || positions.length === 0) {
    console.log("No positions found");
    return;
  }

  const pos = positions[0];

  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));


  clearDecorations(editor);

  // 🔥 FLASH
  flashPosition(editor, pos);
}

/**
 * CLEAR DECORATIONS
 */
function clearDecorations(editor) {
  for (const deco of decorationMap.values()) {
    editor.setDecorations(deco, []);
  }
}

function deactivate() { }
exports.deactivate = deactivate;