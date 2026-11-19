import crypto from 'node:crypto';
import type http from 'node:http';

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

export interface MultiUserEntry {
  id: string;
  role: UserRole;
  token?: string;
  tokenHash?: string;
}

export interface GatewayAuthConfig {
  mode?: 'local' | 'multiuser';
  jwtSecret?: string;
  users?: MultiUserEntry[];
  tenantIdleTtlMs?: number;
}

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3
};

export function hasRole(actual: UserRole, required: UserRole): boolean {
  return (ROLE_RANK[actual] || 0) >= (ROLE_RANK[required] || 0);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signJwtHs256(
  payload: { sub: string; role: UserRole; exp?: number },
  secret: string
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

export function verifyJwtHs256(token: string, secret: string): AuthenticatedUser | null {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, bodyB64, sigB64] = parts;
  const signingInput = `${headerB64}.${bodyB64}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  if (!timingSafeEqualStr(sigB64, expectedSig)) return null;

  try {
    const header = JSON.parse(base64UrlDecode(headerB64));
    if (header?.alg !== 'HS256') return null;
    const payload = JSON.parse(base64UrlDecode(bodyB64));
    if (typeof payload?.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) {
      return null;
    }
    const id = String(payload?.sub || payload?.id || '').trim();
    const role: UserRole =
      payload?.role === 'admin' || payload?.role === 'operator' || payload?.role === 'viewer'
        ? payload.role
        : 'viewer';
    if (!id) return null;
    return { id, role };
  } catch {
    return null;
  }
}

export function extractBearerToken(req: http.IncomingMessage, url: URL): string {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return String(url.searchParams.get('token') || '').trim();
}

export function authenticateRequest(
  req: http.IncomingMessage,
  url: URL,
  authConfig: GatewayAuthConfig = {},
  localAuthToken = ''
): AuthenticatedUser | null {
  const provided = extractBearerToken(req, url);
  if (!provided) return null;

  const mode = authConfig.mode || 'local';
  if (mode !== 'multiuser') {
    return timingSafeEqualStr(provided, localAuthToken) ? { id: 'local', role: 'admin' } : null;
  }

  // 1. Check configured static user tokens / tokenHashes
  const users = Array.isArray(authConfig.users) ? authConfig.users : [];
  const providedHash = hashToken(provided);
  for (const u of users) {
    if (!u?.id) continue;
    const role: UserRole =
      u.role === 'admin' || u.role === 'operator' || u.role === 'viewer' ? u.role : 'viewer';
    if (u.token && timingSafeEqualStr(provided, u.token)) {
      return { id: String(u.id), role };
    }
    if (u.tokenHash && timingSafeEqualStr(providedHash, u.tokenHash.toLowerCase())) {
      return { id: String(u.id), role };
    }
  }

  // 2. Check HS256 JWT if jwtSecret is configured
  const secret = authConfig.jwtSecret || process.env.OM_JWT_SECRET || '';
  if (secret) {
    const jwtUser = verifyJwtHs256(provided, secret);
    if (jwtUser) return jwtUser;
  }

  return null;
}

/**
 * Determine the minimum RBAC role required for an API endpoint.
 */
export function getRequiredRole(pathname: string, method = 'GET'): UserRole {
  const m = method.toUpperCase();

  // Admin-only routes: config, system prompt, skill creation, daemon, training, destructive resets
  if (
    pathname.startsWith('/api/config') ||
    pathname === '/api/system-prompt' ||
    pathname === '/api/skills/create' ||
    pathname.startsWith('/api/daemon') ||
    pathname.startsWith('/api/training') ||
    pathname.startsWith('/api/snapshots') ||
    pathname === '/api/clear' ||
    pathname === '/api/sessions/reset-counter' ||
    pathname === '/api/models/load' ||
    pathname === '/api/models/unload'
  ) {
    return 'admin';
  }

  if (m === 'DELETE') {
    return 'admin';
  }

  // Operator routes: running chats, agents, memory mutations, approvals
  if (m === 'POST' || m === 'PATCH' || m === 'PUT') {
    return 'operator';
  }

  // Viewer routes: read-only GET endpoints
  return 'viewer';
}
