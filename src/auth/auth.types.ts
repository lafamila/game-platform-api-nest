import { JWTPayload } from 'jose';

export const SERVICE_CLAIM = 'https://lafamila.xyz/claims/service';

export interface AuthAccount {
  accountId: string;
  subject: string;
  loginId?: string;
  name?: string;
  email?: string;
  serviceKey: string;
  permission: string;
  claims: Record<string, unknown>;
}

export interface GamePlatformSession {
  id: string;
  account: AuthAccount;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface LoginTransaction {
  id: string;
  state: string;
  verifier: string;
  codeChallenge: string;
  returnUri?: string;
  expiresAt: number;
  status: 'pending' | 'completed' | 'failed' | 'consumed';
  sessionId?: string;
  errorCode?: string;
  error?: string;
}

export interface RequestWithAuth {
  authAccount: AuthAccount;
  gameSession?: GamePlatformSession;
}

export type ServicePermissionCandidate = string | string[] | Record<string, unknown>;

export function accountFromPayload(payload: JWTPayload, serviceKey: string, deniedPermissions: string[]): AuthAccount {
  const claims = payload as Record<string, unknown>;
  const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
  const accountId = stringClaim(claims, 'accountId') ?? stringClaim(claims, 'account_id') ?? subject;
  if (!subject || !accountId) {
    throw new Error('Token is missing account subject');
  }

  const permission = extractPermission(claims, serviceKey);
  if (!permission || deniedPermissions.map((entry) => entry.toLowerCase()).includes(permission.toLowerCase())) {
    throw new Error('game-platform service permission is required');
  }

  return {
    accountId,
    subject,
    loginId: stringClaim(claims, 'preferred_username') ?? stringClaim(claims, 'loginId') ?? stringClaim(claims, 'login_id'),
    name: stringClaim(claims, 'name'),
    email: stringClaim(claims, 'email'),
    serviceKey,
    permission,
    claims,
  };
}

function extractPermission(claims: Record<string, unknown>, serviceKey: string): string | undefined {
  const namespaced = claims[SERVICE_CLAIM];
  const namespacedPermission = permissionFromCandidate(namespaced as ServicePermissionCandidate | undefined, serviceKey);
  if (namespacedPermission) {
    return namespacedPermission;
  }

  const direct = claims[serviceKey];
  const directPermission = permissionFromCandidate(direct as ServicePermissionCandidate | undefined, serviceKey);
  if (directPermission) {
    return directPermission;
  }

  const services = claims.services;
  if (services && typeof services === 'object' && !Array.isArray(services)) {
    const candidate = (services as Record<string, ServicePermissionCandidate>)[serviceKey];
    const permission = permissionFromCandidate(candidate, serviceKey);
    if (permission) {
      return permission;
    }
  }

  const servicePermissions = claims.servicePermissions ?? claims.service_permissions ?? claims.permissions;
  if (Array.isArray(servicePermissions)) {
    for (const entry of servicePermissions) {
      if (typeof entry === 'string') {
        const [candidateService, permission] = entry.split(':');
        if (candidateService === serviceKey && permission) {
          return permission;
        }
        continue;
      }
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const candidateService = record.serviceKey ?? record.service_key ?? record.service ?? record.key;
        const permission = record.permission ?? record.role ?? record.access;
        if (candidateService === serviceKey && typeof permission === 'string') {
          return permission;
        }
      }
    }
  }

  return undefined;
}

function permissionFromCandidate(candidate: ServicePermissionCandidate | undefined, serviceKey: string): string | undefined {
  if (typeof candidate === 'string') {
    return candidate;
  }
  if (Array.isArray(candidate)) {
    return candidate.find((entry) => typeof entry === 'string');
  }
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    const key = record.key ?? record.serviceKey ?? record.service_key;
    if (key && key !== serviceKey) {
      return undefined;
    }
    for (const field of ['permission', 'role', 'access', 'permissionKey', 'permission_key']) {
      const value = record[field];
      if (typeof value === 'string') {
        return value;
      }
    }
    const permissions = record.permissions;
    if (Array.isArray(permissions)) {
      return permissions.find((entry): entry is string => typeof entry === 'string');
    }
  }
  return undefined;
}

function stringClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
