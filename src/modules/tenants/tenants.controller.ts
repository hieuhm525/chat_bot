import {
  All,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsISO8601, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { Roles } from '../../common/roles.decorator';
import { TenantsService } from './tenants.service';

class CreateTenantDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;

  @IsString() @Matches(/^[a-zA-Z0-9._-]{3,32}$/, { message: 'Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số, . _ -' })
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

class ResetPasswordDto {
  @IsString() @MinLength(6) password!: string;
}

@Roles('admin')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tenants.list();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTenantDto) {
    return this.tenants.create(dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenants.update(id, dto);
  }

  @Post(':id/suspend')
  suspend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.suspend(id);
  }

  @Post(':id/resume')
  resume(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.resume(id);
  }

  @Post(':id/reset-owner-password')
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.tenants.resetOwnerPassword(id, dto.password);
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
