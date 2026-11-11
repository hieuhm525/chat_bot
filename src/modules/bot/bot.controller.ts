import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.decorator';
import { BotInput, BotService } from './bot.service';
import { MAX_QUICK_REPLIES, QUICK_REPLY_TITLE_MAX } from '../channels/adapters/messenger.adapter';

class CreateBotDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() greeting?: string;
  @IsOptional() @IsString() fallbackMessage?: string;
  @IsOptional() @IsString() handoffMessage?: string;
  @IsOptional() @IsBoolean() llmEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(4000) systemPrompt?: string;
  @IsOptional() @IsInt() pauseAfterFallbacks?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUICK_REPLIES, { message: `Tối đa ${MAX_QUICK_REPLIES} nút trả lời nhanh (giới hạn của Messenger)` })
  @IsString({ each: true })
  @MaxLength(QUICK_REPLY_TITLE_MAX, { each: true, message: `Mỗi nút trả lời nhanh tối đa ${QUICK_REPLY_TITLE_MAX} ký tự (giới hạn của Messenger)` })
  greetingQuickReplies?: string[];
  @IsOptional() @IsString() @MaxLength(1000) waitMessage?: string;
}

class UpdateBotDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() greeting?: string;
  @IsOptional() @IsString() fallbackMessage?: string;
  @IsOptional() @IsString() handoffMessage?: string;
  @IsOptional() @IsBoolean() llmEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(4000) systemPrompt?: string;
  @IsOptional() @IsInt() pauseAfterFallbacks?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUICK_REPLIES, { message: `Tối đa ${MAX_QUICK_REPLIES} nút trả lời nhanh (giới hạn của Messenger)` })
  @IsString({ each: true })
  @MaxLength(QUICK_REPLY_TITLE_MAX, { each: true, message: `Mỗi nút trả lời nhanh tối đa ${QUICK_REPLY_TITLE_MAX} ký tự (giới hạn của Messenger)` })
  greetingQuickReplies?: string[];
  @IsOptional() @IsString() @MaxLength(1000) waitMessage?: string;
}

class CreateRuleDto {
  @IsString() @MinLength(1) name!: string;
  @IsArray() @IsString({ each: true }) keywords!: string[];
  @IsOptional() @IsIn(['contains', 'exact']) matchMode?: string;
  @IsOptional() @IsInt() priority?: number;
  @IsString() answer!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUICK_REPLIES, { message: `Tối đa ${MAX_QUICK_REPLIES} nút trả lời nhanh (giới hạn của Messenger)` })
  @IsString({ each: true })
  @MaxLength(QUICK_REPLY_TITLE_MAX, { each: true, message: `Mỗi nút trả lời nhanh tối đa ${QUICK_REPLY_TITLE_MAX} ký tự (giới hạn của Messenger)` })
  quickReplies?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class BulkRuleDto extends CreateRuleDto {
  @IsOptional() @IsUUID() replaceId?: string;
}

class BulkRulesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => BulkRuleDto)
  items!: BulkRuleDto[];
}

class GenerateRulesDto {
  @IsString() @MinLength(1) @MaxLength(30000) text!: string;
}

class RuleIdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID(undefined, { each: true }) ids!: string[];
}

class BulkToggleRulesDto extends RuleIdsDto {
  @IsBoolean() enabled!: boolean;
}

class UpdateRuleDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
  @IsOptional() @IsIn(['contains', 'exact']) matchMode?: string;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsString() answer?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUICK_REPLIES, { message: `Tối đa ${MAX_QUICK_REPLIES} nút trả lời nhanh (giới hạn của Messenger)` })
  @IsString({ each: true })
  @MaxLength(QUICK_REPLY_TITLE_MAX, { each: true, message: `Mỗi nút trả lời nhanh tối đa ${QUICK_REPLY_TITLE_MAX} ký tự (giới hạn của Messenger)` })
  quickReplies?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Roles('owner')
@Controller('bots')
export class BotController {
  constructor(private readonly bot: BotService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.bot.list(user.workspaceId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBotDto) {
    return this.bot.create(user.workspaceId, dto as BotInput);
  }

  @Get(':botId')
  get(@CurrentUser() user: AuthUser, @Param('botId', ParseUUIDPipe) botId: string) {
    return this.bot.get(user.workspaceId, botId);
  }

  @Patch(':botId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('botId', ParseUUIDPipe) botId: string,
    @Body() dto: UpdateBotDto,
  ) {
    return this.bot.update(user.workspaceId, botId, dto as BotInput);
  }

  @Delete(':botId')
  remove(@CurrentUser() user: AuthUser, @Param('botId', ParseUUIDPipe) botId: string) {
    return this.bot.remove(user.workspaceId, botId);
  }

  @Get(':botId/rules')
  listRules(@CurrentUser() user: AuthUser, @Param('botId', ParseUUIDPipe) botId: string) {
    return this.bot.listRules(user.workspaceId, botId);
  }

  @Post(':botId/rules')
  createRule(
    @CurrentUser() user: AuthUser,
    @Param('botId', ParseUUIDPipe) botId: string,
    @Body() dto: CreateRuleDto,
  ) {
    return this.bot.createRule(user.workspaceId, botId, user.id, dto);
  }

  @Post(':botId/rules/generate')
  generateRules(
    @CurrentUser() user: AuthUser,
    @Param('botId', ParseUUIDPipe) botId: string,
    @Body() dto: GenerateRulesDto,
  ) {
    return this.bot.generateRules(user.workspaceId, botId, dto.text);
  }

  @Post(':botId/rules/bulk')
  createRules(
    @CurrentUser() user: AuthUser,
    @Param('botId', ParseUUIDPipe) botId: string,
    @Body() dto: BulkRulesDto,
  ) {
    return this.bot.createRules(user.workspaceId, botId, user.id, dto.items);
  }

  @Post(':botId/rules/bulk-update')
  setRulesEnabled(
    @CurrentUser() user: AuthUser,
    @Param('botId', ParseUUIDPipe) botId: string,
    @Body() dto: BulkToggleRulesDto,
  ) {
    return this.bot.setRulesEnabled(user.workspaceId, botId, dto.ids, dto.enabled);
  }

  @Post(':botId/rules/bulk-delete')
  deleteRules(
    @CurrentUser() user: AuthUser,
    @Param('botId', ParseUUIDPipe) botId: string,
    @Body() dto: RuleIdsDto,
  ) {
    return this.bot.deleteRules(user.workspaceId, botId, dto.ids);
  }

  @Patch(':botId/rules/:id')
  updateRule(
    @CurrentUser() user: AuthUser,
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRuleDto,
  ) {
    return this.bot.updateRule(user.workspaceId, botId, id, dto);
  }

  @Delete(':botId/rules/:id')
  deleteRule(
    @CurrentUser() user: AuthUser,
    @Param('botId', ParseUUIDPipe) botId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bot.deleteRule(user.workspaceId, botId, id);
  }
}
