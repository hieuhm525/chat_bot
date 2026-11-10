import { Body, Controller, ForbiddenException, Get, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
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

  @Roles('admin', 'owner', 'agent')
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[this.auth.cookieName]);
    res.clearCookie(this.auth.cookieName, { path: '/' });
    return { ok: true };
  }

  @Roles('admin', 'owner', 'agent')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  private assertOrigin(req: Request) {
    if (req.headers.origin && req.headers.origin !== new URL(this.config.getOrThrow<string>('APP_URL')).origin) {
      throw new ForbiddenException('Origin không hợp lệ');
    }
  }
}
