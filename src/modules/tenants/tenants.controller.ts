import {
  All,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, Matches, Max, MaxLength, MinLength, Min } from 'class-validator';
import { ClientIp } from '../../common/client-ip.decorator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { Roles } from '../../common/roles.decorator';
import { TENANT_STATUSES, TenantsService } from './tenants.service';

const USERNAME_RULE = /^[a-zA-Z0-9._-]{3,32}$/;
const USERNAME_MESSAGE = 'Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số, . _ -';

class CreateTenantDto {
  /** Optional: defaults to the owner's username (same as self-signup). */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;

  @IsString() @Matches(USERNAME_RULE, { message: USERNAME_MESSAGE })
  username!: string;

  @IsString() @MinLength(6) password!: string;

  @IsOptional() @IsString() @MaxLength(50) plan?: string;

  @IsOptional() @IsInt() @Min(0) maxBots?: number;

  @IsOptional() @IsInt() @Min(0) maxChannels?: number;

  @IsOptional() @IsISO8601() expiresAt?: string | null;
}

class UpdateTenantDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;

  @IsOptional() @IsString() @MaxLength(50) plan?: string;

  @IsOptional() @IsInt() @Min(0) maxBots?: number;

  @IsOptional() @IsInt() @Min(0) maxChannels?: number;

  @IsOptional() @IsISO8601() expiresAt?: string | null;
}

class ListTenantsDto {
  @IsOptional() @IsInt() @Min(1) page?: number;

  @IsOptional() @IsInt() @Min(1) @Max(100) pageSize?: number;

  @IsOptional() @IsString() @MaxLength(100) q?: string;

  @IsOptional()
  @IsIn(TENANT_STATUSES as unknown as string[], { message: `status phải là một trong: ${TENANT_STATUSES.join(', ')}` })
  status?: (typeof TENANT_STATUSES)[number];
}

class UsernameCheckDto {
  @IsString() @Matches(USERNAME_RULE, { message: USERNAME_MESSAGE })
  username!: string;
}

class ResetPasswordDto {
  @IsString() @MinLength(6) password!: string;
}

@Roles('admin')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  list(@Query() query: ListTenantsDto) {
    return this.tenants.list({ page: query.page ?? 1, pageSize: query.pageSize ?? 20, q: query.q, status: query.status });
  }

  @Get('username-available')
  async usernameAvailable(@Query() query: UsernameCheckDto) {
    return { available: !(await this.tenants.isUsernameTaken(query.username)) };
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTenantDto, @ClientIp() ip?: string) {
    return this.tenants.create(dto, { user, ip });
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
    @ClientIp() ip?: string,
  ) {
    return this.tenants.update(id, dto, { user, ip });
  }

  @Post(':id/suspend')
  suspend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.tenants.suspend(id, { user, ip });
  }

  @Post(':id/resume')
  resume(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.tenants.resume(id, { user, ip });
  }

  @Post(':id/reset-owner-password')
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @ClientIp() ip?: string,
  ) {
    return this.tenants.resetOwnerPassword(id, dto.password, { user, ip });
  }
}

/** Temporary alias so old bookmarks/scripts keep working; remove after one release. */
@Controller('customers')
export class CustomersAliasController {
  @Public()
  @All()
  root(@Req() req: Request, @Res() res: Response) {
    res.redirect(308, req.originalUrl.replace('/api/v1/customers', '/api/v1/tenants'));
  }

  @Public()
  @All('*path')
  child(@Req() req: Request, @Res() res: Response) {
    res.redirect(308, req.originalUrl.replace('/api/v1/customers', '/api/v1/tenants'));
  }
}
