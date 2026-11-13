/**
 * DELETE /api/history
 *
 * Delete one of the signed-in user's own History items: a scan
 * (type 'scan') or a DIY project action (type 'project').
 *
 * Ownership is enforced server-side: the row is only deleted when
 * its user_id matches the authenticated user. Deleting a scan also
 * deletes its linked actions for that scan, so no orphan project
 * rows are left behind. Points earned by a deleted approved
 * project (or by a scan's linked actions) are taken back off the
 * user's sustainability_score.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb, auth } from '@/lib/insforge';

async function adjustUserScore(userId: string, pointsToRemove: number) {
  if (pointsToRemove <= 0) return;
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
          sustainability_score: Math.max(
            0,
            (userData.sustainability_score || 0) - pointsToRemove
          ),
        })
        .eq('id', userId);
    }
  } catch (err) {
    console.error('Failed to adjust user score after delete:', err);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const type = body.type as string;
    const id = body.id as string;
    let userId = (body.userId as string) || null;

    if (!userId) {
      const { data: userData } = await auth.getCurrentUser();
      if (userData?.user) userId = userData.user.id;
    }

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if ((type !== 'scan' && type !== 'project') || !id) {
      return NextResponse.json(
        { error: 'Missing required fields: type must be scan or project, and id is required' },
        { status: 400 }
      );
    }

    if (type === 'scan') {
      // Only delete the scan when it belongs to this user.
      const { data: scan, error: scanError } = await serverDb
        .from('scans')
        .select('id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();
      if (scanError || !scan) {
        return NextResponse.json({ error: 'Scan not found' }, { status: 404 });
      }

      // Points from this scan's linked actions (approved projects).
      const { data: linkedActions } = await serverDb
        .from('user_actions')
        .select('impact_score')
        .eq('scan_id', id)
        .eq('user_id', userId);
      const deletedImpact = (linkedActions || []).reduce(
        (sum, a) => sum + ((a as { impact_score: number }).impact_score || 0),
        0
      );

      // Delete linked actions first, then the scan itself.
      await serverDb
        .from('user_actions')
        .delete()
        .eq('scan_id', id)
        .eq('user_id', userId);
      const { error: deleteError } = await serverDb
        .from('scans')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);
      if (deleteError) throw deleteError;

      await adjustUserScore(userId, deletedImpact);
      return NextResponse.json({ success: true, deletedImpact });
    }

    // type === 'project': delete one user_actions row.
    const { data: action, error: actionError } = await serverDb
      .from('user_actions')
      .select('id, impact_score')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (actionError || !action) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const deletedImpact = (action as { impact_score: number }).impact_score || 0;
    const { error: deleteError } = await serverDb
      .from('user_actions')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (deleteError) throw deleteError;

    await adjustUserScore(userId, deletedImpact);
    return NextResponse.json({ success: true, deletedImpact });
  } catch (error) {
    console.error('History delete API error:', error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}

export const runtime = 'edge';
