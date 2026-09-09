import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prototypeDirectory = path.resolve(__dirname, '..');
const adminKey = 'local-upload-limit-test-key';
const fileSizeLimit = 100 * 1024 * 1024;

const getAvailablePort = async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
};

const waitForServer = (child) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out waiting for local Prototype server.')), 10000);
  const onData = (chunk) => {
    if (chunk.toString().includes('Admin API server running on port')) {
      clearTimeout(timeout);
      resolve();
    }
  };
  child.stdout.on('data', onData);
  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once('exit', (code, signal) => {
    if (code !== null || signal !== null) {
      clearTimeout(timeout);
      reject(new Error(`Local Prototype server exited before readiness (${code ?? signal}).`));
    }
  });
});

const postMultipart = async (port, form, includeAuth = true) => {
  const headers = includeAuth ? { 'x-admin-key': adminKey } : undefined;
  const response = await fetch(`http://127.0.0.1:${port}/api/import-folder`, {
    method: 'POST',
    headers,
    body: form
  });
  return { status: response.status, body: await response.json() };
};

const expectUploadRejection = async (port, form, expectedError) => {
  const result = await postMultipart(port, form);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, `Upload rejected: ${expectedError}`);
};

const port = await getAvailablePort();
const child = spawn(process.execPath, ['server.js'], {
  cwd: prototypeDirectory,
  env: {
    ...process.env,
    PORT: String(port),
    ADMIN_ACCESS_KEY: adminKey,
    SUPABASE_URL: '',
    SUPABASE_SECRET_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_EXPECTED_PROJECT_REF: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForServer(child);

  const unauthorized = await postMultipart(port, new FormData(), false);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error, 'Unauthorized: Admin Access Key required.');

  const tooManyFields = new FormData();
  for (let index = 0; index < 21; index += 1) {
    tooManyFields.append(`field-${index}`, 'value');
  }
  await expectUploadRejection(port, tooManyFields, 'LIMIT_FIELD_COUNT');

  const tooManyFiles = new FormData();
  for (let index = 0; index < 251; index += 1) {
    tooManyFiles.append('files', new Blob(['x']), `file-${index}.txt`);
  }
  await expectUploadRejection(port, tooManyFiles, 'LIMIT_FILE_COUNT');

  const tooLarge = new FormData();
  tooLarge.append('files', new Blob([Buffer.alloc(fileSizeLimit + 1)]), 'oversized.bin');
  await expectUploadRejection(port, tooLarge, 'LIMIT_FILE_SIZE');

  console.log('Import upload auth and Multer limit regression: unauthorized, field-count, file-count, and file-size rejection cases passed.');
} finally {
  child.kill();
  await once(child, 'exit').catch(() => {});
}
