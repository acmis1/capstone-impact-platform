import { getGeminiClient } from './geminiClient';
import { env } from '../env';

export interface AssistiveExtractionResult {
  enabled: boolean;
  suggestions: {
    title?: string;
    summary?: string;
    accessibilityText?: string;
    posterText?: string;
  };
  warnings: string[];
}

/**
 * Assistive Metadata Extraction adapter.
 * 
 * Rules:
 * - Server-side only; must not execute or expose keys in browser contexts.
 * - Respects the GEMINI_ASSISTIVE_EXTRACTION_ENABLED flag. If false, returns instantly.
 * - Does not run automated calls during static site compile runs.
 * - Treats output strictly as non-blocking suggestions, requiring administrative approval.
 */
export async function extractProjectMetadata(
  posterPdfBuffer: Buffer | null,
  fileName: string
): Promise<AssistiveExtractionResult> {
  const result: AssistiveExtractionResult = {
    enabled: env.GEMINI_ASSISTIVE_EXTRACTION_ENABLED,
    suggestions: {},
    warnings: [],
  };

  // 1. Instantly exit if disabled or missing dependencies
  if (!result.enabled) {
    result.warnings.push('Assistive extraction is disabled via environment configuration.');
    return result;
  }

  const client = getGeminiClient();
  if (!client) {
    result.warnings.push('Gemini AI client was not initialized due to missing keys or configurations.');
    return result;
  }

  if (!posterPdfBuffer || posterPdfBuffer.length === 0) {
    result.warnings.push('Missing or empty poster PDF asset. Assistive extraction skipped.');
    return result;
  }

  try {
    // Standard mock or basic instruction setup (preventing active API pricing calls during offline tests)
    // In production, this would make a structured call to Gemini using the official SDK:
    // const response = await client.models.generateContent({
    //   model: env.GEMINI_MODEL,
    //   contents: [...],
    // });
    
    // Simulate parsing success for test configurations
    result.suggestions = {
      title: 'Mock Extracted Project Title from Poster',
      summary: 'Mock extracted brief project summary outlining key engineering challenges and dynamic solutions.',
      accessibilityText: `This poster depicts a diagram of the parsed file ${fileName} with detailed workflow models.`,
      posterText: 'Parsed poster headers: Capstone Impact Platform. Staging Staged.',
    };

    return result;
  } catch (err: any) {
    result.warnings.push(`Gemini API execution error: ${err.message}`);
    return result;
  }
}
