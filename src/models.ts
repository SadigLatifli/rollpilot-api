export type PhotoKey = 'cat1' | 'cat2' | 'cat3' | 'italy1' | 'italy2' | 'cafe' | 'dress' | 'shoes' | 'bag' | 'jacket' | 'receipt' | 'food' | 'qr' | 'black1' | 'black2' | 'black3' | 'black4' | 'black5' | 'black6';

export const PHOTO_KEYS: PhotoKey[] = ['cat1', 'cat2', 'cat3', 'italy1', 'italy2', 'cafe', 'dress', 'shoes', 'bag', 'jacket', 'receipt', 'food', 'qr', 'black1', 'black2', 'black3', 'black4', 'black5', 'black6'];

export type Collection = {
  id: string;
  title: string;
  count: number;
  unit: string;
  photos: PhotoKey[];
  tint: string;
  icon: string;
  auto: boolean;
  assetIds?: string[];
  coverAssetId?: string;
};

export type PlanGroup = { id: string; title: string; count: number; photo: PhotoKey; tint: string; assetIds?: string[]; coverAssetId?: string };
export type AgentPlan = {
  id: string;
  kind: 'organize' | 'cleanup' | 'find';
  command: string;
  headline: string;
  detail: string;
  scanned: string;
  groups: PlanGroup[];
  potentialSpace?: string;
};

export type Activity = { id: string; title: string; detail: string; occurredAt: string; icon: string };
export type Session = { onboarded: boolean; collections: Collection[]; activities: Activity[]; currentPlan: AgentPlan | null };
export type Database = { version: 1; sessions: Record<string, Session> };
