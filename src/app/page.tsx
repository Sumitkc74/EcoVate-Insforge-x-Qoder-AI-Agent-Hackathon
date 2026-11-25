/**
 * Home Page
 * 
 * Redirects to login or dashboard based on auth status.
 */

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/supabase';

export default function HomePage() {
  const router = useRouter();

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
      // User is logged in, redirect to dashboard
      router.push('/dashboard');
    } catch (e) {
      router.push('/login');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-emerald-100">
      <div className="animate-spin w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full"></div>
    </div>
  );
}
