export interface AllowedIp {
  id: string;
  ipOrCidr: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAllowedIpPayload {
  ipOrCidr: string;
  description: string;
}

export interface UpdateAllowedIpPayload {
  ipOrCidr?: string;
  description?: string;
}
