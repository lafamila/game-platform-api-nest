import { AuthAccount } from './auth.types';

const PLAYER_PERMISSIONS = new Set(['player', 'premium', 'superadmin']);
const PREMIUM_PERMISSIONS = new Set(['premium', 'superadmin']);

export function hasPlayerAccess(user: AuthAccount): boolean {
  return PLAYER_PERMISSIONS.has(user.permission.toLowerCase());
}

export function hasPremiumAccess(user: AuthAccount): boolean {
  return PREMIUM_PERMISSIONS.has(user.permission.toLowerCase());
}

// 원칙 4: superadmin 은 auth 계정의 is_super_admin 권위에서 온 최상위 서비스 권한.
// 리플레이(열람/뷰/API)는 superadmin 전용 (D1).
export function hasSuperadminAccess(user: AuthAccount): boolean {
  return user.permission.toLowerCase() === 'superadmin';
}

export function emoteGridSizeFor(user: AuthAccount): 8 | 16 {
  return hasPremiumAccess(user) ? 16 : 8;
}
