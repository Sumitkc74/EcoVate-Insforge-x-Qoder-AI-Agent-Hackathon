/**
 * History Page
 * 
 * View all scanned products and DIY projects (pending and approved).
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/insforge';
import { getScanDiyState, buildVerifyUrl, openAddDiy } from '@/lib/diy-continue';

interface Scan {
  id: string;
  product_name: string;
  materials: string[];
  carbon_footprint: number | null;
  recyclability_score: number | null;
  image_url: string | null;
  created_at: string;
}

interface UserAction {
  id: string;
  scan_id: string | null;
  action_type: string;
  impact_score: number;
  image_url: string | null;
  created_at: string;
  // Saved by /api/verify; null on older rows (predates the columns).
  feedback?: string | null;
  project_title?: string | null;
  // Saved by /api/actions when an idea is chosen; null on older rows
  // and until the one-time SQL adding these columns is run.
  packaging_type?: string | null;
  estimated_co2_saved?: number | null;
}

interface HistoryData {
  scans: Scan[];
  actions: UserAction[];
  totalImpact: number;
}

export default function HistoryPage() {
  const router = useRouter();
  const [data, setData] = useState<HistoryData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'scans' | 'projects'>('projects');
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'scan' | 'project'; id: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState<'scans' | 'projects' | null>(null);
  const [deletingAll, setDeletingAll] = useState<'scans' | 'projects' | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addDiyId, setAddDiyId] = useState<string | null>(null);
  const [diyError, setDiyError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string>('');

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      const { data: userData, error } = await auth.getCurrentUser();
      if (error || !userData?.user) {
        router.push('/login');
        return;
      }
      setUserId(userData.user.id);

      const response = await fetch('/api/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userData.user.id }),
      });
      
      const result = await response.json();
      console.log('Dashboard data:', result);
      setData({
        scans: result.recentScans || [],
        actions: result.recentActions || [],
        totalImpact: result.stats?.totalImpact || 0,
      });
    } catch (e) {
      console.error('Failed to fetch history:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (type: 'scan' | 'project', id: string) => {
    try {
      const { data: userData, error } = await auth.getCurrentUser();
      if (error || !userData?.user) {
        router.push('/login');
        return;
      }
      setDeletingId(id);
      setDeleteError(null);
      const response = await fetch('/api/history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id, userId: userData.user.id }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Delete failed');
      }
      setConfirmDelete(null);
      await fetchHistory();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddDiy = async (scan: Scan) => {
    setAddDiyId(scan.id);
    setDiyError(null);
    try {
      await openAddDiy(router, scan, userId);
    } catch (e) {
      setDiyError((e as Error).message);
    } finally {
      setAddDiyId(null);
    }
  };

  const handleDeleteAll = async (scope: 'scans' | 'projects') => {
    try {
      const { data: userData, error } = await auth.getCurrentUser();
      if (error || !userData?.user) {
        router.push('/login');
        return;
      }
      setDeletingAll(scope);
      setDeleteError(null);
      const response = await fetch('/api/history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: scope === 'scans' ? 'all-scans' : 'all-projects',
          userId: userData.user.id,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Delete failed');
      }
      setConfirmDeleteAll(null);
      await fetchHistory();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeletingAll(null);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-emerald-100">
        <div className="animate-spin w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  // Separate projects by status
  const pendingProjects = data?.actions.filter(a => a.action_type === 'diy_pending') || [];
  const failedProjects = data?.actions.filter(a => a.action_type === 'diy_failed') || [];
  const completedProjects = data?.actions.filter(a => a.action_type === 'diy_completed') || [];
  const allProjects = [...pendingProjects, ...failedProjects, ...completedProjects].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 pb-6">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center">
            <button
              onClick={() => router.push('/dashboard')}
              className="flex items-center text-gray-600 hover:text-gray-900"
            >
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
            <h1 className="ml-4 font-bold text-gray-900 text-lg">My History</h1>
          </div>
          <button
            onClick={fetchHistory}
            className="p-2 text-gray-500 hover:text-green-600"
            title="Refresh"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="max-w-md mx-auto px-4 py-4">
        <div className="flex bg-white rounded-xl p-1 shadow">
          <button
            onClick={() => setActiveTab('projects')}
            className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
              activeTab === 'projects'
                ? 'bg-green-500 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Projects ({allProjects.length})
          </button>
          <button
            onClick={() => setActiveTab('scans')}
            className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
              activeTab === 'scans'
                ? 'bg-green-500 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Scans ({data?.scans.length || 0})
          </button>
        </div>
      </div>

      {/* Status Legend */}
      {activeTab === 'projects' && allProjects.length > 0 && (
        <div className="max-w-md mx-auto px-4 mb-4">
          <div className="flex items-center space-x-4 text-sm">
            <div className="flex items-center">
              <span className="w-3 h-3 bg-amber-400 rounded-full mr-2"></span>
              <span className="text-gray-600">Pending ({pendingProjects.length})</span>
            </div>
            <div className="flex items-center">
              <span className="w-3 h-3 bg-red-500 rounded-full mr-2"></span>
              <span className="text-gray-600">Failed ({failedProjects.length})</span>
            </div>
            <div className="flex items-center">
              <span className="w-3 h-3 bg-green-500 rounded-full mr-2"></span>
              <span className="text-gray-600">Approved ({completedProjects.length})</span>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="max-w-md mx-auto px-4">
        {/* Summary */}
        <div className="mb-6 bg-gradient-to-r from-green-500 to-emerald-600 rounded-xl p-4 text-white">
          <div className="flex items-center justify-between">
            <span>Total Impact Score</span>
            <span className="text-2xl font-bold">{data?.totalImpact || 0}</span>
          </div>
          <p className="text-green-100 text-sm mt-1">From {completedProjects.length} approved projects</p>
        </div>
        {deleteError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-600">Could not delete: {deleteError}</p>
          </div>
        )}
        {diyError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-600">Could not load DIY ideas: {diyError}</p>
          </div>
        )}
        {activeTab === 'scans' && (
          <div className="space-y-3">
            {(data?.scans.length || 0) > 0 && (
              <div className="flex justify-end">
                {confirmDeleteAll === 'scans' ? (
                  <span className="flex items-center space-x-2 text-xs">
                    <span className="text-gray-600">Delete all {data?.scans.length} scans? This can&apos;t be undone.</span>
                    <button
                      onClick={() => handleDeleteAll('scans')}
                      disabled={deletingAll === 'scans'}
                      className="text-red-600 font-semibold disabled:opacity-50"
                    >
                      {deletingAll === 'scans' ? 'Deleting…' : 'Confirm delete all'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteAll(null)}
                      className="text-gray-500"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteAll('scans')}
                    className="text-xs text-red-500 hover:text-red-700"
                    title="Delete all scans"
                  >
                    Delete all
                  </button>
                )}
              </div>
            )}
            {data?.scans.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  </svg>
                </div>
                <p className="text-gray-500">No scans yet</p>
                <button
                  onClick={() => router.push('/scan')}
                  className="mt-4 text-green-600 font-medium"
                >
                  Scan your first product →
                </button>
              </div>
            ) : (
              data?.scans.map((scan) => {
                const diy = getScanDiyState(scan.id, data?.actions || []);
                return (
                <div key={scan.id} className="bg-white rounded-xl shadow-lg p-4">
                  <div className="flex items-start space-x-3">
                    {scan.image_url ? (
                      <img src={scan.image_url} alt="" className="w-16 h-16 rounded-lg object-cover" />
                    ) : (
                      <div className="w-16 h-16 bg-gray-100 rounded-lg flex items-center justify-center">
                        <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                        </svg>
                      </div>
                    )}
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <h3 className="font-semibold text-gray-900">{scan.product_name}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                          diy.status === 'completed'
                            ? 'bg-green-100 text-green-700'
                            : diy.status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : diy.status === 'pending' || diy.status === 'selected'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {diy.status === 'completed'
                            ? 'DIY Completed'
                            : diy.status === 'failed'
                            ? 'DIY Failed'
                            : diy.status === 'pending' || diy.status === 'selected'
                            ? 'DIY Incomplete'
                            : 'DIY Unselected'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 capitalize">{scan.materials?.join(', ') || 'Unknown materials'}</p>
                      <div className="flex items-center mt-2 space-x-3">
                        {scan.carbon_footprint !== null && (
                          <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
                            {scan.carbon_footprint.toFixed(2)} kg CO₂
                          </span>
                        )}
                        {scan.recyclability_score !== null && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                            {scan.recyclability_score}% recyclable
                          </span>
                        )}
                      </div>
                      {!scan.image_url && (
                        <p className="text-xs text-gray-400 mt-2">Photo wasn&apos;t saved with this scan.</p>
                      )}
                      {diy.status === 'none' && (
                        <button
                          onClick={() => handleAddDiy(scan)}
                          disabled={addDiyId === scan.id}
                          className="mt-2 text-xs font-semibold text-green-600 hover:text-green-700 disabled:opacity-50"
                        >
                          {addDiyId === scan.id ? 'Loading ideas…' : 'Add DIY'}
                        </button>
                      )}
                      {diy.status === 'selected' && diy.selectedAction && (
                        <button
                          onClick={() => router.push(buildVerifyUrl({
                            scanId: scan.id,
                            projectTitle: diy.selectedAction?.project_title || scan.product_name,
                            packagingType: diy.selectedAction?.packaging_type,
                            estimatedCo2Saved: diy.selectedAction?.estimated_co2_saved,
                          }))}
                          className="mt-2 text-xs font-semibold text-green-600 hover:text-green-700"
                        >
                          Continue to upload →
                        </button>
                      )}
                      {diy.status === 'failed' && (
                        <button
                          onClick={() => router.push(buildVerifyUrl({
                            scanId: scan.id,
                            projectTitle: diy.failedAction?.project_title || diy.selectedAction?.project_title || scan.product_name,
                            packagingType: diy.selectedAction?.packaging_type,
                            estimatedCo2Saved: diy.selectedAction?.estimated_co2_saved,
                          }))}
                          className="mt-2 text-xs font-semibold text-green-600 hover:text-green-700"
                        >
                          Try again →
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col items-end space-y-2 shrink-0">
                      <span className="text-xs text-gray-400">
                        {new Date(scan.created_at).toLocaleDateString()}
                      </span>
                      {confirmDelete?.type === 'scan' && confirmDelete.id === scan.id ? (
                        <span className="flex items-center space-x-2 text-xs">
                          <button
                            onClick={() => handleDelete('scan', scan.id)}
                            disabled={deletingId === scan.id}
                            className="text-red-600 font-semibold disabled:opacity-50"
                          >
                            {deletingId === scan.id ? 'Deleting…' : 'Confirm delete'}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="text-gray-500"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete({ type: 'scan', id: scan.id })}
                          className="text-xs text-red-500 hover:text-red-700"
                          title="Delete this scan"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === 'projects' && (
          <div className="space-y-3">
            {allProjects.length > 0 && (
              <div className="flex justify-end">
                {confirmDeleteAll === 'projects' ? (
                  <span className="flex items-center space-x-2 text-xs">
                    <span className="text-gray-600">Delete all {allProjects.length} projects? This can&apos;t be undone.</span>
                    <button
                      onClick={() => handleDeleteAll('projects')}
                      disabled={deletingAll === 'projects'}
                      className="text-red-600 font-semibold disabled:opacity-50"
                    >
                      {deletingAll === 'projects' ? 'Deleting…' : 'Confirm delete all'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteAll(null)}
                      className="text-gray-500"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteAll('projects')}
                    className="text-xs text-red-500 hover:text-red-700"
                    title="Delete all projects"
                  >
                    Delete all
                  </button>
                )}
              </div>
            )}
            {allProjects.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </div>
                <p className="text-gray-500">No projects yet</p>
                <p className="text-gray-400 text-sm mt-2">Complete a DIY project to see it here</p>
                <button
                  onClick={() => router.push('/scan')}
                  className="mt-4 text-green-600 font-medium"
                >
                  Start your first project →
                </button>
              </div>
            ) : (
              allProjects.map((action) => {
                const isPending = action.action_type === 'diy_pending';
                const isFailed = action.action_type === 'diy_failed';
                // What was uploaded: the project title saved at
                // verification time, or the scanned product it came
                // from. Older rows have neither, so they keep the
                // generic title.
                const linkedScan = action.scan_id
                  ? data?.scans.find((s) => s.id === action.scan_id)
                  : undefined;
                const projectName = action.project_title || linkedScan?.product_name || 'DIY Project';
                return (
                  <div key={action.id} className={`bg-white rounded-xl shadow-lg p-4 border-l-4 ${
                    isFailed ? 'border-red-400' : isPending ? 'border-amber-400' : 'border-green-500'
                  }`}>
                    <div className="flex items-start space-x-3">
                      {action.image_url ? (
                        <img src={action.image_url} alt="" className="w-16 h-16 rounded-lg object-cover" />
                      ) : (
                        <div className={`w-16 h-16 rounded-lg flex items-center justify-center ${
                          isFailed ? 'bg-red-100' : isPending ? 'bg-amber-100' : 'bg-green-100'
                        }`}>
                          {isFailed ? (
                            <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          ) : isPending ? (
                            <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          ) : (
                            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      )}
                      <div className="flex-1">
                        <div className="flex items-center space-x-2">
                          <h3 className="font-semibold text-gray-900">{projectName}</h3>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            isFailed
                              ? 'bg-red-100 text-red-700'
                              : isPending
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-green-100 text-green-700'
                          }`}>
                            {isFailed ? 'Failed' : isPending ? 'Pending Review' : 'Approved'}
                          </span>
                        </div>
                        <p className="text-sm text-gray-500">
                          {new Date(action.created_at).toLocaleDateString()}
                        </p>
                        {action.project_title && linkedScan && (
                          <p className="text-xs text-gray-500 mt-1">
                            From scan: {linkedScan.product_name}
                          </p>
                        )}
                        {!action.image_url && (
                          <p className="text-xs text-gray-400 mt-1">Photo wasn&apos;t saved with this project.</p>
                        )}
                        {isFailed && (
                          <p className="text-xs text-red-600 mt-1">
                            {action.feedback
                              ? `Not approved: ${action.feedback}`
                              : 'Not a completed project — no points earned'}
                          </p>
                        )}
                        {isPending && (
                          <p className="text-xs text-amber-600 mt-1">
                            {action.feedback
                              ? action.feedback
                              : 'Awaiting verification (need 85%+ confidence)'}
                          </p>
                        )}
                        {!isFailed && !isPending && action.feedback && (
                          <p className="text-xs text-gray-500 mt-1">{action.feedback}</p>
                        )}
                      </div>
                      {!isPending && !isFailed && action.impact_score > 0 && (
                        <span className="text-green-600 font-bold">+{action.impact_score} pts</span>
                      )}
                    </div>
                    <div className="flex justify-end mt-3">
                      {confirmDelete?.type === 'project' && confirmDelete.id === action.id ? (
                        <span className="flex items-center space-x-2 text-xs">
                          <button
                            onClick={() => handleDelete('project', action.id)}
                            disabled={deletingId === action.id}
                            className="text-red-600 font-semibold disabled:opacity-50"
                          >
                            {deletingId === action.id ? 'Deleting…' : 'Confirm delete'}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="text-gray-500"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete({ type: 'project', id: action.id })}
                          className="text-xs text-red-500 hover:text-red-700"
                          title="Delete this project"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </main>
    </div>
  );
}
