import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './current-user.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY, Role } from './roles.decorator';

/**
 * Runs after AuthGuard. A handler or controller without @Roles is denied on
 * purpose, so every new endpoint must declare who may call it.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (!roles?.length) throw new ForbiddenException('Endpoint chưa khai báo quyền');

    const user = ctx.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user) throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    if (!roles.includes(user.role)) throw new ForbiddenException('Bạn không có quyền gọi endpoint này');
    return true;
  }
}
