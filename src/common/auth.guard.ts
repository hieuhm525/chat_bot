import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../modules/auth/auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest();
    const user = await this.auth.resolveSession(req.cookies?.[this.auth.cookieName]);
    if (!user) throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');

    // CSRF: browsers send Origin on cross-site writes. Reject a foreign one.
    if (req.method !== 'GET' && req.headers.origin) {
      const allowed = new URL(this.config.getOrThrow<string>('APP_URL')).origin;
      if (req.headers.origin !== allowed) throw new ForbiddenException('Origin không hợp lệ');
    }
    req.user = user;
    return true;
  }
}
