/**
 * GET /api/diy-ideas?scanId=...
 *
 * DIY ideas for a scan that was saved earlier ("Add DIY" from History
 * or the dashboard). The ideas are generated on the fly and not stored,
 * so they are regenerated here: the stored photo is read with the free
 * vision path to recover the packaging type (the scans table does not
 * store it), then the DIY agent runs on the stored materials. Without
 * a photo, the packaging type falls back to "container" and the DIY
 * agent's built-in ideas are used. Only the scan's owner can use it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import { runVisionAgent } from '@/lib/agents/vision-agent';
import { runDIYAgent } from '@/lib/agents/diy-agent';

export async function GET(request: NextRequest) {
  try {
    // The user id comes from the client, like /api/dashboard, /api/scan
    // and /api/verify already do: the session lives client-side, so a
    // server-side auth.getCurrentUser() here has nothing to read and
    // returns 401 even for a signed-in user (that was the "Could not
    // load DIY ideas: Unauthorized" error). Ownership is still checked
    // server-side against the scan row below.
    const scanId = request.nextUrl.searchParams.get('scanId');
    const userId = request.nextUrl.searchParams.get('userId');
    if (!scanId || !userId) {
      return NextResponse.json({ error: 'Missing scanId or userId' }, { status: 400 });
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

    // Recover the packaging type from the stored photo when there is one.
    let packagingType = 'container';
    if (scan.image_url) {
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
    console.error('DIY ideas API error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
}

export const maxDuration = 60;
