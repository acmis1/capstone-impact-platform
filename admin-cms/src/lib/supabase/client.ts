import { createClient } from '@supabase/supabase-js';
import { env } from '../env';

// Browser-safe Supabase client (Client-side use allowed)
// Utilizes only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
// Service Role key MUST NEVER be used here.
export const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-url.supabase.co',
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key'
);
