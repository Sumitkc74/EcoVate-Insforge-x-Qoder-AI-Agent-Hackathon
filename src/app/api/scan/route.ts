/**
 * POST /api/scan
 * 
 * Coordinator Agent endpoint that orchestrates Vision → Research → DIY agents.
 * Accepts an image file, runs the multi-agent pipeline, and returns results.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runCoordinatorAgent } from '@/lib/agents';
import { serverDb, auth } from '@/lib/insforge';
import { uploadImage } from '@/lib/storage';

export async function POST(request: NextRequest) {
  try {
    // Parse JSON body first to get userId
    const body = await request.json();
    const base64Image = body.image as string;
    const bodyUserId = body.userId as string;
    
    // Verify authentication - accept userId from body (sent from authenticated frontend)
    let userId: string | null = bodyUserId || null;
    
    // Also try to verify with cookie as backup
    if (!userId) {
      const { data: userData } = await auth.getCurrentUser();
      if (userData?.user) {
        userId = userData.user.id;
      }
    }
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!base64Image) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

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
    };

    // Run Coordinator Agent (Vision → Research → DIY, or manual → Research → DIY)
    console.log('Starting Coordinator Agent...');
    const coordinatorResult = await runCoordinatorAgent(base64Image, manual);

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

    // Convert base64 to file for storage upload
    let imageUrl: string | null = null;
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
      if (!uploadError) {
        imageUrl = url;
      }
    } catch (uploadErr) {
      console.error('Image upload error:', uploadErr);
      // Continue without image URL - non-critical error
    }

    // Ensure the public.users row exists first: scans.user_id is a
    // foreign key to public.users(id), and new sign-ins never get a row
    // there (the callback's client-side profile insert is blocked by
    // RLS, which has no INSERT policy for users). Without this row the
    // scan insert fails on the foreign key and history stays empty,
    // even with the server-side client that bypasses RLS.
    try {
      const userEmail = typeof body.userEmail === 'string' && body.userEmail
        ? body.userEmail
        : `${userId}@ecovate.local`;
      const { error: profileError } = await serverDb
        .from('users')
        .upsert([{
          id: userId,
          email: userEmail,
          name: typeof body.userName === 'string' && body.userName
            ? body.userName
            : userEmail.split('@')[0],
          avatar: typeof body.userAvatar === 'string' ? body.userAvatar : null,
          sustainability_score: 0,
        }], { onConflict: 'id' });
      if (profileError) {
        console.error('Profile upsert error:', profileError);
      }
    } catch (profileErr) {
      console.error('Profile upsert exception:', profileErr);
    }

    // Save scan to database
    const scanData = {
      user_id: userId,
      product_name: coordinatorResult.data!.product_name,
      materials: coordinatorResult.data!.detected_materials,
      carbon_footprint: coordinatorResult.data!.carbon_footprint_kg || 0,
      recyclability_score: coordinatorResult.data!.recyclability_score || 0,
      image_url: imageUrl,
    };

    let scanId: string | null = null;
    
    try {
      const { data: scanRecord, error: dbError } = await serverDb
        .from('scans')
        .insert([scanData])
        .select()
        .single();

      if (dbError) {
        console.error('Database error:', dbError);
      } else if (scanRecord) {
        scanId = scanRecord.id;
      }
    } catch (dbErr) {
      console.error('Database insert error:', dbErr);
    }

    // Log user action
    try {
      await serverDb.from('user_actions').insert([{
        user_id: userId,
        scan_id: scanId,
        action_type: 'scanned',
        impact_score: 0,
        image_url: imageUrl,
      }]);
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
    });

  } catch (error) {
    console.error('Scan API error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message,
    }, { status: 500 });
  }
}

// Configure for longer timeout (Node.js runtime allows up to 60s on Hobby, 300s on Pro)
export const maxDuration = 60; // 60 seconds max for AI processing
