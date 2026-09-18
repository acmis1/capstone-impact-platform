import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'assistive-worker-image.yml');
const dockerfilePath = path.join(repoRoot, 'apps', 'assistive-worker', 'Dockerfile.hosted');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
const workerBuildArg = 'CAPSTONE_DEPLOYMENT_VERSION=${{ github.sha }}';
const workerStepNames = {
  buildOnly: 'Build heavy assistive worker image',
  publish: 'Build and publish heavy assistive worker image',
};

function linesOf(source) {
  return source.replace(/\r\n/g, '\n').split('\n');
}

function countExact(lines, expected) {
  return lines.filter((line) => line === expected).length;
}

function stepBlock(source, name) {
  const lines = linesOf(source);
  const marker = `      - name: ${name}`;
  const starts = lines.reduce((matches, line, index) => {
    if (line === marker) matches.push(index);
    return matches;
  }, []);
  assert.equal(starts.length, 1, `expected exactly one workflow step named ${name}`);

  const start = starts[0];
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith('      - name: '),
  );
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

function jobBlock(source, name) {
  const lines = linesOf(source);
  const marker = `  ${name}:`;
  const starts = lines.reduce((matches, line, index) => {
    if (line === marker) matches.push(index);
    return matches;
  }, []);
  assert.equal(starts.length, 1, `expected exactly one job named ${name}`);

  const start = starts[0];
  const end = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z0-9_-]+:$/.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

function requireLine(block, expected, description = expected) {
  assert.equal(
    countExact(linesOf(block), expected),
    1,
    `expected exactly one ${description}`,
  );
}

function requireSequence(block, expectedLines, description) {
  assert.equal(
    linesOf(block).join('\n').includes(expectedLines.join('\n')),
    true,
    `expected ${description}`,
  );
}

function requireBuildArg(block) {
  const lines = linesOf(block);
  const buildArgs = '          build-args: |';
  const starts = lines.reduce((matches, line, index) => {
    if (line === buildArgs) matches.push(index);
    return matches;
  }, []);
  assert.equal(starts.length, 1, 'worker step must contain exactly one build-args block');

  const values = [];
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    if (!lines[index].startsWith('            ')) break;
    values.push(lines[index].slice('            '.length));
  }
  assert.deepEqual(values, [workerBuildArg], 'worker build arg must bind exactly to github.sha');
}

function validateWorkerStep(block, { publish, outputs }) {
  requireLine(
    block,
    '        uses: docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6.18.0',
    'pinned worker build action',
  );
  requireLine(block, '        id: worker');
  requireLine(block, '          context: .');
  requireLine(block, '          file: ./apps/assistive-worker/Dockerfile.hosted');
  requireLine(block, '          platforms: linux/amd64');
  requireLine(block, '          provenance: false');
  requireLine(block, `          push: ${publish ? 'true' : 'false'}`);
  requireLine(
    block,
    '          tags: ghcr.io/${{ github.repository }}/capstone-assistive-worker:${{ github.sha }}',
  );
  if (outputs) requireLine(block, `          outputs: ${outputs}`);
  requireBuildArg(block);
}

function validateDockerfileLinkage(source) {
  const lines = linesOf(source);
  const argName = workerBuildArg.slice(0, workerBuildArg.indexOf('='));
  requireLine(lines.join('\n'), `ARG ${argName}=""`, 'Dockerfile deployment version ARG');
  requireLine(
    lines.join('\n'),
    `LABEL org.opencontainers.image.revision="\${${argName}}"`,
    'Dockerfile OCI revision label',
  );
}

function validateWorkflow(source) {
  const buildOnlyWorker = stepBlock(source, workerStepNames.buildOnly);
  const publishWorker = stepBlock(source, workerStepNames.publish);
  validateWorkerStep(buildOnlyWorker, {
    publish: false,
    outputs: 'type=oci,dest=/tmp/capstone-assistive-worker.oci.tar',
  });
  validateWorkerStep(publishWorker, { publish: true });
  validateDockerfileLinkage(dockerfile);
  validateSafety(source);
}

