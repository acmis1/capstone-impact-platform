import { spawn } from 'node:child_process';
import {
  finishRejectedMutation,
  trackInteractivePsqlSession,
  trackedPsqlSessionCount,
} from './interactivePsqlSession';

const childSource = String.raw`
  const readline = require('node:readline');
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    if (line.startsWith('\\echo HARNESS_PROCESS_MISMATCH_MUTATION_RESULT')) {
      process.stdout.write('HARNESS_PROCESS_MISMATCH_MUTATION_RESULT 00000 false\n');
    }
    if (line.includes("SELECT 'HARNESS_PROCESS_MISMATCH'")) {
      process.stdout.write('HARNESS_PROCESS_MISMATCH\n');
    }
    if (line === '\\q') process.exit(0);
  });
  setInterval(() => {}, 1000);
`;

const session = trackInteractivePsqlSession(spawn(
  process.execPath,
  ['-e', childSource],
  { stdio: ['pipe', 'pipe', 'pipe'] },
));

finishRejectedMutation(
  session,
  'SELECT 1;',
  'HARNESS_PROCESS_MISMATCH',
  /could not serialize access/i,
  /40001/,
  {
    markerTimeoutMs: 500,
    closeTimeouts: { gracefulMs: 500, terminateMs: 500, killMs: 500 },
  },
).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`TRACKED_PSQL_SESSIONS=${trackedPsqlSessionCount()}`);
  process.exitCode = 1;
});
