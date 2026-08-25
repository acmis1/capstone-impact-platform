import { NextResponse } from 'next/server';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
};

export async function GET() {
  return NextResponse.json({
    app: 'admin-cms',
    status: 'ok',
  }, { headers: NO_STORE_HEADERS });
}

export async function HEAD() {
  return new Response(null, { status: 200, headers: NO_STORE_HEADERS });
}
