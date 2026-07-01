import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthAccount } from './auth.types';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthAccount => {
  return ctx.switchToHttp().getRequest<{ authAccount: AuthAccount }>().authAccount;
});
