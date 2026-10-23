import type { AuditableData } from '@/types/auditable';

export enum UserRole {
  ADMIN = 'ADMIN',
  EDITOR = 'EDITOR',
}

export interface User extends AuditableData {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
}

export interface CreateUserPayload {
  email: string;
  role: UserRole;
}

export interface UpdateUserPayload {
  email?: string;
  role?: UserRole;
  isActive?: boolean;
}
