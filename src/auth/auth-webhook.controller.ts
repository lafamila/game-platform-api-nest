import { Body, Controller, Headers, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthWebhookService } from './auth-webhook.service';

@Controller('auth/webhooks')
export class AuthWebhookController {
  constructor(private readonly webhooks: AuthWebhookService) {}

  @Post()
  handle(
    @Req() request: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Headers('x-auth-webhook-id') eventId: string | undefined,
    @Headers('x-auth-webhook-timestamp') timestamp: string | undefined,
    @Headers('x-auth-webhook-signature') signature: string | undefined,
  ) {
    return this.webhooks.handle({
      rawBody: request.rawBody,
      body,
      eventId,
      timestamp,
      signature,
    });
  }
}
