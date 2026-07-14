export interface PairingRequest { platform: string; userId: string; code: string; createdAt: number; expiresAt: number; }
export interface PairingApproval { platform: string; userId: string; approvedAt: number; }
export type PairingRequestResult = { status: "created" | "existing"; code: string; expiresAt: number } | { status: "rate_limited" | "capacity" };
export interface PairingAuthority { isApproved(platform: string, userIds: string[]): boolean; request(platform: string, userId: string, now?: number): PairingRequestResult; }
