import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { ConversationsService } from './conversations.service';
import { Roles } from '../../common/roles.decorator';

@Controller('stats')
export class StatsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Roles('owner')
  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.conversations.stats(user.workspaceId);
  }
}