function validateSafety(source) {
  const lines = linesOf(source);
  assert.equal(countExact(lines, 'on:'), 1, 'workflow must have one trigger declaration');
  assert.equal(countExact(lines, '  workflow_dispatch:'), 1, 'workflow must remain manual-only');
  assert.equal(
    lines.filter((line) => /^  (push|pull_request|schedule|workflow_call):/.test(line)).length,
    0,
    'workflow must not gain an automatic trigger',
  );
  requireSequence(
    source,
    [
      '      publish:',
      '        description: Publish to the container registry (requires reviewed licence clearance)',
      '        type: boolean',
      '        default: false',
    ],
    'publish input default false',
  );

  const buildOnly = jobBlock(source, 'build-only');
  const publish = jobBlock(source, 'publish');
  requireLine(buildOnly, '    if: ${{ !inputs.publish }}');
  requireLine(buildOnly, '    permissions:');
  requireLine(buildOnly, '      contents: read');
  assert.equal(
    buildOnly.includes('docker/login-action@'),
    false,
    'build-only job must not authenticate to a registry',
  );
  assert.equal(
    buildOnly.includes('      packages: write'),
    false,
    'build-only job must not request package write permission',
  );
  assert.equal(countExact(linesOf(buildOnly), '          push: false'), 2);
  requireLine(buildOnly, '          outputs: type=oci,dest=/tmp/capstone-assistive-worker.oci.tar');
  requireLine(buildOnly, '          outputs: type=oci,dest=/tmp/capstone-assistive-dispatcher.oci.tar');
  requireLine(buildOnly, '          echo "Published: false"');

  requireLine(publish, '    if: ${{ inputs.publish }}');
  requireLine(publish, '      packages: write');
  requireLine(
    publish,
    '        uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567 # v3.3.0',
    'existing publish registry login',
  );
  assert.equal(countExact(linesOf(publish), '          push: true'), 2);
  requireLine(publish, '          username: ${{ github.actor }}');
  requireLine(publish, '          password: ${{ secrets.GITHUB_TOKEN }}');
}

function removeWorkerBuildArg(source, stepName) {
  const block = stepBlock(source, stepName);
  const oldBlock = [
    '          build-args: |',
    `            ${workerBuildArg}`,
    '',
  ].join('\n');
  assert.equal(block.includes(oldBlock), true, `expected revision arg in ${stepName}`);
  return source.replace(/\r\n/g, '\n').replace(block, block.replace(oldBlock, ''));
}

export { removeWorkerBuildArg, validateWorkflow };

test('each actual worker build step binds the Docker revision to github.sha', () => {
  validateWorkerStep(stepBlock(workflow, workerStepNames.buildOnly), {
    publish: false,
    outputs: 'type=oci,dest=/tmp/capstone-assistive-worker.oci.tar',
  });
  validateWorkerStep(stepBlock(workflow, workerStepNames.publish), { publish: true });
});

test('the worker build arg is linked to the Dockerfile OCI revision label', () => {
  validateDockerfileLinkage(dockerfile);
});

test('manual build-only safety and existing publish gate remain unchanged', () => {
  validateSafety(workflow);
});

test('removing the build-only worker arg fails independently', () => {
  const oldWorkflow = removeWorkerBuildArg(workflow, workerStepNames.buildOnly);
  assert.doesNotThrow(() => validateWorkerStep(stepBlock(oldWorkflow, workerStepNames.publish), {
    publish: true,
  }));
  assert.throws(
    () => validateWorkflow(oldWorkflow),
    /worker step must contain exactly one build-args block/,
  );
});

test('removing the gated-publish worker arg fails independently', () => {
  const oldWorkflow = removeWorkerBuildArg(workflow, workerStepNames.publish);
  assert.doesNotThrow(() => validateWorkerStep(stepBlock(oldWorkflow, workerStepNames.buildOnly), {
    publish: false,
    outputs: 'type=oci,dest=/tmp/capstone-assistive-worker.oci.tar',
  }));
  assert.throws(
    () => validateWorkflow(oldWorkflow),
    /worker step must contain exactly one build-args block/,
  );
});
