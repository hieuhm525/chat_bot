import { SetMetadata } from '@nestjs/common';

export type Role = 'admin' | 'owner';
export const ROLES_KEY = 'roles';

/** Endpoints without @Roles are denied by RolesGuard (deny by default). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
