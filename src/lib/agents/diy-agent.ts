/**
 * DIY Creative Agent
 *
 * Generates upcycling ideas for a packaging type + materials, using
 * the free vision path: Gemini first, Groq second (same order as
 * the material guess and the vision agent). This used to call
 * Insforge's AI gateway (openai/gpt-4o-mini), which is paid-gated —
 * the same path the vision agent was moved off of. Every scan and
 * every "Get different ideas" refresh goes through here, so the
 * gateway was billing on the app's most common action.
 *
 * The prompt and the idea shape are unchanged — only the model call
 * moved. Temperature stays 0.7: ideas are suggestions, so variation
 * is the point (it is what makes "Get different ideas" return
 * different ideas).
 *
 * There is deliberately NO fallback set of ideas: the project is
 * AI-driven, so when both models fail the agent returns no ideas
 * and an error, and the scan stops instead of showing generic
 * template ideas.
 */

import { generateIdeasWithGroq } from '../groq-vision';
import type { DIYIdea } from '../supabase';

const GEMINI_MODEL = 'gemini-3.8-flash';

function buildPrompt(packagingType: string, detectedMaterials: string[]): string {
  return `
You are a creative DIY upcycling expert. Given the following packaging information:

Packaging Type: ${packagingType}
Materials: ${detectedMaterials.join(', ')}

Generate 3 creative upcycling ideas that transform this packaging waste into useful items.

For each idea, provide:
1. A catchy title
2. Difficulty level (easy, medium, or hard)
3. Materials needed (besides the packaging itself)
4. Step-by-step instructions (3-5 steps)
5. Estimated CO2 saved in kg (realistic estimate based on diverting this waste, under 5 kg — a single project saves well under that)

Think step by step about each idea and make them practical and appealing.

Respond ONLY with a JSON array in this exact format:
[
  {
    "title": "string",
    "difficulty": "easy|medium|hard",
    "materials_needed": ["item1", "item2"],
    "steps": ["step 1", "step 2", "step 3"],
    "estimated_co2_saved_kg": number
  }
]
`;
}

// One retry, but only when the first attempt failed FAST (under
// 10s): a fast 503/429 is transient and worth one more try, while
// a 25s timeout means the model is slow — retrying that would add
// another 25s and push the scan past the route's 60s limit (vision
// alone can take 40s, so the budget is already tight). The retry
// costs nothing when the first attempt succeeds.
async function generateIdeasWithGemini(
  packagingType: string,
  detectedMaterials: string[],
  deadlineMs?: number,
): Promise<unknown[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const remainingMs = () =>
    deadlineMs === undefined ? Infinity : deadlineMs - Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptStarted = Date.now();
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          // Clamped to the scan's shared budget: an unclamped 25s
          // attempt (plus a retry) after a 40s vision step is what
          // pushed scans past the route's 60s limit.
          signal: AbortSignal.timeout(
            Math.min(25000, Math.max(5000, remainingMs() - 5000)),
          ),
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildPrompt(packagingType, detectedMaterials) }] }],
            generationConfig: {
              temperature: 0.7,
              responseMimeType: 'application/json',
            },
          }),
        },
      );
      if (!response.ok) {
        console.error('Gemini DIY status:', response.status);
      } else {
        const json = await response.json();
        const raw: string =
          json?.candidates?.[0]?.content?.parts
            ?.map((part: { text?: string }) => part.text || '')
            .join(' ')
            .trim() || '';
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed: unknown = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) return parsed;
        }
      }
    } catch (err) {
      console.error('Gemini DIY error:', err);
    }
    // Retry only a fast failure (see above): a slow timeout means
    // the model is busy, and another 25s would blow the 60s budget.
    // Also only when the shared budget still has room for it.
    if (attempt === 0 && Date.now() - attemptStarted < 10000 && remainingMs() > 25000) {
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      break;
    }
  }
  return null;
}

// Validate and sanitize a model's ideas. The CO2 number is clamped:
// /api/verify scores points from it (10 + CO2 x 20), so a hallucinated
// 500 kg would mint points with no attacker involved.
function validateIdeas(ideas: unknown): DIYIdea[] | null {
  if (!Array.isArray(ideas) || ideas.length === 0) return null;
  return (ideas as Record<string, unknown>[]).map((idea) => ({
    title: typeof idea.title === 'string' && idea.title ? idea.title : 'Untitled Project',
    difficulty: ['easy', 'medium', 'hard'].includes(idea.difficulty as string)
      ? (idea.difficulty as 'easy' | 'medium' | 'hard')
      : 'medium' as const,
    materials_needed: Array.isArray(idea.materials_needed) ? (idea.materials_needed as string[]) : [],
    steps: Array.isArray(idea.steps) ? (idea.steps as string[]) : [],
    estimated_co2_saved_kg:
      typeof idea.estimated_co2_saved_kg === 'number'
        ? Math.min(Math.max(idea.estimated_co2_saved_kg, 0), 5)
        : 0.5,
  }));
}

export async function runDIYAgent(
  packagingType: string,
  detectedMaterials: string[],
  deadlineMs?: number,
): Promise<{ ideas: DIYIdea[]; error: Error | null }> {
  try {
    const remainingMs = () =>
      deadlineMs === undefined ? Infinity : deadlineMs - Date.now();
    const geminiIdeas = validateIdeas(
      await generateIdeasWithGemini(packagingType, detectedMaterials, deadlineMs),
    );
    if (geminiIdeas) return { ideas: geminiIdeas, error: null };

    // Too little time left in the scan's budget for a second model
    // call: return the error instead of starting a Groq call
    // Vercel would kill mid-flight.
    if (remainingMs() <= 12000) {
      throw new Error('DIY generation ran out of time (Gemini failed and too little time remains for a second attempt)');
    }

    const groqIdeas = validateIdeas(
      await generateIdeasWithGroq(packagingType, detectedMaterials),
    );
    if (groqIdeas) return { ideas: groqIdeas, error: null };

    throw new Error('Free DIY generation unavailable (Gemini and Groq both failed)');
  } catch (error) {
    console.error('DIY Agent error:', error);

    // No fallback ideas: the project is AI-driven, so generic
    // template ideas are worse than stopping. The caller (the
    // coordinator, or the diy-ideas route) turns this error into
    // a plain "AI unavailable, try again later" message.
    return { ideas: [], error: error as Error };
  }
}
