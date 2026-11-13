/**
 * POST /api/verify
 * 
 * Verification Agent endpoint that checks DIY completion photos.
 * Awards impact points if verification passes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import { verifyWithGroq } from '@/lib/groq-vision';
import { uploadImage } from '@/lib/storage';
import {
  assertServiceKey,
  requireUser,
  overDailyCap,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

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

    // Check each field individually for better error messages
    const missingFields: string[] = [];
    if (!imageFile) missingFields.push('image');
    if (!scanId) missingFields.push('scanId');
    if (!projectTitle) missingFields.push('projectTitle');
    if (!packagingType) missingFields.push('packagingType');

    if (missingFields.length > 0) {
      return NextResponse.json({
        error: `Missing required fields: ${missingFields.join(', ')}`,
        received: { scanId, projectTitle, packagingType }
      }, { status: 400 });
    }

    // The scan must belong to the caller when it exists. (A temp
    // scan id — a scan that was never saved — has no row, so it
    // proceeds as before.)
    const { data: scan } = await serverDb
      .from('scans')
      .select('user_id')
      .eq('id', scanId)
      .single();
    if (scan && (scan as { user_id: string }).user_id !== userId) {
      return NextResponse.json({ error: 'Not your scan' }, { status: 403 });
    }

    // Points come from the chosen DIY idea, not the client: the
    // client value used to be trusted, so anyone could submit a
    // verification with an inflated CO2 number and mint points
    // (10 + CO2 x 20). Look up the latest diy_selected action for
    // this scan; if the choice was never saved (the log can race the
    // navigation from the results page), fall back to the client
    // value clamped to 5 kg — a single DIY idea saves well under that.
    let estimatedCo2Saved = 0.5;
    const { data: selectedAction } = await serverDb
      .from('user_actions')
      .select('estimated_co2_saved')
      .eq('user_id', userId)
      .eq('scan_id', scanId)
      .eq('action_type', 'diy_selected')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (selectedAction && typeof (selectedAction as { estimated_co2_saved?: unknown }).estimated_co2_saved === 'number') {
      estimatedCo2Saved = (selectedAction as { estimated_co2_saved: number }).estimated_co2_saved;
    } else {
      const clientValue = parseFloat(formData.get('estimatedCo2Saved') as string);
      estimatedCo2Saved = Number.isFinite(clientValue)
        ? Math.min(Math.max(clientValue, 0), 5)
        : 0.5;
    }

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
    // unlimited verifications.
    const verifyCap = user.isAnonymous ? 2 : 30;
    if (await overDailyCap(userId, 'user_actions', ['diy_completed', 'diy_pending', 'diy_failed'], verifyCap)) {
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

    // Convert image to base64 for AI processing
    const bytes = await imageFile.arrayBuffer();
    const base64Image = `data:${imageFile.type};base64,${Buffer.from(bytes).toString('base64')}`;

    // Try Gemini (free tier, server-side key) to verify the photo.
    // If Gemini is unavailable, the submission still succeeds as
    // pending below — it never errors on a verification AI failure.
    let verificationResult: { verified: boolean; confidence: number; feedback: string } | null = null;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const mimeMatch = base64Image.match(/^data:([^;]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const rawBase64 = base64Image.replace(/^data:[^;]+;base64,/, '');
        const geminiResponse = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: `You are evaluating a DIY upcycling project verification photo. Expected project: a DIY project made from a "${packagingType}", titled "${projectTitle}". Does this image show a completed DIY upcycling project using that packaging? Be fair but accurate. Respond ONLY with a JSON object: {"verified": true or false, "confidence": number between 0 and 1, "feedback": "brief explanation"}.` },
                  { inlineData: { mimeType, data: rawBase64 } },
                ],
              }],
            }),
          },
        );
        if (geminiResponse.ok) {
          const geminiJson = await geminiResponse.json();
          const content = geminiJson?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('') || '';
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            verificationResult = {
              verified: Boolean(parsed.verified),
              confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
              feedback: String(parsed.feedback || 'No feedback provided'),
            };
          }
        }
      } catch (err) {
        console.error('Gemini verification unavailable, falling back to pending:', err);
      }
    }
    // Second free attempt: Groq, before falling back to pending.
    if (!verificationResult) {
      verificationResult = await verifyWithGroq(base64Image, packagingType, projectTitle);
    }
    if (!verificationResult) {
      verificationResult = {
        verified: false,
        confidence: 0,
        feedback: 'Automatic verification is unavailable right now, so your project is saved as pending. You can check it in History.',
      };
    }

    // Upload verification image
    const { url: imageUrl, error: uploadError } = await uploadImage(
      imageFile, 
      `verifications/${userId}`
    );
    
    if (uploadError) {
      console.error('Image upload error:', uploadError);
    }

    // Determine verification status
    // verified=false means the AI found this is NOT a completed project,
    // so it is a failed attempt, not pending. Only verified=true with
    // confidence below 0.85 stays pending.
    const isApproved = verificationResult.verified && verificationResult.confidence >= 0.85;
    const actionType = isApproved
      ? 'diy_completed'
      : verificationResult.verified ? 'diy_pending' : 'diy_failed';

    // Calculate impact score (0 for pending / failed)
    const impactScore = isApproved ? Math.round(10 + (estimatedCo2Saved * 20)) : 0;

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
      // the verify result page itself.
      const baseAction = {
        user_id: userId,
        scan_id: scanId,
        action_type: actionType,
        impact_score: impactScore,
        image_url: imageUrl,
      };
      let insertError = (await serverDb.from('user_actions').insert([{
        ...baseAction,
        feedback: verificationResult.feedback,
        project_title: projectTitle,
      }])).error;
      if (insertError && /column|feedback|project_title/i.test(insertError.message)) {
        insertError = (await serverDb.from('user_actions').insert([baseAction])).error;
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

    // If approved, update user's cumulative score
    if (isApproved && impactScore > 0) {
      try {
        const { data: userData } = await serverDb
          .from('users')
          .select('sustainability_score')
          .eq('id', userId)
          .single();

        if (userData) {
          await serverDb
            .from('users')
            .update({ 
              sustainability_score: (userData.sustainability_score || 0) + impactScore 
            })
            .eq('id', userId);
        }
      } catch (scoreErr) {
        console.error('Failed to update score:', scoreErr);
      }
    }

    return NextResponse.json({
      success: true,
      saved,
      saveError,
      verified: verificationResult.verified,
      confidence: verificationResult.confidence,
      feedback: verificationResult.feedback,
      impactScore,
      imageUrl,
    });

  } catch (error) {
    return handleRouteError(error, 'Verify API error:');
  }
}

export const maxDuration = 60;
