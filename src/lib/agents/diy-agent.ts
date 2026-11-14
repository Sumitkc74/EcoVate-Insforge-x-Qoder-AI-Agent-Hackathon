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
 * The prompt, the idea shape, and the built-in fallback ideas are
 * unchanged — only the model call moved. Temperature stays 0.7:
 * ideas are suggestions, so variation is the point (it is what
 * makes "Get different ideas" return different ideas).
 */

import { generateIdeasWithGroq } from '../groq-vision';
import type { DIYIdea } from '../insforge';

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

// One retry on a transient failure (Gemini 503s and timeouts are
// its known flakiness): the first attempt usually fails fast
// enough that a second try still fits the 60s route limit, and it
// costs nothing when the first attempt succeeds.
async function generateIdeasWithGemini(
  packagingType: string,
  detectedMaterials: string[],
): Promise<unknown[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          signal: AbortSignal.timeout(25000),
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
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
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
  detectedMaterials: string[]
): Promise<{ ideas: DIYIdea[]; error: Error | null }> {
  try {
    const geminiIdeas = validateIdeas(
      await generateIdeasWithGemini(packagingType, detectedMaterials),
    );
    if (geminiIdeas) return { ideas: geminiIdeas, error: null };

    const groqIdeas = validateIdeas(
      await generateIdeasWithGroq(packagingType, detectedMaterials),
    );
    if (groqIdeas) return { ideas: groqIdeas, error: null };

    throw new Error('Free DIY generation unavailable (Gemini and Groq both failed)');
  } catch (error) {
    console.error('DIY Agent error:', error);

    // Return fallback ideas
    const fallbackIdeas: DIYIdea[] = [
      {
        title: `${packagingType} Planter`,
        difficulty: 'easy',
        materials_needed: ['soil', 'seeds or small plant'],
        steps: [
          `Clean the ${packagingType} thoroughly`,
          'Add drainage holes if needed',
          'Fill with potting soil',
          'Plant seeds or transplant a small plant',
          'Water and place in sunlight'
        ],
        estimated_co2_saved_kg: 0.3,
      },
      {
        title: `${packagingType} Storage Container`,
        difficulty: 'easy',
        materials_needed: ['decorative tape or paint (optional)'],
        steps: [
          `Clean and dry the ${packagingType}`,
          'Remove any labels if desired',
          'Decorate with tape or paint',
          'Use to store small items like buttons, coins, or office supplies'
        ],
        estimated_co2_saved_kg: 0.2,
      },
      {
        title: `${packagingType} Bird Feeder`,
        difficulty: 'medium',
        materials_needed: ['string or wire', 'bird seed', 'wooden spoons or sticks'],
        steps: [
          `Clean the ${packagingType} thoroughly`,
          'Cut feeding holes near the base',
          'Attach perches using wooden spoons or sticks',
          'Create a hanging mechanism with string or wire',
          'Fill with bird seed and hang outside'
        ],
        estimated_co2_saved_kg: 0.4,
      },
    ];

    return { ideas: fallbackIdeas, error: error as Error };
  }
}
