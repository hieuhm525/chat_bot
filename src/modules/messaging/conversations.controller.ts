import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.decorator';
import { ConversationsService } from './conversations.service';

class SendMessageDto {
  @IsString()
  @MinLength(1)
  content!: string;
}

class ListConversationsDto {
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsUUID()
  botId?: string;

  @IsOptional()
  @IsIn(['bot', 'human', 'off'])
  mode?: string;

  @IsOptional()
  @IsUUID()
  assignedUserId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@Roles('owner', 'agent')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListConversationsDto) {
    return this.conversations.list(user.workspaceId, query);
  }

  // Must stay before ':id' so "options" is not parsed as an id.
  @Get('options')
  options(@CurrentUser() user: AuthUser) {
    return this.conversations.options(user.workspaceId);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.detail(user.workspaceId, id);
  }

  @Get(':id/messages')
  messages(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('before') before?: string) {
    return this.conversations.messagesBefore(user.workspaceId, id, before);
  }

  @Post(':id/takeover')
  takeover(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.takeover(user.workspaceId, id, user.id);
  }

  @Post(':id/release')
  release(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.release(user.workspaceId, id, user.id);
  }

  @Post(':id/messages')
  send(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.conversations.sendAgentMessage(user.workspaceId, id, user.id, dto.content);
  }
}
