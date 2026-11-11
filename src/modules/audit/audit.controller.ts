import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Roles } from '../../common/roles.decorator';
import { AUDIT_ACTIONS, AuditService } from './audit.service';

class AuditQueryDto {
  @IsOptional() @IsInt() @Min(1) page?: number;

  @IsOptional() @IsInt() @Min(1) @Max(100) pageSize?: number;

  @IsOptional() @IsIn(AUDIT_ACTIONS as unknown as string[], { message: `action phải là một trong: ${AUDIT_ACTIONS.join(', ')}` })
  action?: string;

  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

@Roles('admin')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: AuditQueryDto) {
    return this.audit.list({ page: query.page ?? 1, pageSize: query.pageSize ?? 25, action: query.action, q: query.q });
  }
}
