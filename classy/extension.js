const vscode = require("vscode");
const path = require("path");

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "javaClassDiagram.generate",
            generateClassDiagram
        )
    );
}

async function generateClassDiagram() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
        vscode.window.showWarningMessage("No workspace folder found.");
        return;
    }

    const includePattern = "**/*.java";
    const excludePattern = "**/{node_modules,.git,build,out,target,.gradle}/**";

    const files = await vscode.workspace.findFiles(includePattern, excludePattern);

    if (files.length === 0) {
        vscode.window.showInformationMessage("No Java files found.");
        return;
    }

    const classes = [];

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        const parsed = parseJavaFile(text, file, workspaceFolder);
        classes.push(...parsed);
    }

    const mermaid = buildMermaid(classes);
    const largestMethodsReport = buildLargestMethodsReport(classes);
    const mostOperatorCallsReport = buildMostOperatorCallsReport(classes);
    const methodDatasheets = buildMethodDatasheets(classes);
    const outputUri = vscode.Uri.joinPath(
        workspaceFolder.uri,
        "class-diagram.md"
    );

    const content = `# Class Diagram

\`\`\`mermaid
${mermaid}
\`\`\`

# Largest Methods

${largestMethodsReport}

# Most Method Calls

${mostOperatorCallsReport}

# Method Datasheets

${methodDatasheets}
`;

    await vscode.workspace.fs.writeFile(
        outputUri,
        Buffer.from(content, "utf8")
    );

    const doc = await vscode.workspace.openTextDocument(outputUri);
    await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside
    });

    vscode.window.showInformationMessage(
        `Generated class diagram with ${classes.length} types.`
    );
}

function parseJavaFile(text, fileUri, workspaceFolder) {
    const cleaned = stripComments(text);
    const packageName = readPackageName(cleaned);
    const relativeFile = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath)
        .replace(/\\/g, "/");

    const results = [];

    const typeRegex =
        /\b(public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+|sealed\s+|non-sealed\s+)*\b(class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)\s*([^{};]*)\{/g;

    let match;

    while ((match = typeRegex.exec(cleaned)) !== null) {
        const kind = match[2];
        const name = match[3];
        const tail = match[4] || "";

        const bodyStart = cleaned.indexOf("{", typeRegex.lastIndex - 1);
        const bodyEnd = findMatchingBrace(cleaned, bodyStart);

        const body = bodyEnd !== -1
            ? cleaned.slice(bodyStart + 1, bodyEnd)
            : "";

        const fullName = packageName ? `${packageName}.${name}` : name;

        const extendsList = parseExtends(tail);
        const implementsList = parseImplements(tail);
        const fieldMap = parseFieldMap(body);

        results.push({
            name,
            fullName,
            kind,
            file: relativeFile,
            extendsList,
            implementsList,
            dependencies: parseDependencies(body),
            fields: parseFields(body),
            methods: parseMethods(body),
            methodDatasheets: parseMethodDatasheets(body, name, {
                fields: fieldMap
            })
        });

        if (bodyEnd !== -1) {
            typeRegex.lastIndex = bodyEnd + 1;
        }
    }

    return results;
}

function readPackageName(text) {
    const match = text.match(/\bpackage\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/);
    return match ? match[1] : "";
}

function parseDependencies(body) {
    const deps = new Set();
    const shallowBody = removeNestedBlocks(body);

    const typeRegex =
        /\b([A-Z][A-Za-z0-9_]*)\b/g;

    let match;

    while ((match = typeRegex.exec(shallowBody)) !== null) {
        const type = match[1];

        if (isIgnoredType(type)) continue;

        deps.add(type);
    }

    return [...deps];
}

function isIgnoredType(type) {
    return [
        "String",
        "Integer",
        "Long",
        "Double",
        "Float",
        "Boolean",
        "Character",
        "Byte",
        "Short",
        "Object",
        "List",
        "Map",
        "Set",
        "HashMap",
        "HashSet",
        "ArrayList",
        "Optional",
        "Collection",
        "Stream",
        "void",
        "Void"
    ].includes(type);
}

function parseExtends(tail) {
    const match = tail.match(/\bextends\s+([A-Za-z_][A-Za-z0-9_.$<>?,\s]*)/);
    if (!match) return [];

    const raw = match[1].split(/\bimplements\b/)[0];

    return splitTypeList(raw);
}

function parseImplements(tail) {
    const match = tail.match(/\bimplements\s+([A-Za-z_][A-Za-z0-9_.$<>?,\s]*)/);
    if (!match) return [];

    return splitTypeList(match[1]);
}

