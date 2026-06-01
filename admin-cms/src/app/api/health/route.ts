import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    app: 'admin-cms',
    status: 'ok',
    dudaConnected: false,
    prototypeTouched: false,
    stagingOnly: true,
    timestamp: new Date().toISOString()
  });
}
