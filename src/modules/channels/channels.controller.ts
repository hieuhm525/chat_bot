import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { IsDateString, IsIn, IsObject, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { CurrentUser, AuthUser } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.decorator';
import { ChannelsService } from './channels.service';
import { Provider } from './adapter.types';

class CreateChannelDto {
  @IsIn(['messenger', 'zalo', 'whatsapp'])
  provider!: Provider;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(1)
  externalId!: string;

  @IsObject()
  credentials!: Record<string, string>;

  @IsUUID()
  botId!: string;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  credentialExpiresAt?: string;
}

class UpdateChannelDto extends PartialType(CreateChannelDto) {}

@Roles('owner')
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.channels.list(user.workspaceId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateChannelDto) {
    return this.channels.create(user.workspaceId, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateChannelDto) {
    return this.channels.update(user.workspaceId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.channels.remove(user.workspaceId, id);
  }

  @Post(':id/test')
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.channels.test(user.workspaceId, id);
  }
}
