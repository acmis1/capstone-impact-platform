import { z } from 'zod';

const envSchema = z.object({
  // Supabase Configuration
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Buckets Configuration
  SUPABASE_DRAFT_BUCKET: z.string().min(1).default('project-drafts-private'),
  SUPABASE_PUBLIC_ASSETS_BUCKET: z.string().min(1).default('project-public-assets'),
  SUPABASE_PUBLIC_FEEDS_BUCKET: z.string().min(1).default('public-feeds'),
  SUPABASE_PUBLIC_FEED_FILE: z.string().min(1).default('capstones-latest.json'),

  // Gemini Configuration
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_ASSISTIVE_EXTRACTION_ENABLED: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
});

// Since Next.js env parsing differs between server/client, evaluate safely
const getRawEnv = () => {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_DRAFT_BUCKET: process.env.SUPABASE_DRAFT_BUCKET,
    SUPABASE_PUBLIC_ASSETS_BUCKET: process.env.SUPABASE_PUBLIC_ASSETS_BUCKET,
    SUPABASE_PUBLIC_FEEDS_BUCKET: process.env.SUPABASE_PUBLIC_FEEDS_BUCKET,
    SUPABASE_PUBLIC_FEED_FILE: process.env.SUPABASE_PUBLIC_FEED_FILE,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    GEMINI_ASSISTIVE_EXTRACTION_ENABLED: process.env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED,
  };
};

const parsed = envSchema.safeParse(getRawEnv());

if (!parsed.success) {
  // Defensive error output avoiding secret printing
  const errors = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');
  
  console.warn(`Environment validation warning: ${errors}. Ensure keys are defined before staging operations.`);
}

export const env = parsed.success
  ? parsed.data
  : {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      SUPABASE_DRAFT_BUCKET: process.env.SUPABASE_DRAFT_BUCKET || 'project-drafts-private',
      SUPABASE_PUBLIC_ASSETS_BUCKET: process.env.SUPABASE_PUBLIC_ASSETS_BUCKET || 'project-public-assets',
      SUPABASE_PUBLIC_FEEDS_BUCKET: process.env.SUPABASE_PUBLIC_FEEDS_BUCKET || 'public-feeds',
      SUPABASE_PUBLIC_FEED_FILE: process.env.SUPABASE_PUBLIC_FEED_FILE || 'capstones-latest.json',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      GEMINI_ASSISTIVE_EXTRACTION_ENABLED: false,
    };
