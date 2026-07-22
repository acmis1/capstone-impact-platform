import { NextResponse } from 'next/server';
import { getServerEnv } from '../../../lib/env';

export async function GET() {
  let supabaseUrlConfigured = false;
  let publicKeyType: string = 'missing';
  let databaseAdminKeyType: string = 'missing';
  let databaseAdminKeyMode: string = 'missing';

  try {
    const env = getServerEnv();
    supabaseUrlConfigured = !!env.supabaseUrl;
    publicKeyType = env.publicKeyType;
    databaseAdminKeyType = env.databaseAdminKeyType;
    databaseAdminKeyMode = env.databaseAdminKeyMode;
  } catch (e: unknown) {
    // If loading server env fails, swallow to ensure health check itself stays online
    const message = e instanceof Error ? e.message : 'Unknown environment error';
    console.warn('[Staging Health Diagnostic Warning]:', message);
  }

  return NextResponse.json({
    app: 'admin-cms',
    status: 'ok',
    dudaConnected: false,
    prototypeTouched: false,
    stagingOnly: true,
    supabaseUrlConfigured,
    publicKeyType,
    databaseAdminKeyType,
    databaseAdminKeyMode,
    timestamp: new Date().toISOString()
  });
}
