import type { NextConfig } from "next";
import { assertPublicSupabaseCredentialsAreSafe } from './src/lib/supabaseCredential';

assertPublicSupabaseCredentialsAreSafe({
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

const nextConfig: NextConfig = {
  // Preview capabilities must never enter development request logs.
  logging: { incomingRequests: { ignore: [/^\/participant-preview\//] } },
};

export default nextConfig;
