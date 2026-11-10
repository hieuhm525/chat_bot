import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.decorator';
import { LlmProvidersService, ProviderInput } from './llm-providers.service';

class CreateProviderDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;

  @IsOptional() @IsIn(['openai_compatible']) kind?: string;

  @IsString() @Matches(/^https?:\/\/\S+$/, { message: 'baseUrl phải bắt đầu bằng http:// hoặc https://' })
  baseUrl!: string;

  @IsString() @MinLength(1) @MaxLength(200) model!: string;

  @IsOptional() @IsString() @MaxLength(500) apiKey?: string;

  @IsOptional() @IsInt() priority?: number;

  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdateProviderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;

  @IsOptional() @IsIn(['openai_compatible']) kind?: string;

  @IsOptional() @IsString() @Matches(/^https?:\/\/\S+$/, { message: 'baseUrl phải bắt đầu bằng http:// hoặc https://' })
  baseUrl?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) model?: string;

  @IsOptional() @IsString() @MaxLength(500) apiKey?: string;

  @IsOptional() @IsInt() priority?: number;

  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Roles('admin')
@Controller('llm-providers')
export class LlmProvidersController {
  constructor(private readonly providers: LlmProvidersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.providers.list();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProviderDto) {
    return this.providers.create(dto as ProviderInput);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProviderDto,
  ) {
    return this.providers.update(id, dto as ProviderInput);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.providers.remove(id);
  }

  @Post(':id/test')
  test(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.providers.test(id);
  }
}
