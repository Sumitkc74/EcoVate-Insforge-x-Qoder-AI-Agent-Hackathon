/**
 * Dashboard Page
 * 
 * Main hub with two options: Scan Products and View History
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/insforge';
import { signOut } from '@/lib/auth';

interface UserData {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  sustainability_score: number;
}

interface LeaderboardEntry {
  rank: number;
  id: string;
  name: string | null;
  avatar: string | null;
  sustainability_score: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[] | null>(null);
  const [leaderboardError, setLeaderboardError] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const { data: userData, error } = await auth.getCurrentUser();
      if (error || !userData?.user) {
        router.push('/login');
        return;
      }
      setUser({
        id: userData.user.id,
        email: userData.user.email,
        name: userData.user.profile?.name || null,
        avatar: userData.user.profile?.avatar_url || null,
        sustainability_score: 0,
      });
      
      // Fetch user score from database
      try {
        const response = await fetch('/api/dashboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: userData.user.id }),
        });
        const data = await response.json();
        if (data.profile) {
          setUser(prev => prev ? { ...prev, sustainability_score: data.profile.sustainability_score || 0 } : null);
        }
      } catch (e) {
        console.error('Failed to fetch dashboard data:', e);
      }

      // Leaderboard is a bonus section: never block or break the page if it fails.
      try {
        const leaderboardResponse = await fetch('/api/leaderboard');
        const leaderboardData = await leaderboardResponse.json();
        if (leaderboardResponse.ok && leaderboardData.success && Array.isArray(leaderboardData.leaderboard)) {
          setLeaderboard(leaderboardData.leaderboard.slice(0, 10));
        } else {
          setLeaderboardError(true);
        }
      } catch (e) {
        console.error('Failed to fetch leaderboard:', e);
        setLeaderboardError(true);
      }
    } catch (e) {
      router.push('/login');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-emerald-100">
        <div className="animate-spin w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            {user?.avatar ? (
              <img src={user.avatar} alt={user.name || ''} className="w-10 h-10 rounded-full" />
            ) : (
              <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center">
                <span className="text-white font-bold">{(user?.name || user?.email || 'U')[0].toUpperCase()}</span>
              </div>
            )}
            <div>
              <h1 className="font-bold text-gray-900">{user?.name || 'Welcome'}</h1>
              <p className="text-xs text-gray-500">{user?.email}</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto px-4 py-6 space-y-6">
        {/* Score Card */}
        <div className="bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-lg p-6 text-white text-center">
          <p className="text-green-100 text-sm mb-1">Your Sustainability Score</p>
          <p className="text-5xl font-bold">{user?.sustainability_score || 0}</p>
          <p className="text-green-100 text-sm mt-2">points earned</p>
        </div>

        {/* Main Menu */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-700">What would you like to do?</h2>
          
          {/* Scan Products Option */}
          <button
            onClick={() => router.push('/scan')}
            className="w-full bg-white rounded-2xl shadow-lg p-6 text-left hover:shadow-xl transition-all duration-200 border-2 border-transparent hover:border-green-500"
          >
            <div className="flex items-center space-x-4">
              <div className="w-14 h-14 bg-gradient-to-br from-green-500 to-emerald-600 rounded-2xl flex items-center justify-center">
                <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-gray-900 text-lg">Scan Products</h3>
                <p className="text-gray-500 text-sm">Scan product packaging to get upcycling ideas</p>
              </div>
              <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>

          {/* View History Option */}
          <button
            onClick={() => router.push('/history')}
            className="w-full bg-white rounded-2xl shadow-lg p-6 text-left hover:shadow-xl transition-all duration-200 border-2 border-transparent hover:border-blue-500"
          >
            <div className="flex items-center space-x-4">
              <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center">
                <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-gray-900 text-lg">View History</h3>
                <p className="text-gray-500 text-sm">See all your scanned products and DIY projects</p>
              </div>
              <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>
        </div>

        {/* Leaderboard */}
        <div className="bg-white rounded-2xl shadow-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Leaderboard</h2>
          {leaderboardError ? (
            <p className="text-sm text-gray-500">Leaderboard unavailable right now.</p>
          ) : leaderboard === null ? (
            <p className="text-sm text-gray-500">Loading leaderboard…</p>
          ) : leaderboard.length === 0 ? (
            <p className="text-sm text-gray-500">No scores yet — complete a DIY project to be first.</p>
          ) : (
            <ol className="space-y-3">
              {leaderboard.map((entry) => {
                const isCurrentUser = user !== null && entry.id === user.id;
                return (
                  <li
                    key={entry.id}
                    className={`flex items-center space-x-3 rounded-xl px-3 py-2 ${
                      isCurrentUser ? 'bg-green-50 ring-1 ring-green-500' : ''
                    }`}
                  >
                    <span
                      className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm font-bold ${
                        entry.rank === 1
                          ? 'bg-amber-100 text-amber-700'
                          : entry.rank === 2
                          ? 'bg-gray-100 text-gray-700'
                          : entry.rank === 3
                          ? 'bg-orange-100 text-orange-700'
                          : 'bg-gray-50 text-gray-500'
                      }`}
                    >
                      {entry.rank}
                    </span>
                    {entry.avatar ? (
                      <img src={entry.avatar} alt={entry.name || ''} className="w-8 h-8 rounded-full" />
                    ) : (
                      <div className="w-8 h-8 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center">
                        <span className="text-white text-sm font-bold">
                          {(entry.name || 'E')[0].toUpperCase()}
                        </span>
                      </div>
                    )}
                    <span className="flex-1 font-medium text-gray-900 truncate">
                      {entry.name || 'EcoVate user'}
                      {isCurrentUser && (
                        <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">You</span>
                      )}
                    </span>
                    <span className="text-sm font-bold text-green-600">{entry.sustainability_score} pts</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/* App Info */}
        <div className="text-center pt-4">
          <p className="text-gray-500 text-sm">
            ♻️ Ecovate - Turn waste into wonder
          </p>
        </div>
      </main>
    </div>
  );
}
