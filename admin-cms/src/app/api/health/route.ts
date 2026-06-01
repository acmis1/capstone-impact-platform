import { NextResponse } from 'next/server';
import { getServerEnv } from '../../../lib/env';

export async function GET() {
  let supabaseUrlConfigured = false;
  let publicKeyType: any = 'missing';
  let serverKeyType: any = 'missing';

  try {
    const env = getServerEnv();
    supabaseUrlConfigured = !!env.supabaseUrl;
    publicKeyType = env.publicKeyType;
    serverKeyType = env.serverKeyType;
  } catch (e: any) {
    // If loading server env fails, swallow to ensure health check itself stays online
    console.warn('[Staging Health Diagnostic Warning]:', e.message);
  }

  return NextResponse.json({
    app: 'admin-cms',
    status: 'ok',
    dudaConnected: false,
    prototypeTouched: false,
    stagingOnly: true,
    supabaseUrlConfigured,
    publicKeyType,
    serverKeyType,
    timestamp: new Date().toISOString()
  });
}
