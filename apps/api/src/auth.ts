import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { getDb } from './db.js';
import { forbidden, unauthorized } from './errors.js';

export type Role = 'owner' | 'vet' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 11);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, name: user.fullName },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] },
  );
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const q = req.query.token;
  if (typeof q === 'string' && q.length > 20) return q;
  return null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readToken(req);
    if (!token) throw unauthorized('Missing bearer token');
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    } catch {
      throw unauthorized('Your session has expired. Please sign in again.');
    }
    if (!payload.sub) throw unauthorized('Invalid token');
    const db = await getDb();
    const rows = await db.query<{
      id: string; email: string; full_name: string; role: Role; disabled: boolean;
    }>('SELECT id, email, full_name, role, disabled FROM users WHERE id = $1', [payload.sub]);
    const user = rows[0];
    if (!user) throw unauthorized('Account no longer exists');
    if (user.disabled) throw forbidden('This account has been disabled');
    req.user = { id: user.id, email: user.email, fullName: user.full_name, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action requires the ${roles.join(' or ')} role`));
    }
    next();
  };
}

export function requireVet(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'vet') return next(forbidden('Veterinarian access required'));
  next();
}
