/**
 * POST /api/verify
 *
 * DIY verification, two modes.
 *
 * Points mode (default): the photo must be taken with the in-app
 * camera and show the challenge code — issued by
 * /api/verify/challenge, written on paper beside the finished
 * project. The server decides the award from two separate results:
 * the project match and the visible evidence (the code). A visual
 * match alone earns nothing, and the model's guess about whether an
 * image is AI-generated is never an award input.
 *
 * Feedback mode (feedbackOnly=true): a gallery upload shows whether
 * a photo matches the selected project. No points, no History row,
 * no attempt spent — the match check only.
 *
 * A failed or pending project can always be retried: each attempt
 * requests a fresh code. Only an awarded project is locked (409).
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb, serverStorage } from '@/lib/supabase';
import { verifyChallengeWithGroq, verifyMatchWithGroq, ChallengeVerdict } from '@/lib/groq-vision';
import { matchAsk } from '@/lib/verify-prompts';
import { uploadImage, storageKeyFromUrl } from '@/lib/storage';
import {
  assertServiceKey,
  requireUser,
  overAttemptCap,
  claimAttempt,
  guestPoolUsed,
  GUEST_DAILY_POOL,
  GUEST_POOL_MESSAGE,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';
import { validateChallengeToken, normalizeCode } from '@/lib/verify-challenge';

type MatchVerdict = { verified: boolean; confidence: number; feedback: string };

async function downloadScanPhoto(scanImageUrl: string | null): Promise<string | null> {
  const key = storageKeyFromUrl(scanImageUrl ?? null);
  if (!key) return null;
  try {
    const { data: blob, error: dlError } = await serverStorage.from('user-uploads').download(key);
    if (dlError || !blob) return null;
    const contentType = blob.type || 'image/jpeg';
    return `data:${contentType};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
  } catch (err) {
    console.error('Scan photo download failed, skipping scan-match check:', err);
    return null;
  }
}

function parseChallengeVerdict(parsed: Record<string, unknown>): ChallengeVerdict {
  const codeSeen = typeof parsed.codeSeen === 'string' && parsed.codeSeen.trim() !== '' ? parsed.codeSeen.trim() : null;
  return {
    projectMatch: Boolean(parsed.projectMatch),
    projectMatchConfidence: Math.min(1, Math.max(0, Number(parsed.projectMatchConfidence) || 0)),
    codeSeen,
    codeVisible: Boolean(parsed.codeVisible) && codeSeen !== null,
    feedback: String(parsed.feedback || 'No feedback provided'),
  };
}

function parseMatchVerdict(parsed: Record<string, unknown>): MatchVerdict {
  return {
    verified: Boolean(parsed.verified),
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    feedback: String(parsed.feedback || 'No feedback provided'),
  };
}

export async function POST(request: NextRequest) {
  try {
    // Auth first: the user id comes from the validated session token,
    // never the body — anyone could pass any id from the leaderboard.
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const userId = user.id;

    const formData = await request.formData();
    const imageFile = formData.get('image') as File;
    const scanId = formData.get('scanId') as string;
    const projectTitle = formData.get('projectTitle') as string;
    const packagingType = formData.get('packagingType') as string;
    const feedbackOnly = formData.get('feedbackOnly') === 'true';
    const challengeToken = formData.get('challengeToken') as string | null;

    // Check each field individually for better error messages
    const missingFields: string[] = [];
    if (!imageFile) missingFields.push('image');
    if (!scanId) missingFields.push('scanId');
    if (!projectTitle) missingFields.push('projectTitle');
    if (!packagingType) missingFields.push('packagingType');
    if (!feedbackOnly && !challengeToken) missingFields.push('challengeToken');

    if (missingFields.length > 0) {
      return NextResponse.json({
        error: `Missing required fields: ${missingFields.join(', ')}`,
        received: { scanId, projectTitle, packagingType }
      }, { status: 400 });
    }

    // Server-side size guard: the client downscales to 1024px first,
    // so a legitimate photo is well under this. 4 MB, not 5: the
    // platform rejects bodies over 4.5 MB before the route runs, so
    // a 5 MB limit here could never fire — 4 MB keeps the friendly
    // error in reach instead of Vercel's generic error page.
    const MAX_VERIFY_IMAGE_BYTES = 4 * 1024 * 1024;
    if (imageFile.size > MAX_VERIFY_IMAGE_BYTES) {
      return NextResponse.json(
        { error: 'That photo is too large (max 4 MB). Please take a smaller photo and try again.' },
        { status: 413 },
      );
    }

    // A temp id is a scan that was never saved — there is nothing to
    // verify against, and the action insert below would fail (or
    // dangle) on the unsaved id. Reject it here, before the cap
    // check, so it burns no verification attempt and no AI calls.
    // /api/actions already refuses temp ids the same way.
    if (typeof scanId === 'string' && scanId.startsWith('temp_')) {
      return NextResponse.json(
        { error: 'This scan was not saved, so it cannot be verified. Please scan again.' },
        { status: 400 },
      );
    }

    // The scan must exist and belong to the caller. A made-up id
    // used to sail through (no row, so no 403) and an action was
    // inserted with a dangling scan_id, so points needed no real
    // scan at all. /api/actions already 404s on a missing scan.
    const { data: scan } = await serverDb
      .from('scans')
      .select('user_id, image_url')
      .eq('id', scanId)
      .single();
    if (!scan) {
      return NextResponse.json(
        { error: 'Scan not found. Please scan again.' },
        { status: 404 },
      );
    }
    if ((scan as { user_id: string }).user_id !== userId) {
      return NextResponse.json({ error: 'Not your scan' }, { status: 403 });
    }

    // Convert image to base64 for AI processing
    const bytes = await imageFile.arrayBuffer();
    const base64Image = `data:${imageFile.type};base64,${Buffer.from(bytes).toString('base64')}`;

    // The original scan photo, for the match check: the model sees
    // both the finished project and the packaging it was supposedly
    // made from. Read straight from storage (service key), never
    // through the stored URL — it is a signed proxy link now. A
    // missing photo is not fatal: the check is skipped and the
    // verification proceeds as before.
    const scanPhoto = await downloadScanPhoto((scan as { image_url?: string | null }).image_url ?? null);

    // --- Feedback mode: match check only. No points, no History
    // row, no attempt spent, no code needed. ---
    if (feedbackOnly) {
      const verdict = await runMatchCheck(base64Image, packagingType, projectTitle, scanPhoto);
      if (!verdict) {
        return NextResponse.json({
          success: true,
          feedbackOnly: true,
          verified: false,
          confidence: 0,
          feedback: 'Automatic checking is unavailable right now. Please try again later.',
          verificationUnavailable: true,
        });
      }
      return NextResponse.json({
        success: true,
        feedbackOnly: true,
        verified: verdict.verified,
        confidence: verdict.confidence,
        feedback: verdict.feedback,
      });
    }

    // --- Points mode below. ---

    // A completed project cannot be verified again for more points:
    // every approved re-verify used to insert another diy_completed
    // row worth up to 110 pts. Checked before the cap and the AI
    // work, so a repeat costs no attempt.
    const { data: completedAction } = await serverDb
      .from('user_actions')
      .select('id')
      .eq('user_id', userId)
      .eq('scan_id', scanId)
      .eq('action_type', 'diy_completed')
      .limit(1)
      .single();
    if (completedAction) {
      return NextResponse.json(
        { error: 'This project is already verified and its points have been awarded. It cannot be verified again.' },
        { status: 409 },
      );
    }

    // The challenge token is validated before any cap or AI work, so
    // a bad or expired code burns no verification attempt. A retry
    // always requests a fresh code, so an expired code just means
    // getting a new one — the client does that from `codeExpired`.
    const challenge = await validateChallengeToken(challengeToken as string, scanId);
    if (!challenge.ok) {
      if (challenge.reason === 'expired') {
        return NextResponse.json(
          { error: 'Your code expired. Please get a fresh code and try again.', codeExpired: true },
          { status: 400 },
        );
      }
      return NextResponse.json(
        { error: 'That code is not valid for this project. Please get a fresh code and try again.' },
        { status: 400 },
      );
    }
    const issuedCode = challenge.code;

    // Points come from the chosen DIY idea, never the client: the
    // client value used to be trusted as a fallback, so any scan
    // with no saved choice — and every fake scan — could mint up
    // to 110 pts by passing estimatedCo2Saved=5. A saved choice is
    // required: the results page saves it before navigating here,
    // and History resumes from the saved row.
    const { data: selectedAction } = await serverDb
      .from('user_actions')
      .select('estimated_co2_saved')
      .eq('user_id', userId)
      .eq('scan_id', scanId)
      .eq('action_type', 'diy_selected')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!selectedAction || typeof (selectedAction as { estimated_co2_saved?: unknown }).estimated_co2_saved !== 'number') {
      return NextResponse.json(
        { error: 'Choose a DIY idea for this scan first, then verify it. Go back to the scan results to pick one.' },
        { status: 400 },
      );
    }
    let estimatedCo2Saved = (selectedAction as { estimated_co2_saved: number }).estimated_co2_saved;
    // Clamp: the diy_selected row is written by /api/actions from a
    // client-supplied number, so trusting it unclamped re-opens the
    // minting hole the fallback clamp closed (a row with 10,000 kg
    // would score 10 + 10,000 x 20). A single DIY idea saves well
    // under 5 kg; anything above that is a bad input, not a better
    // project.
    estimatedCo2Saved = Math.min(Math.max(estimatedCo2Saved, 0), 5);

    // Debug logging
    console.log('Verify request:', {
      hasImage: !!imageFile,
      scanId,
      projectTitle,
      packagingType,
      estimatedCo2Saved
    });

    // Daily cap on verifications: 30/day signed in, 2/day anonymous.
    // Each attempt burns AI quota, so an account cannot script
    // unlimited verifications. The cap counts attempts, not
    // surviving result rows — deleting a project used to refund it.
    const verifyCap = user.isAnonymous ? 2 : 30;
    if (await overAttemptCap(userId, 'verify', 'user_actions', ['diy_completed', 'diy_pending', 'diy_failed'], verifyCap)) {
      return NextResponse.json(
        {
          success: false,
          error: user.isAnonymous
            ? 'Daily verification limit reached (2 for guest accounts). Sign in with Google for 30 a day.'
            : 'Daily verification limit reached (30). Try again tomorrow.',
        },
        { status: 429 },
      );
    }

    // Shared guest pool: all guests together get 40 scans +
    // verifications a day. Once it is used up, guest verifications
    // stop for the day; signed-in users are unaffected.
    if (user.isAnonymous && (await guestPoolUsed()) >= GUEST_DAILY_POOL) {
      return NextResponse.json(
        { success: false, error: GUEST_POOL_MESSAGE },
        { status: 429 },
      );
    }

    // Claim the attempt now that both caps passed: the verification
    // burns AI quota whether it later succeeds or its row is
    // deleted, so the cap counts attempts. Until the one-time SQL
    // creates usage_attempts the claim falls back to counting result
    // rows. The claim inserts first and counts second, so two
    // requests racing the cap check above can no longer both pass
    // and both burn quota.
    if (await claimAttempt(userId, 'verify', 'user_actions', ['diy_completed', 'diy_pending', 'diy_failed'], verifyCap)) {
      return NextResponse.json(
        {
          success: false,
          error: user.isAnonymous
            ? 'Daily verification limit reached (2 for guest accounts). Sign in with Google for 30 a day.'
            : 'Daily verification limit reached (30). Try again tomorrow.',
        },
        { status: 429 },
      );
    }

    // Upload the photo in parallel with the AI calls below (same as
    // the scan route): the upload needs only the file, not the AI
    // result, so it used to sit on the verification's critical path
    // for no reason. It is awaited after the AI result is known,
    // before the action insert that stores its URL. A failed upload
    // is non-fatal — the verification still saves, just without a
    // photo — as before.
    const uploadPromise = uploadImage(imageFile, `verifications/${userId}`);

    // Two free attempts: Gemini, then Groq. If both fail, the
    // submission still succeeds as pending below — it never errors
    // on a verification AI failure, and it is stored as pending,
    // not failed.
    let verdict: ChallengeVerdict | null = null;
    let verificationUnavailable = false;
    verdict = await runChallengeCheck(base64Image, packagingType, projectTitle, scanPhoto);
    if (!verdict) {
      // Both free models failed: this is an outage, not a verdict.
      // It used to be stored as diy_failed with 0% confidence shown
      // as "the AI is 0% confident this photo does not show a
      // completed project" — while the feedback text promised the
      // project was "saved as pending". Store it as pending, and
      // tell the page so it shows Pending, not a 0% verdict.
      verificationUnavailable = true;
      verdict = {
        projectMatch: false,
        projectMatchConfidence: 0,
        codeSeen: null,
        codeVisible: false,
        feedback: 'Automatic verification is unavailable right now, so your project is saved as pending. You can check it in History.',
      };
    }

    // The upload started before the AI calls; collect it now.
    const { url: imageUrl, error: uploadError } = await uploadPromise;

    if (uploadError) {
      console.error('Image upload error:', uploadError);
    }

    // Determine the award. Two separate results, both required:
    // the project match, and the visible evidence — the code read
    // from the photo must be the code issued for this attempt. A
    // visual match alone earns nothing, and no judgement about
    // whether the image looks AI-generated is consulted at all.
    const codeOk = verdict.codeVisible
      && verdict.codeSeen !== null
      && normalizeCode(verdict.codeSeen) === normalizeCode(issuedCode);
    const isApproved = verdict.projectMatch && verdict.projectMatchConfidence >= 0.85 && codeOk;

    // If the evidence is unclear, say so plainly and ask for a
    // clearer capture — that is a failed attempt, not a verdict on
    // the project, and the user retries with a fresh code.
    const feedback = verificationUnavailable
      ? verdict.feedback
      : !verdict.codeVisible
        ? 'We couldn\u2019t read the code in the photo. Make sure the code is written clearly on paper next to your project, then take a clearer photo with the camera.'
        : !codeOk
          ? 'The code in the photo doesn\u2019t match the one shown for this attempt. Please get a fresh code and try again.'
          : verdict.feedback;
    const actionType = verificationUnavailable
      ? 'diy_pending'
      : isApproved
        ? 'diy_completed'
        : verdict.projectMatch && verdict.projectMatchConfidence < 0.85 ? 'diy_pending' : 'diy_failed';

    // Calculate impact score (0 for pending / failed)
    const impactScore = isApproved ? Math.round(10 + (estimatedCo2Saved * 20)) : 0;

    // Log the verdict numbers server-side, and save them on the row
    // when the columns exist, so a later review can answer what the
    // model actually said instead of guessing from the feedback text.
    console.log('Verify verdict:', {
      scanId,
      projectMatch: verdict.projectMatch,
      projectMatchConfidence: verdict.projectMatchConfidence,
      codeSeen: verdict.codeSeen,
      codeVisible: verdict.codeVisible,
      codeOk,
      isApproved,
      impactScore,
    });

    // Always save the verification attempt — and report the result
    // honestly. Previously a failed insert was only logged server-side
    // while the page still claimed "saved as pending", so a pending
    // project could silently never appear in History. (Known cause:
    // the imported user_actions CHECK constraint only allows
    // 'scanned', 'diy_selected' and 'diy_completed', so 'diy_pending'
    // and 'diy_failed' inserts are rejected until the constraint is
    // widened to include both — see the SQL note in the verify page.
    // The page now shows this error instead of claiming success.)
    let saved = true;
    let saveError: string | null = null;
    try {
      // Save the AI's reason (feedback) and the project title too, so
      // History can show what was uploaded and why it failed instead
      // of only "DIY Project" and a generic status line. These columns
      // need the one-time SQL: ALTER TABLE public.user_actions ADD
      // COLUMN IF NOT EXISTS feedback TEXT, ADD COLUMN IF NOT EXISTS
      // project_title TEXT. Until that SQL is run, fall back to saving
      // without them so the project still lands in History (just
      // without the reason/title); the reason is then only visible on
      // the verify result page itself. The verdict columns
      // (verify_match_confidence, verify_code_seen, verify_code_ok)
      // fall back the same way.
      const baseAction = {
        user_id: userId,
        scan_id: scanId,
        action_type: actionType,
        impact_score: impactScore,
        image_url: imageUrl,
      };
      const withFeedback = {
        ...baseAction,
        feedback,
        project_title: projectTitle,
      };
      const withVerdict = {
        ...withFeedback,
        verify_match_confidence: verdict.projectMatchConfidence,
        verify_code_seen: verdict.codeSeen,
        verify_code_ok: codeOk,
      };
      const attempts: Array<Record<string, unknown>> = [withVerdict, withFeedback, baseAction];
      let insertError: { message?: string } | null = null;
      for (const row of attempts) {
        insertError = (await serverDb.from('user_actions').insert([row])).error;
        if (!insertError) break;
        // Only fall back a tier when the failure is a missing
        // column; any other error (constraint, RLS, network) stops
        // here so a real problem is reported, not hidden.
        if (!/column/i.test(insertError.message || '')) break;
      }
      if (insertError) {
        saved = false;
        saveError = 'Your project could not be saved to History. Please try again.';
        console.error('Failed to save action:', insertError);
      }
    } catch (dbErr) {
      saved = false;
      saveError = 'Your project could not be saved to History. Please try again.';
      console.error('Failed to save action:', dbErr);
    }

    // No score column is updated here: scores are derived from the
    // action just saved, so the points appear on every display as
    // soon as the row exists. The old code also wrote
    // users.sustainability_score, a column nothing reads anymore.

    return NextResponse.json({
      success: true,
      saved,
      saveError,
      // `verified` is the project-match verdict (drives the
      // Pending/Not-verified wording); `approved` is the award
      // (match + code) and is what earns points.
      verified: verdict.projectMatch,
      confidence: verdict.projectMatchConfidence,
      approved: isApproved,
      codeOk,
      codeSeen: verdict.codeSeen,
      feedback,
      verificationUnavailable,
      impactScore,
      imageUrl,
    });
  } catch (error) {
    return handleRouteError(error, 'Verification API error:');
  }
}

// Points-path AI check: Gemini first, Groq second. The prompt asks
// for the two separate judgements the award needs — project match
// and the code read from the photo.
async function runChallengeCheck(
  base64Image: string,
  packagingType: string,
  projectTitle: string,
  scanPhoto: string | null,
): Promise<ChallengeVerdict | null> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const mimeMatch = base64Image.match(/^data:([^;]+);base64,/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const rawBase64 = base64Image.replace(/^data:[^;]+;base64,/, '');
      // The model judges the finished project against the original
      // scan photo too, when it could be downloaded: a generated
      // image almost never reproduces the exact item from the scan.
      // The match question is the shared one (see verify-prompts.ts)
      // so the points and feedback-only verdicts cannot drift apart.
      const verifyPrompt = `You are evaluating a DIY upcycling project verification photo. ${matchAsk(packagingType, projectTitle, scanPhoto)} Second, there should be a short code handwritten on a piece of paper in the photo, next to the project. Read exactly what the code says and report it character for character. Do not guess: if the code is missing, blurry or unreadable, say so. Respond ONLY with a JSON object: {"projectMatch": true or false, "projectMatchConfidence": number between 0 and 1, "codeSeen": "the code exactly as you read it, or null if it cannot be read", "codeVisible": true or false, "feedback": "brief explanation"}.`;
      const scanMimeMatch = scanPhoto?.match(/^data:([^;]+);base64,/);
      const verifyParts = [
        { text: verifyPrompt },
        { inlineData: { mimeType, data: rawBase64 } },
        ...(scanPhoto
          ? [{ inlineData: { mimeType: scanMimeMatch ? scanMimeMatch[1] : 'image/jpeg', data: scanPhoto.replace(/^data:[^;]+;base64,/, '') } }]
          : []),
      ];
      const geminiResponse = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            // Temperature 0: the same evidence should give the same
            // verdict — the points and feedback-only paths must not
            // disagree by sampling luck.
            generationConfig: { temperature: 0 },
            contents: [{
              parts: verifyParts,
            }],
          }),
        },
      );
      if (geminiResponse.ok) {
        const geminiJson = await geminiResponse.json();
        const content = geminiJson?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('') || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return parseChallengeVerdict(JSON.parse(jsonMatch[0]) as Record<string, unknown>);
        }
      }
    } catch (err) {
      console.error('Gemini verification unavailable, falling back to Groq:', err);
    }
  }
  // Second free attempt: Groq, before falling back to pending.
  return verifyChallengeWithGroq(base64Image, packagingType, projectTitle, scanPhoto);
}

// Feedback-only match check: Gemini first, Groq second. Same match
// question, no code involved.
async function runMatchCheck(
  base64Image: string,
  packagingType: string,
  projectTitle: string,
  scanPhoto: string | null,
): Promise<MatchVerdict | null> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const mimeMatch = base64Image.match(/^data:([^;]+);base64,/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const rawBase64 = base64Image.replace(/^data:[^;]+;base64,/, '');
      const matchPrompt = `You are evaluating a DIY upcycling project photo. ${matchAsk(packagingType, projectTitle, scanPhoto)} Respond ONLY with a JSON object: {"verified": true or false, "confidence": number between 0 and 1, "feedback": "brief explanation"}.`;
      const scanMimeMatch = scanPhoto?.match(/^data:([^;]+);base64,/);
      const matchParts = [
        { text: matchPrompt },
        { inlineData: { mimeType, data: rawBase64 } },
        ...(scanPhoto
          ? [{ inlineData: { mimeType: scanMimeMatch ? scanMimeMatch[1] : 'image/jpeg', data: scanPhoto.replace(/^data:[^;]+;base64,/, '') } }]
          : []),
      ];
      const geminiResponse = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            // Temperature 0, as in the points path above.
            generationConfig: { temperature: 0 },
            contents: [{
              parts: matchParts,
            }],
          }),
        },
      );
      if (geminiResponse.ok) {
        const geminiJson = await geminiResponse.json();
        const content = geminiJson?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('') || '';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return parseMatchVerdict(JSON.parse(jsonMatch[0]) as Record<string, unknown>);
        }
      }
    } catch (err) {
      console.error('Gemini match check unavailable, falling back to Groq:', err);
    }
  }
  return verifyMatchWithGroq(base64Image, packagingType, projectTitle, scanPhoto);
}
