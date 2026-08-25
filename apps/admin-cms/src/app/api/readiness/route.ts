import { NextResponse } from 'next/server';
import { getDeploymentReadiness } from '../../../deployment/deploymentReadinessEndpoint';
import { getServerEnv } from '../../../lib/env';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
};

async function readiness() {
  return getDeploymentReadiness({
    loadEnv: getServerEnv,
    renderGitCommit: process.env.RENDER_GIT_COMMIT,
  });
}

export async function GET() {
  const result = await readiness();
  return NextResponse.json(result.body, {
    status: result.status,
    headers: NO_STORE_HEADERS,
  });
}

export async function HEAD() {
  const result = await readiness();
  return new Response(null, {
    status: result.status,
    headers: NO_STORE_HEADERS,
  });
}
