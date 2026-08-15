import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ENTRY_PATH = path.resolve(
  __dirname,
  '../../components/imports/BrowserImportPreviewClient.tsx'
);

const PROHIBITED_EXTERNAL_IMPORTS = new Set([
  'crypto',
  'node:crypto',
  'fs',
  'node:fs',
  'path',
  'node:path',
  'exceljs',
  'server-only',
]);

const PROHIBITED_LOCAL_MODULES = [
  /(?:^|\/)adminReferenceReconciliation$/,
  /(?:^|\/)prepareBrowserImportCommitIntent$/,
  /(?:^|\/)mediaValidation$/,
  /\.server$/,
  /(?:^|\/)repositories\//,
  /(?:^|\/)lib\/supabase\/(?:admin|adminCore|server)$/,
];

function displayName(filePath: string): string {
  return path.basename(filePath).replace(/\.(?:tsx?|jsx?)$/, '');
}

function isRuntimeImport(node: ts.ImportDeclaration): boolean {
  if (!node.importClause) return true;
  if (node.importClause.isTypeOnly) return false;
  if (node.importClause.name) return true;

  const bindings = node.importClause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function isRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true;
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function resolveLocalModule(importer: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function collectRuntimeSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isRuntimeImport(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isRuntimeExport(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function auditClientRuntimeGraph(entryPath: string): {
  visited: Set<string>;
  violations: string[];
} {
  const visited = new Set<string>();
  const violations: string[] = [];

  const walk = (filePath: string, chain: string[]) => {
    const normalizedPath = path.normalize(filePath);
    if (visited.has(normalizedPath)) return;
    visited.add(normalizedPath);

    const sourceText = fs.readFileSync(normalizedPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      normalizedPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      normalizedPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    if (/\bBuffer\s*\./.test(sourceText)) {
      violations.push(`${[...chain, 'Buffer'].join(' -> ')} (runtime Buffer reference)`);
    }

    for (const specifier of collectRuntimeSpecifiers(sourceFile)) {
      if (!specifier.startsWith('.')) {
        if (PROHIBITED_EXTERNAL_IMPORTS.has(specifier)) {
          violations.push(`${[...chain, specifier].join(' -> ')} (prohibited server dependency)`);
        }
        continue;
      }

      const resolvedPath = resolveLocalModule(normalizedPath, specifier);
      if (!resolvedPath) {
        violations.push(`${[...chain, specifier].join(' -> ')} (unresolved local runtime import)`);
        continue;
      }

      const relativeModulePath = path
        .relative(path.resolve(__dirname, '../..'), resolvedPath)
        .replace(/\\/g, '/')
        .replace(/\.(?:tsx?|jsx?)$/, '');
      const nextChain = [...chain, displayName(resolvedPath)];

      if (PROHIBITED_LOCAL_MODULES.some((pattern) => pattern.test(relativeModulePath))) {
        violations.push(`${nextChain.join(' -> ')} (prohibited server implementation)`);
      }

      walk(resolvedPath, nextChain);
    }
  };

  walk(entryPath, [displayName(entryPath)]);
  return { visited, violations };
}

describe('BrowserImportPreviewClient transitive runtime boundary', () => {
  it('contains only browser-safe local runtime modules', () => {
    const result = auditClientRuntimeGraph(ENTRY_PATH);
    console.info(`Browser import client runtime graph traversed ${result.visited.size} local modules.`);

    expect(
      result.violations,
      result.violations.length > 0
        ? `Server-only dependencies are reachable from the client:\n${result.violations.join('\n')}`
        : undefined
    ).toEqual([]);
  });
});
