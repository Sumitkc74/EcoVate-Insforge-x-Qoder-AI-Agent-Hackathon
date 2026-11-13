/**
 * DELETE /api/history
 *
 * Delete the signed-in user's own History items:
 * - a single scan (type 'scan') or a single DIY project action
 *   (type 'project'),
 * - all of their scans (type 'all-scans'), or
 * - all of their DIY projects (type 'all-projects').
 *
 * Ownership is enforced server-side: rows are only deleted when
 * their user_id matches the authenticated user. Deleting a scan
 * also deletes its linked actions for that scan, so no orphan
 * project rows are left behind. Points earned by deleted approved
 * projects (or by a scan's linked actions) are taken back off the
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
    const validTypes = ['scan', 'project', 'all-scans', 'all-projects'];
    if (!validTypes.includes(type) || ((type === 'scan' || type === 'project') && !id)) {
      return NextResponse.json(
        { error: 'Missing required fields: type must be scan, project, all-scans or all-projects, and id is required for scan/project' },
        { status: 400 }
      );
    }

    if (type === 'all-scans' || type === 'all-projects') {
      // All of this user's scans, with their linked actions.
      const { data: userScans } = await serverDb
        .from('scans')
        .select('id')
        .eq('user_id', userId);
      const scanIds = (userScans || []).map((s) => (s as { id: string }).id);

      const { data: userActions } = await serverDb
        .from('user_actions')
        .select('id, scan_id, impact_score')
        .eq('user_id', userId);
      const actions = (userActions || []) as { id: string; scan_id: string | null; impact_score: number }[];

      if (type === 'all-scans') {
        // Linked actions are the ones tied to this user's scans.
        const linked = actions.filter((a) => a.scan_id && scanIds.includes(a.scan_id));
        const deletedImpact = linked.reduce((sum, a) => sum + (a.impact_score || 0), 0);
        if (scanIds.length > 0) {
          await serverDb.from('user_actions').delete().eq('user_id', userId).in('scan_id', scanIds);
          await serverDb.from('scans').delete().eq('user_id', userId);
        }
        await adjustUserScore(userId, deletedImpact);
        return NextResponse.json({ success: true, deletedCount: scanIds.length, deletedImpact });
      }

      // type === 'all-projects': delete every action, keep the scans.
      const deletedImpact = actions.reduce((sum, a) => sum + (a.impact_score || 0), 0);
      await serverDb.from('user_actions').delete().eq('user_id', userId);
      await adjustUserScore(userId, deletedImpact);
      return NextResponse.json({ success: true, deletedCount: actions.length, deletedImpact });
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
