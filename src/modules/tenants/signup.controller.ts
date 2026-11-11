import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { IsString, Matches, MinLength } from 'class-validator';
import { Public } from '../../common/public.decorator';
import { AuthService } from '../auth/auth.service';
import { TenantsService } from './tenants.service';

class SignupDto {
  @IsString() @Matches(/^[a-zA-Z0-9._-]{3,32}$/, { message: 'Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số, . _ -' })
  username!: string;

  @IsString() @MinLength(6) password!: string;

  @IsString() confirmPassword!: string;
}

/** Self-service trial tenants, gated by ALLOW_SIGNUP. Same defaults as an admin-created tenant. */
@Controller('signup')
export class SignupController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('status')
  status() {
    return { enabled: this.enabled(), trialDays: this.config.getOrThrow<number>('SIGNUP_TRIAL_DAYS') };
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  async create(@Body() dto: SignupDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!this.enabled()) throw new NotFoundException();
    const origin = req.headers.origin;
    if (origin && origin !== new URL(this.config.getOrThrow<string>('APP_URL')).origin) {
      throw new ForbiddenException('Origin không hợp lệ');
    }
    if (dto.password !== dto.confirmPassword) throw new BadRequestException('Mật khẩu nhập lại không khớp');

    const days = this.config.getOrThrow<number>('SIGNUP_TRIAL_DAYS');
    await this.tenants.create({
      // The workspace is named after the owner until they rename it.
      name: dto.username.trim().toLowerCase(),
      username: dto.username,
      password: dto.password,
      plan: 'trial',
      expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    });
    const result = await this.auth.login(dto.username, dto.password, req.ip, req.headers['user-agent']);
    res.cookie(this.auth.cookieName, result.token, this.auth.cookieOptions());
    return { user: result.user, expiresAt: result.expiresAt };
  }

  private enabled() {
    return this.config.getOrThrow<string>('ALLOW_SIGNUP') === 'true';
  }
}
