/**
 * GET /api/history?limit=20&scanOffset=0&actionOffset=0
 *
 * The signed-in user's History, paged: the History page used to
 * read through /api/dashboard, which only returns the 10 most
 * recent scans and 20 most recent actions, so older items were
 * unreachable. Scans and actions page independently (the page
 * loads more of whichever list is being viewed). Totals and the
 * project counts are exact — they come from the full actions list
 * the score sum already needs — so the tab labels stay truthful
 * while only one page of rows is in hand.
 *
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
 * project rows are left behind. Scores are derived from the
 * actions themselves, so deleting an action takes its points off
 * every display automatically — nothing writes the stale
 * users.sustainability_score column anymore.
 */

import { NextRequest, NextResponse } from 'next/server';
import { serverDb } from '@/lib/insforge';
import {
  assertServiceKey,
  requireUser,
  unauthorizedResponse,
  handleRouteError,
} from '@/lib/server-auth';

// The tab counts the page shows, computed from the full actions
// list with the same rules as the page's own getScanDiyState: a
// scan is completed if any diy_completed exists, else pending if
// any diy_pending, else selected if a diy_selected exists. (Failed
// and completed are counted per action row, as the page does.)
function projectCounts(actions: { scan_id: string | null; action_type: string }[]) {
  const byScan = new Map<string, Set<string>>();
  for (const a of actions) {
    if (!a.scan_id) continue;
    const set = byScan.get(a.scan_id) || new Set<string>();
    set.add(a.action_type);
    byScan.set(a.scan_id, set);
  }
  const stateOf = (scanId: string | null) => {
    if (!scanId) return 'none';
    const types = byScan.get(scanId) || new Set<string>();
    if (types.has('diy_completed')) return 'completed';
    if (types.has('diy_pending')) return 'pending';
    if (types.has('diy_selected')) return 'selected';
    return 'none';
  };
  const selected = actions.filter(
    (a) => a.action_type === 'diy_selected' && stateOf(a.scan_id) === 'selected',
  ).length;
  const pending = actions.filter(
    (a) => a.action_type === 'diy_pending' && stateOf(a.scan_id) === 'pending',
  ).length;
  const failed = actions.filter((a) => a.action_type === 'diy_failed').length;
  const completed = actions.filter((a) => a.action_type === 'diy_completed').length;
  return { selected, pending, failed, completed };
}

export async function GET(request: NextRequest) {
  try {
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const userId = user.id;

    const params = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(parseInt(params.get('limit') || '20', 10) || 20, 1), 50);
    const scanOffset = Math.max(parseInt(params.get('scanOffset') || '0', 10) || 0, 0);
    const actionOffset = Math.max(parseInt(params.get('actionOffset') || '0', 10) || 0, 0);

    // The two pages and the score sum are independent, so they run
    // together. The full actions list is needed for the derived
    // score and the exact tab counts (same as the dashboard's sum).
    const [scansRes, actionsRes, scoreRes] = await Promise.all([
      serverDb
        .from('scans')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(scanOffset, scanOffset + limit - 1),
      serverDb
        .from('user_actions')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(actionOffset, actionOffset + limit - 1),
      serverDb
        .from('user_actions')
        .select('scan_id, action_type, impact_score')
        .eq('user_id', userId),
    ]);
    if (scansRes.error) throw scansRes.error;
    if (actionsRes.error) throw actionsRes.error;

    const allActions = (scoreRes.data || []) as {
      scan_id: string | null;
      action_type: string;
      impact_score: number;
    }[];
    const counts = projectCounts(allActions);
    const totalScans = typeof scansRes.count === 'number' ? scansRes.count : (scansRes.data || []).length;
    const totalActions = typeof actionsRes.count === 'number' ? actionsRes.count : (actionsRes.data || []).length;

    return NextResponse.json({
      success: true,
      scans: scansRes.data || [],
      actions: actionsRes.data || [],
      totalScans,
      totalActions,
      totalProjects: counts.selected + counts.failed + counts.completed,
      totalPending: counts.pending,
      totalImpact: allActions.reduce((sum, a) => sum + (a.impact_score || 0), 0),
      hasMoreScans: scanOffset + limit < totalScans,
      hasMoreActions: actionOffset + limit < totalActions,
    });
  } catch (error) {
    return handleRouteError(error, 'History API error:');
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // The user id comes from the validated session token, never the
    // body: the ownership checks below only mean something when the
    // id itself is authenticated.
    assertServiceKey();
    const user = await requireUser(request);
    if (!user) return unauthorizedResponse();
    const userId = user.id;

    const body = await request.json().catch(() => ({}));
    const type = body.type as string;
    const id = body.id as string;
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
        return NextResponse.json({ success: true, deletedCount: scanIds.length, deletedImpact });
      }

      // type === 'all-projects': delete every action, keep the scans.
      const deletedImpact = actions.reduce((sum, a) => sum + (a.impact_score || 0), 0);
      await serverDb.from('user_actions').delete().eq('user_id', userId);
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

    return NextResponse.json({ success: true, deletedImpact });
  } catch (error) {
    return handleRouteError(error, 'History delete API error:');
  }
}

export const runtime = 'edge';
