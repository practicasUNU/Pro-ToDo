import type { AuditableData } from '@/types/auditable';

/** Replica de `AllowedIpResponseDto` del backend, con su auditoria (045). */
export interface AllowedIp extends AuditableData {
  id: string;
  ipOrCidr: string;
  description: string;
}

export interface CreateAllowedIpPayload {
  ipOrCidr: string;
  description: string;
}

export interface UpdateAllowedIpPayload {
  ipOrCidr?: string;
  description?: string;
}
