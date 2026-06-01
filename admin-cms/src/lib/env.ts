import { z } from 'zod';

// Public browser-safe environment variables
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
});

// Private server-only environment variables
const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  SUPABASE_DRAFT_BUCKET: z.string().min(1).default('project-drafts-private'),
  SUPABASE_PUBLIC_ASSETS_BUCKET: z.string().min(1).default('project-public-assets'),
  SUPABASE_PUBLIC_FEEDS_BUCKET: z.string().min(1).default('public-feeds'),
  SUPABASE_PUBLIC_FEED_FILE: z.string().min(1).default('capstones-latest.json'),
});

// Gemini environment variables
const geminiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_ASSISTIVE_EXTRACTION_ENABLED: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema> & PublicEnv;
export type GeminiEnv = z.infer<typeof geminiEnvSchema>;

/**
 * Validates and retrieves browser-safe environment variables.
 * Throws a clear runtime error if keys are missing during client execution.
 */
export function getPublicEnv(): PublicEnv {
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };

  const parsed = publicEnvSchema.safeParse(values);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ');
    throw new Error(
      `Staging Configuration Error: Required public client variables are missing. ${errorDetails}. Please ensure .env.local is configured.`
    );
  }

  return parsed.data;
}

/**
 * Validates and retrieves server-only variables (including client keys).
 * Throws a clear runtime error on missing administrative credentials.
 * Never prints secret values inside error arrays.
 */
export function getServerEnv(): ServerEnv {
  const publicKeys = getPublicEnv();

  const values = {
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_DRAFT_BUCKET: process.env.SUPABASE_DRAFT_BUCKET,
    SUPABASE_PUBLIC_ASSETS_BUCKET: process.env.SUPABASE_PUBLIC_ASSETS_BUCKET,
    SUPABASE_PUBLIC_FEEDS_BUCKET: process.env.SUPABASE_PUBLIC_FEEDS_BUCKET,
    SUPABASE_PUBLIC_FEED_FILE: process.env.SUPABASE_PUBLIC_FEED_FILE,
  };

  const parsed = serverEnvSchema.safeParse(values);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ');
    throw new Error(
      `Staging Configuration Error: Required server variables are missing. ${errorDetails}. Please check your environment.`
    );
  }

  return {
    ...publicKeys,
    ...parsed.data,
  };
}

/**
 * Retrieves Gemini optional variables.
 * Safe fallback is returned, defaulting to extraction disabled if key or flag is inactive.
 */
export function getOptionalGeminiEnv(): GeminiEnv {
  const values = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    GEMINI_ASSISTIVE_EXTRACTION_ENABLED: process.env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED,
  };

  const parsed = geminiEnvSchema.safeParse(values);
  if (!parsed.success) {
    return {
      GEMINI_API_KEY: '',
      GEMINI_MODEL: 'gemini-2.5-flash',
      GEMINI_ASSISTIVE_EXTRACTION_ENABLED: false,
    };
  }

  return parsed.data;
}
