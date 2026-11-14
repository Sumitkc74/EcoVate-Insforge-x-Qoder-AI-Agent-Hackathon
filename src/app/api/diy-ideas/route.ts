/**
 * GET /api/diy-ideas?scanId=...[&refresh=1]
 *
 * DIY ideas for a saved scan ("Add DIY" from History or the
 * dashboard). The scan's own ideas are shown — the three the results
 * page showed when the scan ran, stored on the scan row — so the
 * user sees the same recommendations every time they come back.
 * Only an explicit refresh (the "Get different ideas" button, or
 * "Choose again" after a choice was made) runs the DIY agent again
 * and replaces the stored set. Scans made before the ideas were
 * stored generate a fresh set once and store it for next time.
 * The packaging type is read from the 'scanned' action the scan
 * route stored it on; only older scans fall back to reading the
 * stored photo with the free vision path. Only the scan's owner
 * can use it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import { runVisionAgent } from '@/lib/agents/vision-agent';
import { runDIYAgent } from '@/lib/agents/diy-agent';
import {
  assertServiceKey,
  requireUser,
  overAttemptCap,
  logAttempt,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

export async function GET(request: NextRequest) {
  try {
    // The user id comes from the validated session token, never the
    // query string. Ownership is still checked server-side against
    // the scan row below — now it means something, because the id
    // itself is authenticated.
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const userId = user.id;

    const scanId = request.nextUrl.searchParams.get('scanId');
    if (!scanId) {
      return NextResponse.json({ error: 'Missing scanId' }, { status: 400 });
    }
    // refresh=1 means the user explicitly asked for different ideas
    // ("Get different ideas" / "Choose again"). Anything else shows
    // the scan's stored set.
    const refresh = request.nextUrl.searchParams.get('refresh') === '1';

    const { data: scan, error: scanError } = await serverDb
      .from('scans')
      .select('*')
      .eq('id', scanId)
      .single();
    if (scanError || !scan) {
      return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
    }
    if (scan.user_id !== userId) {
      return NextResponse.json({ error: 'Not your scan' }, { status: 403 });
    }

    // The packaging type was already worked out when the scan ran,
    // and the scan route stores it on the 'scanned' action — so read
    // it from there instead of re-running vision on the stored photo
    // on every open. Vision on the photo is only the fallback for
    // scans made before that was stored.
    let packagingType = 'container';
    try {
      const { data: scannedAction } = await serverDb
        .from('user_actions')
        .select('packaging_type')
        .eq('scan_id', scanId)
        .eq('action_type', 'scanned')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      const stored = (scannedAction as { packaging_type?: string } | null)?.packaging_type;
      if (stored) packagingType = stored;
    } catch {
      // No stored type — fall through to the photo below.
    }
    if (packagingType === 'container' && scan.image_url) {
      try {
        const imageResponse = await fetch(scan.image_url);
        if (imageResponse.ok) {
          const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
          const buffer = Buffer.from(await imageResponse.arrayBuffer());
          const base64 = `data:${contentType};base64,${buffer.toString('base64')}`;
          const { result } = await runVisionAgent(base64);
          if (result?.packaging_type) {
            packagingType = result.packaging_type;
            // Store it on the 'scanned' action so the next open reads
            // it from the database instead of re-running vision on
            // the photo every time (old scans have no stored type).
            try {
              await serverDb
                .from('user_actions')
                .update({ packaging_type: packagingType })
                .eq('scan_id', scanId)
                .eq('action_type', 'scanned');
            } catch {
              // Best effort — the type still returns fine below.
            }
          }
        }
      } catch (e) {
        console.error('DIY ideas: could not read stored photo, using container:', e);
      }
    }

    // The scan's own ideas first: the three the results page showed
    // when the scan ran. A fresh set is generated only on an explicit
    // refresh, or for scans made before ideas were stored — and then
    // stored, so the next open shows the same set.
    const storedIdeas = Array.isArray((scan as { diy_ideas?: unknown }).diy_ideas)
      ? ((scan as { diy_ideas: unknown[] }).diy_ideas as { title?: string }[])
          .filter((idea) => idea && typeof idea.title === 'string')
      : [];
    if (!refresh && storedIdeas.length > 0) {
      return NextResponse.json({
        success: true,
        scan,
        packagingType,
        diyIdeas: storedIdeas,
        fromStored: true,
      });
    }

    // Generating ideas burns an AI call, so it is capped per day
    // like guesses: 10 for guests, 30 signed in. Stored ideas cost
    // nothing and are not counted — only this generation branch is.
    // Needs the one-time SQL widening the usage_attempts CHECK to
    // include 'diy_refresh'; until then the log fails silently and
    // the cap cannot be enforced.
    const refreshCap = user.isAnonymous ? 10 : 30;
    if (await overAttemptCap(userId, 'diy_refresh', null, null, refreshCap)) {
      return NextResponse.json(
        {
          success: false,
          error: user.isAnonymous
            ? 'Daily idea refresh limit reached (10 for guest accounts). Sign in with Google for 30 a day.'
            : 'Daily idea refresh limit reached (30). Try again tomorrow.',
        },
        { status: 429 },
      );
    }
    await logAttempt(userId, 'diy_refresh');

    const { ideas } = await runDIYAgent(packagingType, scan.materials || []);

    // Best-effort store: the column may not exist yet (one-time SQL
    // pending), in which case this is a no-op and the next open
    // regenerates again. A failed store never fails the request.
    try {
      await serverDb
        .from('scans')
        .update({ diy_ideas: ideas })
        .eq('id', scanId);
    } catch {
      // Column missing — ideas still return fine below.
    }

    return NextResponse.json({
      success: true,
      scan,
      packagingType,
      diyIdeas: ideas,
      fromStored: false,
    });
  } catch (error) {
    return handleRouteError(error, 'DIY ideas API error:');
  }
}

export const maxDuration = 60;
