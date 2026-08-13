'use strict';
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./extension.js'), 'utf8');
const required = [
  'recentBuffers.show',
  'onDidChangeActiveTextEditor',
  'onDidChangeTextEditorSelection',
  'workspaceState',
  'showTextDocument',
  'findFiles',
  'searchFiles',
  'buildSearchGlob',
  'fileSearchMinChars',
  'fileSearchResultLimit',
  'createWebviewPanel',
  'Recent Buffers',
  'All Files'
];
for (const token of required) if (!source.includes(token)) throw new Error(`Missing implementation token: ${token}`);
if (source.includes('allFilesCache')) throw new Error('Workspace-wide file cache should not exist');
if (source.includes('getAllFiles()')) throw new Error('Workspace files should not be eagerly enumerated');
const pkg = require('./package.json');
if (pkg.main !== './extension.js') throw new Error('Unexpected extension entrypoint');
if (!pkg.contributes?.keybindings?.some(k => k.command === 'recentBuffers.show' && k.key === 'ctrl+e')) throw new Error('Ctrl+E keybinding missing');
if (pkg.version !== '0.2.8') throw new Error('Expected version 0.2.8');
if (pkg.contributes.configuration.properties['recentBuffers.allFilesLimit']) throw new Error('Legacy allFilesLimit setting should be removed');
console.log('Recent Buffers source/package checks passed.');

for (const token of ['jumpToAllFiles', "key === 'j'", "key === 'k'", "e.key === 'Tab'"]) { if (!source.includes(token)) throw new Error(`Missing keyboard navigation token: ${token}`); }

if (!source.includes("recentBuffers.moveDown")) throw new Error("Missing moveDown command");
if (!source.includes("recentBuffers.moveUp")) throw new Error("Missing moveUp command");
if (!JSON.stringify(pkg.contributes.keybindings).includes("recentBuffers.active")) throw new Error("Missing active-only keybindings");
