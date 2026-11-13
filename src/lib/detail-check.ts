/**
 * Recheck for the scan page: do the user-entered details actually
 * match the photo?
 *
 * When a product name and packaging type are entered by hand, the
 * coordinator skips AI vision entirely and trusts the details — so
 * anything random could be entered and saved as a scan. This module
 * asks the free vision path (Gemini first, Groq second) one narrow
 * question: does the photo show what the user typed?
 *
 * The verdict is only acted on when the model is confident
 * (DETAIL_MISMATCH_CONFIDENCE, the same 85% bar the verification
 * flow uses). A low-confidence mismatch or an unavailable vision
 * service never blocks a scan — the scan proceeds, and the caller
 * may show a soft warning instead.
 */

import { checkDetailsWithGroq } from './groq-vision';

export interface DetailCheckResult {
  matches: boolean;
  confidence: number;
  observed: string;
  reason: string;
}

export interface EnteredDetails {
  productName: string;
  packagingType: string;
  materials: string[];
}

// Only block a scan on a mismatch this confident. Below it, the
// details are accepted (the AI may be wrong about a blurry photo).
export const DETAIL_MISMATCH_CONFIDENCE = 0.85;

const GEMINI_MODEL = 'gemini-3.8-flash';

// Shorter than the full vision calls (25s): the recheck is one
// question, and the scan route still has to run the coordinator
// inside its 60s limit.
const RECHECK_TIMEOUT_MS = 15000;

function buildPrompt(details: EnteredDetails): string {
  return `You are checking whether user-entered details match a product packaging photo. The user says this photo shows: product name "${details.productName}", packaging type "${details.packagingType}", materials "${details.materials.join(', ') || 'not given'}". Look at the photo. Does it actually show that product and packaging type? Be fair: different brands, angles, and lighting still count as a match if the product and packaging type are right. Reply with a JSON object only: {"matches": true or false, "confidence": number between 0 and 1, "observed": "briefly, what the photo actually shows", "reason": "brief explanation"}.`;
}

function normalize(parsed: unknown): DetailCheckResult | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p['matches'] !== 'boolean') return null;
  return {
    matches: p['matches'],
    confidence: Math.min(1, Math.max(0, Number(p['confidence']) || 0)),
    observed: typeof p['observed'] === 'string' ? p['observed'] : '',
    reason: typeof p['reason'] === 'string' ? p['reason'] : '',
  };
}

async function checkDetailsWithGemini(
  imageDataUrl: string,
  details: EnteredDetails,
): Promise<DetailCheckResult | null> {
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
                { text: buildPrompt(details) },
                { inlineData: { mimeType, data: base64 } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(RECHECK_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      console.error('Gemini detail-check status:', response.status);
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
    return normalize(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('Gemini detail-check error:', err);
    return null;
  }
}

// Gemini first, Groq second. Returns null when neither free option
// produced a verdict — the caller treats that as "no verdict" and
// lets the scan proceed rather than blocking on an AI outage.
export async function checkDetailsAgainstPhoto(
  imageDataUrl: string,
  details: EnteredDetails,
): Promise<DetailCheckResult | null> {
  const gemini = await checkDetailsWithGemini(imageDataUrl, details);
  if (gemini) return gemini;
  return checkDetailsWithGroq(
    imageDataUrl,
    details.productName,
    details.packagingType,
    details.materials,
  );
}
