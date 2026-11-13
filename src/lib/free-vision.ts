/**
 * Free-tier vision for the Vision Agent (replaces Insforge paid AI).
 *
 * The Vision Agent used to call Insforge's AI gateway
 * (openai/gpt-4o-mini), which is paid-gated on the free plan and
 * failed with "Invalid anon key". This module tries the two free
 * options the app already uses, in the same order as the
 * material-guess route: Gemini first, Groq second. Groq is only asked
 * when Gemini failed or its read was vague/unsure, and then on a
 * shorter 15s timeout, so both attempts still fit inside the scan
 * route's 60s function limit.
 *
 * Either model is asked for the same JSON the old Vision Agent
 * asked for: product name, materials, label text, packaging type,
 * confidence. The reply is validated the same way (product name and
 * packaging type are required), so the coordinator's handling of a
 * failed vision call does not change.
 */

import { analyzePackagingWithGroq } from './groq-vision';
import { mergeVisionWithHints, isVagueVision } from './vision-merge';

export interface FreeVisionResult {
  product_name: string;
  detected_materials: string[];
  label_text: string;
  packaging_type: string;
  confidence: number;
}

const GEMINI_MODEL = 'gemini-3.8-flash';

// Shorter than the full first attempt (25s): the second opinion only
// runs when the first read was weak, and both attempts still have to
// fit inside the scan route's 60s function limit.
const SECOND_OPINION_TIMEOUT_MS = 15000;

const VISION_PROMPT = `Analyze this product packaging image and extract the following information:

1. Product name: the exact brand and product name as printed on the packaging. If it cannot be read, return "Unknown" rather than guessing.
2. Detected materials: name the specific material when visible (PET plastic, HDPE plastic, glass, cardboard, paper, metal, etc.), not just "plastic".
3. Label text (any recycling symbols, material codes, or environmental claims)
4. Packaging type (bottle, box, bag, jar, can, wrapper, etc.)

Respond ONLY with a JSON object in this exact format:
{
  "product_name": "string",
  "detected_materials": ["material1", "material2"],
  "label_text": "string with any text found",
  "packaging_type": "string",
  "confidence": number between 0-1
}

Set confidence to reflect your least certain field. If any information is unclear, make your best estimate and set confidence accordingly.`;

// Validate + normalize a model's reply. Returns null when the reply
// is unusable (not JSON, or missing the two required fields).
function normalizeVision(parsed: unknown): FreeVisionResult | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const product =
    typeof p['product_name'] === 'string' ? p['product_name'].trim() : '';
  const packaging =
    typeof p['packaging_type'] === 'string'
      ? p['packaging_type'].trim().toLowerCase()
      : '';
  if (!product || !packaging) return null;
  const materials = Array.isArray(p['detected_materials'])
    ? p['detected_materials'].filter(
        (m): m is string => typeof m === 'string',
      )
    : [];
  return {
    product_name: product.slice(0, 100),
    detected_materials: materials,
    label_text: typeof p['label_text'] === 'string' ? p['label_text'] : '',
    packaging_type: packaging,
    confidence: Math.min(1, Math.max(0, Number(p['confidence']) || 0)),
  };
}

async function analyzePackagingWithGemini(
  imageDataUrl: string,
): Promise<FreeVisionResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64] = match;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: VISION_PROMPT },
                { inlineData: { mimeType, data: base64 } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(25000),
      },
    );
    if (!response.ok) {
      console.error('Gemini vision status:', response.status);
      return null;
    }
    const json = await response.json();
    const raw: string =
      json?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part.text || '')
        .join(' ')
        .trim() || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return normalizeVision(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('Gemini vision error:', err);
    return null;
  }
}

// Gemini first, Groq second. If Gemini's read is vague or unsure,
// ask Groq for a second opinion and keep the more specific answer
// (Groq is the authority, Gemini fills in where Groq is vague).
// The extra Groq call only happens when the first read is weak.
// Throws only when neither free option produced a usable read, so the
// caller can tell the user to fill the fields in by hand instead.
export async function analyzePackagingWithFreeVision(
  imageDataUrl: string,
): Promise<FreeVisionResult> {
  const gemini = await analyzePackagingWithGemini(imageDataUrl);
  if (gemini && !isVagueVision(gemini)) return gemini;
  const groq = normalizeVision(
    await analyzePackagingWithGroq(imageDataUrl, SECOND_OPINION_TIMEOUT_MS),
  );
  if (groq) {
    const merged = mergeVisionWithHints(groq, gemini ?? {});
    return {
      ...merged,
      confidence: Math.max(groq.confidence, gemini?.confidence ?? 0),
    };
  }
  if (gemini) return gemini;
  throw new Error(
    'Free vision is unavailable right now (Gemini and Groq both failed). Fill in the product name and packaging type yourself, then tap Analyze again.',
  );
}
