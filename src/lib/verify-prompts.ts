/**
 * Verify prompts — the single source of truth for the project-match
 * question both verify paths ask.
 *
 * The points path and the feedback-only path ask the same match
 * question, and Gemini and Groq get the same text. It used to be
 * copy-pasted in four places (two in the verify route, two in
 * groq-vision.ts), so the two paths could drift apart silently — and
 * on Nov 23 they disagreed on the same photo pair (points approved,
 * feedback rejected on a cap-color difference). With one shared
 * builder, a disagreement is sampling variance, not a prompt
 * difference; temperature 0 on the verify calls narrows even that.
 * The match bar was loosened Nov 23 from "that exact item" to
 * "the same kind of packaging": the challenge code is the fraud
 * defense now, not cap color, and the strict bar rejected
 * legitimate completions (same bottle, different cap) and made
 * the two paths disagree on the same photo pair.
 */

/** The full match question, identical in both paths. */
export function matchAsk(
  packagingType: string,
  projectTitle: string,
  scanPhoto: string | null,
): string {
  const scanMatch = scanPhoto
    ? ` The second image is the original scan of the packaging this project was made from. The finished project must plausibly be made from the same kind of packaging — the same type of container, not necessarily that exact item. A different cap, color, or label on the same kind of container is fine.`
    : '';
  return `Expected project: a DIY project made from a "${packagingType}", titled "${projectTitle}". Does this image show that completed DIY project made from that packaging? Be fair but accurate.${scanMatch}`;
}
