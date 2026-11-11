import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_MENU_ITEMS, MENU_TITLE_MAX } from './adapters/messenger.adapter';
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

class MenuItemDto {
  @IsString()
  @MinLength(1, { message: 'Tên mục menu không được để trống' })
  @MaxLength(MENU_TITLE_MAX, { message: `Tên mục menu tối đa ${MENU_TITLE_MAX} ký tự (giới hạn của Messenger)` })
  title!: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'Link phải là URL https://...' })
  url?: string;
}

class MessengerProfileDto {
  @IsBoolean()
  getStarted!: boolean;

  @IsArray()
  @ArrayMaxSize(MAX_MENU_ITEMS, { message: `Menu tối đa ${MAX_MENU_ITEMS} mục (giới hạn của Messenger)` })
  @ValidateNested({ each: true })
  @Type(() => MenuItemDto)
  persistentMenu!: MenuItemDto[];
}

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

  @Put(':id/messenger-profile')
  updateMessengerProfile(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: MessengerProfileDto) {
    return this.channels.updateMessengerProfile(user.workspaceId, id, {
      getStarted: dto.getStarted,
      persistentMenu: dto.persistentMenu.map((item) => ({
        title: item.title.trim(),
        ...(item.url ? { url: item.url } : {}),
      })),
    });
  }

  @Post(':id/test')
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.channels.test(user.workspaceId, id);
  }
}