function splitTypeList(value) {
    return value
        .split(",")
        .map(v => cleanTypeName(v))
        .filter(Boolean);
}

function cleanTypeName(value) {
    return String(value || "")
        .replace(/<.*>/g, "")
        .replace(/\[\]/g, "")
        .replace(/\?/g, "")
        .replace(/\bextends\b.*/g, "")
        .replace(/\bsuper\b.*/g, "")
        .trim()
        .split(".")
        .pop();
}

function parseFields(body) {
    const fields = [];
    const shallowBody = removeNestedBlocks(body);

    const fieldRegex =
        /\b(public|protected|private)?\s*(static\s+)?(final\s+)?([A-Za-z_][A-Za-z0-9_.$<>\[\]? ,]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(=|;)/g;

    let match;

    while ((match = fieldRegex.exec(shallowBody)) !== null) {
        const visibility = visibilitySymbol(match[1]);
        const type = cleanDisplayType(match[4]);
        const name = match[5];

        if (looksLikeControlKeyword(type)) continue;

        fields.push(`${visibility}${type} ${name}`);
    }

    return unique(fields).slice(0, 20);
}

function parseFieldMap(body) {
    const fields = {};
    const shallowBody = removeNestedBlocks(body);

    const fieldRegex =
        /\b(public|protected|private)?\s*(static\s+)?(final\s+)?([A-Za-z_][A-Za-z0-9_.$<>\[\]? ,]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(=|;)/g;

    let match;

    while ((match = fieldRegex.exec(shallowBody)) !== null) {
        const type = cleanDisplayType(match[4]);
        const name = match[5];

        if (looksLikeControlKeyword(type)) continue;

        fields[name] = type;
    }

    return fields;
}

function parseMethods(body) {
    const methods = [];
    const shallowBody = removeNestedBlocks(body);

    const methodRegex =
        /\b(public|protected|private)?\s*(static\s+)?(final\s+)?(abstract\s+)?([A-Za-z_][A-Za-z0-9_.$<>\[\]?]+|void)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;

    let match;

    while ((match = methodRegex.exec(shallowBody)) !== null) {
        const visibility = visibilitySymbol(match[1]);
        const returnType = cleanDisplayType(match[5]);
        const name = match[6];

        if (looksLikeControlKeyword(name)) continue;

        methods.push(`${visibility}${name}() ${returnType}`);
    }

    return unique(methods).slice(0, 30);
}

function parseMethodDatasheets(body, className, context) {
    const methods = [];

    const methodRegex =
        /\b(public|protected|private)?\s*(static\s+)?(final\s+)?(abstract\s+)?([A-Za-z_][A-Za-z0-9_.$<>\[\]?]+|void)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g;

    let match;

    while ((match = methodRegex.exec(body)) !== null) {
        const returnType = cleanDisplayType(match[5]);
        const methodName = match[6];
        const paramsText = match[7] || "";

        const bodyStart = body.indexOf("{", methodRegex.lastIndex - 1);
        const bodyEnd = findMatchingBrace(body, bodyStart);

        if (bodyEnd === -1) continue;

        const methodBody = body.slice(bodyStart + 1, bodyEnd);
        const methodLineCount = methodBody.split(/\r?\n/).length;
        const methodNonEmptyLineCount = methodBody
            .split(/\r?\n/)
            .filter(line => line.trim().length > 0)
            .length;

        const calls = parseCalls(methodBody);
        const operatorCalls = calls.filter(call => !isIgnoredOperatorCall(call));

        methods.push({
            className,
            methodName,
            returnType,
            lineCount: methodLineCount,
            nonEmptyLineCount: methodNonEmptyLineCount,
            operatorCallCount: operatorCalls.length,
            operatorCalls,
            parameters: parseParameters(paramsText),
            usesFields: parseUsedFields(methodBody, context.fields),
            createsLocals: parseLocalVariables(methodBody),
            createsObjects: parseCreatedObjects(methodBody),
            calls,
            branches: parseBranches(methodBody),
            passesDataTo: parseConstructorDataPassing(methodBody)
        });
        methodRegex.lastIndex = bodyEnd + 1;
    }

    return methods;
}

function parseParameters(paramsText) {
    if (!paramsText.trim()) return [];

    return paramsText
        .split(",")
        .map(p => p.trim())
        .map(p => {
            const parts = p.split(/\s+/);
            if (parts.length < 2) return null;

            const name = parts[parts.length - 1];
            const type = parts.slice(0, -1).join(" ");

            return `${name} : ${cleanDisplayType(type)}`;
        })
        .filter(Boolean);
}

function parseUsedFields(methodBody, fieldMap) {
    const used = [];

    for (const [name, type] of Object.entries(fieldMap)) {
        const regex = new RegExp(`\\b${escapeRegex(name)}\\b`);

        if (regex.test(methodBody)) {
            used.push(`${name} : ${type}`);
        }
    }

    return unique(used);
}

function parseLocalVariables(methodBody) {
    const locals = [];

    const localRegex =
        /\b([A-Za-z_][A-Za-z0-9_.$<>\[\]? ,]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;

    let match;

    while ((match = localRegex.exec(methodBody)) !== null) {
        const type = cleanDisplayType(match[1]);
        const name = match[2];

        if (looksLikeControlKeyword(type)) continue;
        if (type.includes("return")) continue;

        locals.push(`${name} : ${type}`);
    }

    return unique(locals);
}

function parseCreatedObjects(methodBody) {
    const created = [];
    const newRegex = /\bnew\s+([A-Za-z_][A-Za-z0-9_.$<>]*)\s*\(/g;

    let match;

    while ((match = newRegex.exec(methodBody)) !== null) {
        created.push(cleanTypeName(match[1]));
    }

    return unique(created);
}

function parseCalls(methodBody) {
    const calls = [];

    const callRegex =
        /\b([A-Za-z_][A-Za-z0-9_.$]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;

    let match;

    while ((match = callRegex.exec(methodBody)) !== null) {
        const target = match[1];
        const method = match[2];

        calls.push(`${target}.${method}(...)`);
    }

    return unique(calls);
}

function parseConstructorDataPassing(methodBody) {
    const results = [];

    const constructorRegex =
        /\bnew\s+([A-Za-z_][A-Za-z0-9_.$<>]*)\s*\(([^)]*)\)/g;

    let match;

    while ((match = constructorRegex.exec(methodBody)) !== null) {
        const type = cleanTypeName(match[1]);
        const args = splitArguments(match[2]);

        results.push({
            target: type,
            args
        });
    }

    return results;
}

function splitArguments(argsText) {
    if (!argsText.trim()) return [];

    const args = [];
    let current = "";
    let depth = 0;

    for (const ch of argsText) {
        if (ch === "(" || ch === "<" || ch === "[") depth++;
        if (ch === ")" || ch === ">" || ch === "]") depth--;

        if (ch === "," && depth === 0) {
            args.push(current.trim());
            current = "";
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        args.push(current.trim());
    }

    return args;
}

function buildMethodDatasheets(classes) {
    const sections = [];

    for (const cls of classes) {
        for (const method of cls.methodDatasheets || []) {
            sections.push(renderMethodDatasheet(method));
        }
    }

    if (sections.length === 0) {
        return "No method datasheets generated.";
    }

    return sections.join("\n\n---\n\n");
}

function renderMethodDatasheet(method) {
    return `## ${method.className}.${method.methodName}()

**Size**
- \`${method.nonEmptyLineCount}\` non-empty lines
- \`${method.lineCount}\` total lines

**Method call count**
- \`${method.operatorCallCount}\` calls, excluding print/log noise

**Parameters**
${renderList(method.parameters)}

**Uses fields**
${renderList(method.usesFields)}

**Creates locals**
${renderList(method.createsLocals)}

**Creates project objects**
${renderList(method.createsObjects)}

**Calls**
${renderList(method.calls)}

**Branches**
${renderList(method.branches)}

**Passes data to**
${renderPassesData(method.passesDataTo)}
`;
}

function renderList(items) {
    if (!items || items.length === 0) return "- None";

    return items.map(item => `- \`${item}\``).join("\n");
}

function renderPassesData(items) {
    if (!items || items.length === 0) return "- None";

    return items.map(item => {
        const args = item.args.length === 0
            ? "  - None"
            : item.args.map(arg => `  - \`${arg}\``).join("\n");

        return `- \`${item.target}\`\n${args}`;
    }).join("\n");
}

function removeNestedBlocks(body) {
    let result = "";
    let depth = 0;

    for (let i = 0; i < body.length; i++) {
        const ch = body[i];

        if (ch === "{") {
            depth++;
            result += " ";
            continue;
        }

        if (ch === "}") {
            depth = Math.max(0, depth - 1);
            result += " ";
            continue;
        }

        result += depth === 0 ? ch : " ";
    }

    return result;
}

function findMatchingBrace(text, openIndex) {
    if (openIndex < 0) return -1;

    let depth = 0;

    for (let i = openIndex; i < text.length; i++) {
        if (text[i] === "{") depth++;
        if (text[i] === "}") depth--;

        if (depth === 0) return i;
    }

    return -1;
}

function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
}

function buildMermaid(classes) {
    const lines = ["classDiagram"];
    const knownNames = new Set(classes.map(c => c.name));

    for (const cls of classes) {
        const className = sanitizeMermaidName(cls.name);

        if (cls.kind === "interface") {
            lines.push(`class ${className} {`);
            lines.push(`  <<interface>>`);
        } else if (cls.kind === "enum") {
            lines.push(`class ${className} {`);
            lines.push(`  <<enumeration>>`);
        } else if (cls.kind === "record") {
            lines.push(`class ${className} {`);
            lines.push(`  <<record>>`);
        } else {
            lines.push(`class ${className} {`);
        }

        for (const field of cls.fields) {
            lines.push(`  ${sanitizeMermaidMember(field)}`);
        }

        for (const method of cls.methods) {
            lines.push(`  ${sanitizeMermaidMember(method)}`);
        }

        lines.push(`}`);
    }

    for (const cls of classes) {
        const child = sanitizeMermaidName(cls.name);

        for (const parentRaw of cls.extendsList) {
            const parent = sanitizeMermaidName(parentRaw);
            if (!parent) continue;
            lines.push(`${parent} <|-- ${child}`);
        }

        for (const ifaceRaw of cls.implementsList) {
            const iface = sanitizeMermaidName(ifaceRaw);
            if (!iface) continue;
            lines.push(`${iface} <|.. ${child}`);
        }

        for (const depRaw of cls.dependencies || []) {
            if (!knownNames.has(depRaw)) continue;
            if (depRaw === cls.name) continue;

            const dep = sanitizeMermaidName(depRaw);
            lines.push(`${child} ..> ${dep}`);
        }
    }

    return lines.join("\n");
}

function sanitizeMermaidName(name) {
    return String(name || "")
        .replace(/[^A-Za-z0-9_]/g, "_");
}

function sanitizeMermaidMember(value) {
    return String(value || "")
        .replace(/[{}]/g, "")
        .replace(/"/g, "'")
        .trim();
}

function cleanDisplayType(type) {
    return String(type || "")
        .replace(/[.$]/g, "_")
        .trim();
}

function visibilitySymbol(value) {
    if (value === "public") return "+";
    if (value === "private") return "-";
    if (value === "protected") return "#";
    return "~";
}

function looksLikeControlKeyword(value) {
    return [
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "return",
        "new",
        "try",
        "else",
        "do"
    ].includes(String(value || "").toLowerCase());
}

function unique(values) {
    return [...new Set(values)];
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseBranches(methodBody) {
    const branches = [];

    const branchRegex =
        /\b(if|else if|while|for|switch|catch)\s*\(([^)]*)\)/g;

    let match;

    while ((match = branchRegex.exec(methodBody)) !== null) {
        const kind = match[1];
        const condition = normalizeWhitespace(match[2]);

        branches.push(`${kind} (${condition})`);
    }

    const elseRegex = /\belse\b(?!\s*if)/g;

    while ((match = elseRegex.exec(methodBody)) !== null) {
        branches.push("else");
    }

    return unique(branches);
}
function buildLargestMethodsReport(classes) {
    const methods = [];

    for (const cls of classes) {
        for (const method of cls.methodDatasheets || []) {
            methods.push(method);
        }
    }

    methods.sort((a, b) => b.nonEmptyLineCount - a.nonEmptyLineCount);

    if (methods.length === 0) {
        return "No methods found.";
    }

    return methods.map((method, index) => {
        return `${index + 1}. \`${method.className}.${method.methodName}()\` — ${method.nonEmptyLineCount} non-empty lines`;
    }).join("\n");
}

function normalizeWhitespace(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}
function buildMostOperatorCallsReport(classes) {
    const methods = [];

    for (const cls of classes) {
        for (const method of cls.methodDatasheets || []) {
            methods.push(method);
        }
    }

    methods.sort((a, b) => b.operatorCallCount - a.operatorCallCount);

    const filtered = methods.filter(method => method.operatorCallCount > 0);

    if (filtered.length === 0) {
        return "No method calls found.";
    }

    return filtered.map((method, index) => {
        return `${index + 1}. \`${method.className}.${method.methodName}()\` — ${method.operatorCallCount} method calls`;
    }).join("\n");
}
function isIgnoredOperatorCall(call) {
    return [
        "System.out.print",
        "System.out.println",
        "System.err.print",
        "System.err.println",
        "printStackTrace"
    ].some(ignored => call.includes(ignored));
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};