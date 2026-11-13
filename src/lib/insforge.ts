/**
 * InsForge Client Configuration
 * 
 * This file initializes the InsForge SDK client for authentication,
 * database, storage, and AI operations.
 */

import { createClient } from '@insforge/sdk';

// InsForge backend configuration
const INSFORGE_URL = process.env.NEXT_PUBLIC_INSFORGE_URL || 'https://8t37jscx.us-west.insforge.app';
const INSFORGE_ANON_KEY = process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || '';

// Create InsForge client instance
export const insforge = createClient({
  baseUrl: INSFORGE_URL,
  anonKey: INSFORGE_ANON_KEY,
});

// Export typed helpers
export const auth = insforge.auth;
export const db = insforge.database;
export const storage = insforge.storage;
export const ai = insforge.ai;

// Server-side database client with service role key (bypasses RLS)
// Only use in API routes, never expose to client
export const serverDb = createClient({
  baseUrl: INSFORGE_URL,
  anonKey: process.env.INSFORGE_SERVICE_KEY || INSFORGE_ANON_KEY,
}).database;

// Type definitions for database tables
export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  sustainability_score: number;
  created_at: string;
}

export interface Scan {
  id: string;
  user_id: string;
  product_name: string;
  materials: string[];
  carbon_footprint: number | null;
  recyclability_score: number | null;
  image_url: string | null;
  created_at: string;
}

export interface UserAction {
  id: string;
  user_id: string;
  scan_id: string | null;
  action_type: 'scanned' | 'diy_selected' | 'diy_completed' | 'diy_pending' | 'diy_failed';
  impact_score: number;
  image_url: string | null;
  created_at: string;
}

// DIY Idea type for agent responses
export interface DIYIdea {
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  materials_needed: string[];
  steps: string[];
  estimated_co2_saved_kg: number;
}

// Scan result type
export interface ScanResult {
  product_name: string;
  detected_materials: string[];
  label_text: string;
  packaging_type: string;
  carbon_footprint_kg: number;
  recyclability_score: number;
  material_breakdown: { material: string; percentage: number }[];
  diy_ideas: DIYIdea[];
}
