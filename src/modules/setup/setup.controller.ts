import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { Public } from '../../common/public.decorator';
import { AuthService } from '../auth/auth.service';
import { SetupService } from './setup.service';

class SetupDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9._-]{3,32}$/, { message: 'Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số, . _ -' })
  username!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  confirmPassword!: string;

  @IsOptional()
  @IsString()
  setupToken?: string;
}

@Controller('setup')
export class SetupController {
  constructor(
    private readonly setup: SetupService,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Get('status')
  status(@Req() req: Request) {
    return this.setup.status(req);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  async create(@Body() dto: SetupDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.setup.create(dto, req);
    res.cookie(this.auth.cookieName, result.token, this.auth.cookieOptions());
    return { user: result.user, expiresAt: result.expiresAt };
  }
}
