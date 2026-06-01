import { z } from 'zod';

// Public browser-safe environment variables validation schema
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
}).refine(
  (data) => data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || data.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  {
    message: 'Either NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY must be provided',
    path: ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
  }
);

// Private server-only environment variables validation schema
const serverEnvSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_DRAFT_BUCKET: z.string().min(1).default('project-drafts-private'),
  SUPABASE_PUBLIC_ASSETS_BUCKET: z.string().min(1).default('project-public-assets'),
  SUPABASE_PUBLIC_FEEDS_BUCKET: z.string().min(1).default('public-feeds'),
  SUPABASE_PUBLIC_FEED_FILE: z.string().min(1).default('capstones-latest.json'),
}).refine(
  (data) => data.SUPABASE_SECRET_KEY || data.SUPABASE_SERVICE_ROLE_KEY,
  {
    message: 'Either SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY must be provided',
    path: ['SUPABASE_SECRET_KEY'],
  }
);

// Gemini environment variables validation schema
const geminiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_ASSISTIVE_EXTRACTION_ENABLED: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
});

export interface PublicEnv {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  supabaseUrl: string;
  supabasePublicKey: string;
}

export interface ServerEnv extends PublicEnv {
  SUPABASE_SECRET_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  supabaseSecretKey: string;
  SUPABASE_DRAFT_BUCKET: string;
  SUPABASE_PUBLIC_ASSETS_BUCKET: string;
  SUPABASE_PUBLIC_FEEDS_BUCKET: string;
  SUPABASE_PUBLIC_FEED_FILE: string;
}

export type GeminiEnv = z.infer<typeof geminiEnvSchema>;

/**
 * Validates and retrieves browser-safe environment variables.
 * Prioritizes the latest publishable key name and falls back to the legacy anon key.
 */
export function getPublicEnv(): PublicEnv {
  const values = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
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

  const data = parsed.data;
  const publicKey = data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || data.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  return {
    NEXT_PUBLIC_SUPABASE_URL: data.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
    supabaseUrl: data.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublicKey: publicKey,
  };
}

/**
 * Validates and retrieves server-only variables (including client keys).
 * Prioritizes the latest secret key name and falls back to the legacy service role key.
 * Never prints secret values inside error arrays.
 */
export function getServerEnv(): ServerEnv {
  const publicKeys = getPublicEnv();

  const values = {
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
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

  const data = parsed.data;
  const secretKey = data.SUPABASE_SECRET_KEY || data.SUPABASE_SERVICE_ROLE_KEY || '';

  return {
    ...publicKeys,
    SUPABASE_SECRET_KEY: secretKey,
    SUPABASE_SERVICE_ROLE_KEY: secretKey,
    supabaseSecretKey: secretKey,
    SUPABASE_DRAFT_BUCKET: data.SUPABASE_DRAFT_BUCKET,
    SUPABASE_PUBLIC_ASSETS_BUCKET: data.SUPABASE_PUBLIC_ASSETS_BUCKET,
    SUPABASE_PUBLIC_FEEDS_BUCKET: data.SUPABASE_PUBLIC_FEEDS_BUCKET,
    SUPABASE_PUBLIC_FEED_FILE: data.SUPABASE_PUBLIC_FEED_FILE,
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
