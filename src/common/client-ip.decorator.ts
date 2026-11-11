import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The caller's IP as Express resolved it (honours `trust proxy` when set). */
export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => ctx.switchToHttp().getRequest<Request>().ip,
);
