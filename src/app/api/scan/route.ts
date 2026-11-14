/**
 * POST /api/scan
 * 
 * Coordinator Agent endpoint that orchestrates Vision → Research → DIY agents.
 * Accepts an image file, runs the multi-agent pipeline, and returns results.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runCoordinatorAgent } from '@/lib/agents';
import { serverDb } from '@/lib/insforge';
import { uploadImage } from '@/lib/storage';
import { checkDetailsAgainstPhoto, DETAIL_MISMATCH_CONFIDENCE } from '@/lib/detail-check';
import {
  assertServiceKey,
  requireUser,
  overAttemptCap,
  logAttempt,
  guestPoolUsed,
  GUEST_DAILY_POOL,
  GUEST_POOL_MESSAGE,
  unauthorizedResponse,
  handleRouteError,
  type AuthedUser,
} from '@/lib/server-auth';

// Diagnostic marker: GET /api/scan returns this version, so a live
// check can prove which code the deployed site is actually running.
// Bump it on every diagnostic change.
export const SCAN_API_VERSION = 'imgcheck11-diy-groq-budget';

export async function GET() {
  return NextResponse.json({ ok: true, version: SCAN_API_VERSION });
}

// Upload the photo to storage. Kept separate so the scan route can
// start it in parallel with the AI coordinator instead of after it:
// the upload needs only the photo, not the AI result.
async function uploadScanImage(
  base64Image: string,
  userId: string,
): Promise<{ imageUrl: string | null; imageUploadError: string | null }> {
  // Convert base64 to file for storage upload. The failure is
  // returned in the response (imageUploadError) instead of only
  // being logged server-side: previously the scan was saved with
  // no photo and nothing told the user why History showed a
  // placeholder.
  try {
    // Extract base64 data and mime type
    const base64Match = base64Image.match(/^data:(.*?);base64,(.*)$/);
    if (!base64Match) {
      throw new Error('Invalid base64 image format');
    }

    const mimeType = base64Match[1] || 'image/jpeg';
    const base64Data = base64Match[2];

    // Use Buffer for base64 decoding (works in Edge runtime)
    const byteArray = Buffer.from(base64Data, 'base64');
    const blob = new Blob([byteArray], { type: mimeType });
    const file = new File([blob], 'scan.jpg', { type: mimeType });

    const { url, error: uploadError } = await uploadImage(file, `scans/${userId}`);
    if (uploadError) {
      return { imageUrl: null, imageUploadError: uploadError.message };
    }
    return { imageUrl: url, imageUploadError: null };
  } catch (uploadErr) {
    console.error('Image upload error:', uploadErr);
    // Continue without image URL - non-critical error
    return { imageUrl: null, imageUploadError: (uploadErr as Error).message };
  }
}

// Ensure the public.users row exists: scans.user_id is a foreign
// key to public.users(id), and new sign-ins never get a row there
// (the callback's client-side profile insert is blocked by RLS,
// which has no INSERT policy for users). Without this row the scan
// insert fails on the foreign key and history stays empty, even
// with the server-side client that bypasses RLS. Returns an error
// message for the response, or null. Kept separate so it can run
// in parallel with the AI coordinator.
async function ensureUserProfile(user: AuthedUser): Promise<string | null> {
  try {
    // Identity comes from the validated session, never the body:
    // the old code took name/email/avatar from the request, so
    // anyone could rewrite any user's profile row by scanning as
    // them.
    const userEmail = user.email || `${user.id}@ecovate.local`;
    // ignoreDuplicates: a plain upsert overwrites EVERY column on
    // conflict, so this used to reset sustainability_score to 0 on
    // every scan — wiping points a user had already earned (e.g. the
    // 35 merged legacy points). With ignoreDuplicates, an existing
    // row is left untouched and the 0 score only applies to a
    // brand-new user row.
    const { error: profileError } = await serverDb
      .from('users')
      .upsert([{
        id: user.id,
        email: userEmail,
        // Anonymous accounts have no email to derive a name from,
        // so they fall back to 'Guest' (or the name they chose).
        name: user.name || (user.isAnonymous ? 'Guest' : userEmail.split('@')[0]),
        avatar: user.avatar,
        sustainability_score: 0,
      }], { onConflict: 'id', ignoreDuplicates: true });
    if (profileError) {
      console.error('Profile upsert error:', profileError);
      return 'Profile could not be saved.';
    }
    return null;
  } catch (profileErr) {
    console.error('Profile upsert exception:', profileErr);
    return 'Profile could not be saved.';
  }
}

export async function POST(request: NextRequest) {
  try {
    // Auth first: the user id comes from the validated session token,
    // never the body — anyone could pass any id from the leaderboard.
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const userId = user.id;

    const body = await request.json();
    const base64Image = body.image as string;

    if (!base64Image) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    // Daily cap on scans: 30/day signed in, 2/day anonymous. Each
    // scan burns AI quota, so an account cannot script unlimited scans.
    // The cap counts attempts, not surviving scans rows — deleting a
    // scan used to refund the quota (scan, delete, scan again).
    const scanCap = user.isAnonymous ? 2 : 30;
    if (await overAttemptCap(userId, 'scan', 'scans', null, scanCap)) {
      return NextResponse.json(
        {
          success: false,
          error: user.isAnonymous
            ? 'Daily scan limit reached (2 for guest accounts). Sign in with Google for 30 a day.'
            : 'Daily scan limit reached (30). Try again tomorrow.',
        },
        { status: 429 },
      );
    }

    // Shared guest pool: all guests together get 40 scans +
    // verifications a day. Once it is used up, guest scans stop for
    // the day; signed-in users are unaffected.
    if (user.isAnonymous && (await guestPoolUsed()) >= GUEST_DAILY_POOL) {
      return NextResponse.json(
        { success: false, error: GUEST_POOL_MESSAGE },
        { status: 429 },
      );
    }

    // Log the attempt now that both caps passed: the scan burns AI
    // quota whether it later succeeds or its rows are deleted, so
    // the cap counts attempts. Until the one-time SQL creates
    // usage_attempts the log fails silently and the cap falls back
    // to counting scans rows.
    await logAttempt(userId, 'scan');

    // Optional manual details: when product name + packaging type are
    // supplied, the coordinator skips Vision AI entirely (free-plan path).
    const manualMaterials = Array.isArray(body.materials)
      ? body.materials
      : typeof body.materials === 'string'
        ? body.materials.split(',').map((m: string) => m.trim()).filter(Boolean)
        : [];
    const manual = {
      product_name: typeof body.product_name === 'string' ? body.product_name : undefined,
      packaging_type: typeof body.packaging_type === 'string' ? body.packaging_type : undefined,
      detected_materials: manualMaterials,
      label_text: typeof body.label_text === 'string' ? body.label_text : undefined,
    };

    // Recheck hand-entered details against the photo. The coordinator
    // skips vision entirely when a product name + packaging type are
    // supplied, so without this anything random could be entered and
    // saved as a scan. A confident mismatch (85%+, the same bar as
    // verification) stops the scan and tells the user what the AI
    // actually sees, so they can correct the details or retake the
    // photo from a different angle. An unsure verdict, or vision
    // being unavailable, never blocks the scan.
    let detailWarning: string | null = null;
    if (manual.product_name && manual.packaging_type) {
      const check = await checkDetailsAgainstPhoto(base64Image, {
        productName: manual.product_name,
        packagingType: manual.packaging_type,
        materials: manualMaterials,
      });
      if (check && !check.matches && check.confidence >= DETAIL_MISMATCH_CONFIDENCE) {
        return NextResponse.json({
          success: false,
          mismatch: true,
          error: `This photo doesn't look like a ${manual.packaging_type} (${manual.product_name}). The AI sees: ${check.observed || 'something else'}. Correct the details below, or take another photo from a different angle.`,
          observed: check.observed,
          reason: check.reason,
          confidence: check.confidence,
        }, { status: 422 });
      }
      if (check && !check.matches) {
        detailWarning = `The AI wasn't sure your details match the photo (it sees: ${check.observed || 'something else'}). Double-check the product name and packaging type.`;
      }
    }

    // The coordinator (AI), the photo upload and the profile
    // upsert are independent — they used to run one after the other,
    // which put the storage round-trip and the profile write on the
    // scan's critical path. They now run together; only the scan
    // insert below still waits for the AI result and the photo URL.
    // If the AI fails, the upload and profile work already done is
    // harmless (the profile row should exist anyway; a failed scan
    // leaves one unreferenced photo in storage).
    console.log('Starting Coordinator Agent...');
    const coordinatorPromise = runCoordinatorAgent(base64Image, manual);
    const uploadPromise = uploadScanImage(base64Image, userId);
    const profilePromise = ensureUserProfile(user);

    const coordinatorResult = await coordinatorPromise;

    // Honest degradation note: when vision was down and the scan was
    // built from the on-device results instead, say so on the results
    // page rather than presenting it as a full AI read.
    const visionFallback = coordinatorResult.errors.some((e) =>
      e.includes('using on-device results'),
    )
      ? 'AI vision was unavailable for this scan, so it was built from the on-device reading instead. Double-check the details.'
      : null;

    if (!coordinatorResult.success && !coordinatorResult.data) {
      return NextResponse.json({
        success: false,
        // Surface the real reason instead of a generic failure: the
        // frontend previously showed only "Scan failed" for every 500.
        error: coordinatorResult.errors.join('; ') || 'Scan failed',
        errors: coordinatorResult.errors,
        executionTimeMs: coordinatorResult.executionTimeMs,
      }, { status: 500 });
    }

    const { imageUrl, imageUploadError } = await uploadPromise;

    // Diagnostic fields: previously a failed scan insert was only
    // logged server-side (logs are not reachable here) and the client
    // silently fell back to a temporary ID, so the real error was
    // invisible. Return it in the response instead.
    const profileErrorMsg: string | null = await profilePromise;
    let dbErrorMsg: string | null = null;

    // Save scan to database. The DIY ideas are stored with the scan,
    // so "Add DIY" later shows the same three ideas the results page
    // showed — instead of generating a fresh set every time. The
    // column needs the one-time SQL (ALTER TABLE public.scans ADD
    // COLUMN IF NOT EXISTS diy_ideas JSONB); until it exists, the
    // insert falls back to the columns that do, and Add DIY
    // regenerates ideas as before.
    const scanData: Record<string, unknown> = {
      user_id: userId,
      product_name: coordinatorResult.data!.product_name,
      materials: coordinatorResult.data!.detected_materials,
      carbon_footprint: coordinatorResult.data!.carbon_footprint_kg || 0,
      recyclability_score: coordinatorResult.data!.recyclability_score || 0,
      image_url: imageUrl,
      diy_ideas: coordinatorResult.data!.diy_ideas || [],
    };

    let scanId: string | null = null;

    try {
      let { data: scanRecord, error: dbError } = await serverDb
        .from('scans')
        .insert([scanData])
        .select()
        .single();

      if (dbError && /diy_ideas|42703/.test(
        `${(dbError as { code?: string }).code || ''} ${(dbError as { message?: string }).message || ''}`,
      )) {
        const { diy_ideas: _dropped, ...fallbackData } = scanData;
        ({ data: scanRecord, error: dbError } = await serverDb
          .from('scans')
          .insert([fallbackData])
          .select()
          .single());
      }

      if (dbError) {
        dbErrorMsg = 'Scan could not be saved to History.';
        console.error('Database error:', dbError);
      } else if (scanRecord) {
        scanId = scanRecord.id;
      }
    } catch (dbErr) {
      dbErrorMsg = 'Scan could not be saved to History.';
      console.error('Database insert error:', dbErr);
    }

    // Log user action. The packaging type is stored here too, so
    // "Add DIY" later does not have to re-read the stored photo
    // with vision to recover it (see /api/diy-ideas). The column
    // needs the one-time SQL from Nov 12 — until it exists, the
    // insert falls back to the columns that do, same as /api/actions.
    try {
      const actionRow: Record<string, unknown> = {
        user_id: userId,
        scan_id: scanId,
        action_type: 'scanned',
        impact_score: 0,
        image_url: imageUrl,
      };
      const packagingType = coordinatorResult.data!.packaging_type;
      if (packagingType) actionRow.packaging_type = packagingType;
      const { error: actionError } = await serverDb.from('user_actions').insert([actionRow]);
      if (actionError && /packaging_type|42703/.test(
        `${(actionError as { code?: string }).code || ''} ${(actionError as { message?: string }).message || ''}`,
      )) {
        const { packaging_type: _dropped, ...fallbackRow } = actionRow;
        await serverDb.from('user_actions').insert([fallbackRow]);
      } else if (actionError) {
        console.error('Action log error:', actionError);
      }
    } catch (actionErr) {
      console.error('Action log error:', actionErr);
    }

    // Generate a fallback scanId if database insert failed
    if (!scanId) {
      scanId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    return NextResponse.json({
      success: true,
      scanId: scanId,
      data: coordinatorResult.data,
      errors: coordinatorResult.errors.length > 0 ? coordinatorResult.errors : undefined,
      executionTimeMs: coordinatorResult.executionTimeMs,
      version: SCAN_API_VERSION,
      scanSaved: scanId !== null && !scanId.startsWith('temp_'),
      saveError: dbErrorMsg,
      profileError: profileErrorMsg,
      imageUrl,
      imageUploadError,
      detailWarning,
      visionFallback,
    });

  } catch (error) {
    return handleRouteError(error, 'Scan API error:');
  }
}

// Configure for longer timeout (Node.js runtime allows up to 60s on Hobby, 300s on Pro)
export const maxDuration = 60; // 60 seconds max for AI processing
