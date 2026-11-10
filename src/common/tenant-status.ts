/** A tenant is usable only when it is trial/active and not past its expiry. Admin is exempt. */
export function tenantBlocked(status: string, expiresAt: Date | null | undefined, now = new Date()): boolean {
  if (status === 'suspended' || status === 'expired') return true;
  return !!expiresAt && expiresAt.getTime() < now.getTime();
}
