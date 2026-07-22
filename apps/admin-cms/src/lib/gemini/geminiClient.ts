import { GoogleGenAI } from '@google/genai';
import { getOptionalGeminiEnv } from '../env';

// Lazy-initialize client to prevent API keys checks or calls during Next.js build runs
let aiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI | null {
  const geminiEnv = getOptionalGeminiEnv();

  // If disabled in env configurations, do not initialize
  if (!geminiEnv.GEMINI_ASSISTIVE_EXTRACTION_ENABLED) {
    return null;
  }

  if (!geminiEnv.GEMINI_API_KEY) {
    console.warn('Gemini API key is missing. Extraction adapter will execute in disabled mode.');
    return null;
  }

  if (!aiClient) {
    try {
      aiClient = new GoogleGenAI({ apiKey: geminiEnv.GEMINI_API_KEY });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown client error';
      console.error('Failed to initialize Gemini AI client:', message);
      return null;
    }
  }

  return aiClient;
}
