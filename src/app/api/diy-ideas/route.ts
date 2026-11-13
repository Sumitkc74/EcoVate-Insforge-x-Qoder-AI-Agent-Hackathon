/**
 * GET /api/diy-ideas?scanId=...
 *
 * DIY ideas for a scan that was saved earlier ("Add DIY" from History
 * or the dashboard). The ideas are generated on the fly and not stored,
 * so they are regenerated here: the packaging type is read from the
 * 'scanned' action the scan route stored it on, then the DIY agent
 * runs on the stored materials. Only scans made before that was
 * stored fall back to reading the stored photo with the free vision
 * path; without a photo, the packaging type falls back to "container"
 * and the DIY agent's built-in ideas are used. Only the scan's owner
 * can use it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import { runVisionAgent } from '@/lib/agents/vision-agent';
import { runDIYAgent } from '@/lib/agents/diy-agent';
import {
  assertServiceKey,
  requireUser,
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
          if (result?.packaging_type) packagingType = result.packaging_type;
        }
      } catch (e) {
        console.error('DIY ideas: could not read stored photo, using container:', e);
      }
    }

    const { ideas } = await runDIYAgent(packagingType, scan.materials || []);

    return NextResponse.json({
      success: true,
      scan,
      packagingType,
      diyIdeas: ideas,
    });
  } catch (error) {
    return handleRouteError(error, 'DIY ideas API error:');
  }
}

export const maxDuration = 60;
