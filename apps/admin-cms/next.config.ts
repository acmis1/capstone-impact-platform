import type { NextConfig } from "next";
import { assertPublicSupabaseCredentialsAreSafe } from './src/lib/supabaseCredential';

assertPublicSupabaseCredentialsAreSafe({
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
