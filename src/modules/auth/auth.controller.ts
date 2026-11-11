import { Body, Controller, ForbiddenException, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuthService, PASSWORD_RULE, PASSWORD_RULE_MESSAGE } from './auth.service';
import { ClientIp } from '../../common/client-ip.decorator';
import { Public } from '../../common/public.decorator';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/current-user.decorator';

class LoginDto {
  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  @MinLength(1, { message: 'Nhập mật khẩu hiện tại' })
  @MaxLength(128)
  currentPassword!: string;

  @IsString()
  @Matches(PASSWORD_RULE, { message: PASSWORD_RULE_MESSAGE })
  newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.assertOrigin(req);
    const result = await this.auth.login(dto.username, dto.password, req.ip, req.headers['user-agent']);
    res.cookie(this.auth.cookieName, result.token, this.auth.cookieOptions());
    return { user: result.user, expiresAt: result.expiresAt };
  }

  @Roles('admin', 'owner')
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[this.auth.cookieName]);
    res.clearCookie(this.auth.cookieName, { path: '/' });
    return { ok: true };
  }

  @Roles('admin', 'owner')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Roles('admin', 'owner')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @ClientIp() ip?: string,
  ) {
    return this.auth.changePassword(user, this.sessionToken(req), dto.currentPassword, dto.newPassword, ip);
  }

  @Roles('admin', 'owner')
  @Post('logout-others')
  logoutOthers(@CurrentUser() user: AuthUser, @Req() req: Request, @ClientIp() ip?: string) {
    return this.auth.logoutOthers(user, this.sessionToken(req), ip);
  }

  /** AuthGuard has already resolved this cookie to a live session, so it is present here. */
  private sessionToken(req: Request): string {
    const token: unknown = req.cookies?.[this.auth.cookieName];
    if (typeof token !== 'string' || !token) throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    return token;
  }

  private assertOrigin(req: Request) {
    if (req.headers.origin && req.headers.origin !== new URL(this.config.getOrThrow<string>('APP_URL')).origin) {
      throw new ForbiddenException('Origin không hợp lệ');
    }
  }
}
