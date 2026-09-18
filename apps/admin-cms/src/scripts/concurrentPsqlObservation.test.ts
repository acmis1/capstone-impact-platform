import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./runDisposableStagingMigrationUpgrade.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('verifier.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function functionText(name: string): string {
  const found = tree.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (found.length !== 1) throw new Error(`Expected one verifier function: ${name}`);
  return source.slice(found[0].getStart(tree), found[0].end);
}
const helper = functionText('interactivePsql');
const observer = functionText('observeConcurrentPsql');
const start = source.indexOf("  const deactivateFirst = interactivePsql('upgrade_deactivate_first');");
const end = source.indexOf('  assert.equal(\n    psql("SELECT status FROM public.projects WHERE public_id=\'upgrade-restore-lifecycle-deactivate-first\';")', start);
if (start < 0 || end <= start) throw new Error('Expected exact deactivation-first scenario.');
const scenario = source.slice(start, end);
const scaffold = `
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const repositoryRoot = 'synthetic', projectId = 'synthetic', PSQL_COMMAND_TIMEOUT_MS = 1000;
const ADMIN_ID = 'synthetic', deactivateFirstAdminId = 'synthetic';
let rejectedChild;
function spawn(_command, args) {
  const child = new EventEmitter(); child.exitCode = null;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  const name = args.find(value => value.startsWith('PGAPPNAME='));
  child.stdin = {
    write(text) {
      const marker = text.match(/\\\\echo ([^\\n]+)/)[1];
      if (name.endsWith('upgrade_restore_after_deactivation')) { rejectedChild = child; return; }
      if (text.startsWith('COMMIT;')) {
        queueMicrotask(() => {
          child.stdout.emit('data', marker + '\\n');
          queueMicrotask(() => {
            rejectedChild.stderr.emit('data', 'ERROR: ' + refusalCode);
            rejectedChild.exitCode = 3; rejectedChild.emit('exit', 3);
          });
        });
      } else queueMicrotask(() => child.stdout.emit('data', 'UPDATED\\n' + marker + '\\n'));
    },
    end() { setTimeout(() => { child.exitCode = 0; child.emit('exit', 0); }, 25); },
  };
  child.kill = () => {}; return child;
}
async function waitForDatabaseLockWait() { await new Promise(resolve => setImmediate(resolve)); }
`;
function reproduce(unsafe = false, refusalCode = 'REVIEW_PERMISSION_DENIED') {
  const observation = unsafe ? 'function observeConcurrentPsql(operation) { return () => operation; }' : observer;
  const code = ts.transpileModule(`const refusalCode=${JSON.stringify(refusalCode)};\n${scaffold}\n${helper}\n${observation}\nasync function run() {\n${scenario}\n}\nrun().then(() => console.log('EXPECTED_REFUSAL_HANDLED')).catch(() => { console.log('OUTER_FAILURE'); process.exitCode=2; }).finally(() => console.log('OWNED_CLEANUP_REACHED'));`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', code], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
}

describe('disposable verifier concurrent psql observation', () => {
  it('handles the exact expected refusal before the other session closes', () => {
    const result = reproduce();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('EXPECTED_REFUSAL_HANDLED');
    expect(result.stdout).toContain('OWNED_CLEANUP_REACHED');
  });
  it('proves the previous delayed-observation ordering exits before cleanup', () => {
    const result = reproduce(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('INTERACTIVE_PSQL_EXIT_3:ERROR: REVIEW_PERMISSION_DENIED');
    expect(result.stdout).not.toContain('OWNED_CLEANUP_REACHED');
  });
  it('keeps unexpected refusal fatal through the outer cleanup path', () => {
    const result = reproduce(false, 'UNEXPECTED_DATABASE_FAILURE');
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('OUTER_FAILURE');
    expect(result.stdout).toContain('OWNED_CLEANUP_REACHED');
    expect(result.stdout).not.toContain('EXPECTED_REFUSAL_HANDLED');
  });
  it('observes all seven intentionally deferred psql operations immediately', () => {
    const names = new Set(['helperAfterArchiveResult', 'archiveAfterReconcileResult', 'helperAfterMediaResult', 'helperResult', 'restoreFirstResult', 'deactivateAfterRestoreResult', 'restoreAfterDeactivationResult']);
    const observed: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)) {
        expect(node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(tree)).toBe('observeConcurrentPsql');
        observed.push(node.name.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    expect(observed.sort()).toEqual([...names].sort());
  });
});
