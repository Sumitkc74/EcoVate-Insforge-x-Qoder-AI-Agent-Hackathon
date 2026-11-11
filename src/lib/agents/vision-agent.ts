/**
 * Vision Agent
 *
 * Reads product name, materials, label text and packaging type from
 * a packaging photo using the free vision path: Gemini first, Groq
 * second (src/lib/free-vision.ts). This used to call Insforge's paid
 * AI gateway, which failed with "Invalid anon key" on the free plan.
 */

import { analyzePackagingWithFreeVision } from '../free-vision';

export interface VisionResult {
  product_name: string;
  detected_materials: string[];
  label_text: string;
  packaging_type: string;
  confidence: number;
}

export async function runVisionAgent(imageBase64: string): Promise<{ result: VisionResult | null; error: Error | null }> {
  try {
    const result = await analyzePackagingWithFreeVision(imageBase64);
    return { result, error: null };
  } catch (error) {
    console.error('Vision Agent error:', error);
    return {
      result: null,
      error: error as Error
    };
  }
}
