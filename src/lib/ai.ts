/**
 * Backend AI shim
 *
 * The three agents used to call Insforge's paid AI gateway
 * (`ai.chat.completions.create` with openai/gpt-4o-mini). That gateway
 * is gone with the Insforge backend, and nothing replaces it here:
 * - Vision is skipped whenever the scan page supplies product name +
 *   packaging type (the free-plan path), and the Analyze guard blocks
 *   Analyze when those fields are empty.
 * - DIY falls back to built-in ideas when its AI call fails.
 * - Verification is dead code (the verify route uses Groq instead).
 *
 * So this shim throws the same way the live Insforge AI already did
 * ("Invalid anon key"), and the agents' existing error handling takes
 * over unchanged. If a free AI is ever wired in again, replace this
 * one object — the agents' call sites stay the same.
 */

export interface ChatCompletionResponse {
  choices: { message: { content: string | null } }[];
}

export const ai = {
  chat: {
    completions: {
      // Typed as returning a completion so the agents' existing
      // response handling typechecks; it always throws in practice.
      create: async (_args: unknown): Promise<ChatCompletionResponse> => {
        throw new Error(
          'Backend AI unavailable: Insforge AI was removed in the Supabase migration. Use the Gemini/Groq material-guess path instead.',
        );
      },
    },
  },
};
