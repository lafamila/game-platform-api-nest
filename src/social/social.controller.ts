import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../auth/current-user';
import { AuthAccount, RequestWithAuth } from '../auth/auth.types';
import { GamePlatformSessionGuard } from '../auth/session.guard';
import { SocialService } from './social.service';

@UseGuards(GamePlatformSessionGuard)
@Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('accounts/search')
  searchAccounts(@Query('q') q: string) {
    return this.social.searchAccounts(q ?? '');
  }

  @Get('friends/requests')
  listFriendRequests(@CurrentUser() user: AuthAccount) {
    return this.social.listFriendRequests(user);
  }

  @Get('friends')
  listFriends(@CurrentUser() user: AuthAccount) {
    return this.social.listFriends(user);
  }

  @Post('friends/requests')
  createFriendRequest(@CurrentUser() user: AuthAccount, @Body() body: { recipientAccountId: string }) {
    return this.social.createFriendRequest(user, body.recipientAccountId);
  }

  @Post('friends/requests/:id/accept')
  acceptFriendRequest(@CurrentUser() user: AuthAccount, @Param('id') id: string) {
    return this.social.acceptFriendRequest(user, id);
  }

  @Post('friends/requests/:id/reject')
  rejectFriendRequest(@CurrentUser() user: AuthAccount, @Param('id') id: string) {
    return this.social.rejectFriendRequest(user, id);
  }

  @Get('blocks')
  listBlocks(@CurrentUser() user: AuthAccount) {
    return this.social.listBlocks(user);
  }

  @Post('blocks')
  blockAccount(@CurrentUser() user: AuthAccount, @Body() body: { blockedAccountId: string }) {
    return this.social.blockAccount(user, body.blockedAccountId);
  }

  @Delete('blocks/:accountId')
  unblockAccount(@CurrentUser() user: AuthAccount, @Param('accountId') accountId: string) {
    return this.social.unblockAccount(user, accountId);
  }

  @Get('matches')
  listMatches(@CurrentUser() user: AuthAccount) {
    return this.social.listMatchRequests(user);
  }

  @Post('matches')
  createMatch(@CurrentUser() user: AuthAccount, @Body() body: { gameKey: string; opponentAccountId: string }) {
    return this.social.createMatchRequest(user, body);
  }

  @Post('permission-upgrade-requests')
  createPermissionUpgradeRequest(@Req() request: Request & Partial<RequestWithAuth>) {
    return this.social.createPermissionUpgradeRequest(request.gameSession);
  }

  @Post('matches/:id/accept')
  acceptMatch(@CurrentUser() user: AuthAccount, @Param('id') id: string) {
    return this.social.acceptMatchRequest(user, id);
  }

  @Post('matches/:id/reject')
  rejectMatch(@CurrentUser() user: AuthAccount, @Param('id') id: string) {
    return this.social.rejectMatchRequest(user, id);
  }
}
