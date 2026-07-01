import { AuthAccount } from './auth.types';

const PLAYER_PERMISSIONS = new Set(['player', 'premium', 'superadmin']);
const PREMIUM_PERMISSIONS = new Set(['premium', 'superadmin']);

export function hasPlayerAccess(user: AuthAccount): boolean {
  return PLAYER_PERMISSIONS.has(user.permission.toLowerCase());
}

export function hasPremiumAccess(user: AuthAccount): boolean {
  return PREMIUM_PERMISSIONS.has(user.permission.toLowerCase());
}

export function emoteGridSizeFor(user: AuthAccount): 8 | 16 {
  return hasPremiumAccess(user) ? 16 : 8;
}
