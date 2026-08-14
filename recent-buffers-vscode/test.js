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
if (pkg.version !== '0.3.0') throw new Error('Expected version 0.3.0');
if (pkg.contributes.configuration.properties['recentBuffers.allFilesLimit']) throw new Error('Legacy allFilesLimit setting should be removed');
console.log('Recent Buffers source/package checks passed.');

for (const token of ['jumpToAllFiles', "key === 'j'", "key === 'k'", "e.key === 'Tab'"]) { if (!source.includes(token)) throw new Error(`Missing keyboard navigation token: ${token}`); }

if (!source.includes("recentBuffers.moveDown")) throw new Error("Missing moveDown command");
if (!source.includes("recentBuffers.moveUp")) throw new Error("Missing moveUp command");
if (!JSON.stringify(pkg.contributes.keybindings).includes("recentBuffers.active")) throw new Error("Missing active-only keybindings");

if (source.includes("search.value = m.query")) throw new Error("Search input must not be overwritten by async state");
if (!source.includes("requestId")) throw new Error("Missing search request IDs");
if (!source.includes("requestId !== searchRequestId")) throw new Error("Missing stale search request guard");
console.log("Fast-typing regression checks passed.");

if (!source.includes("var(--vscode-editor-font-family")) throw new Error("Missing editor font for position");
if (!source.includes(".row.active::before")) throw new Error("Missing selected-row accent");
if (!source.includes("direction:rtl")) throw new Error("Missing trailing-path truncation");
console.log("Typography regression checks passed.");
