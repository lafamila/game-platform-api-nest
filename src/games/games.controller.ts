import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { AuthAccount } from '../auth/auth.types';
import { GamePlatformSessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user';
import { Difficulty } from './games.types';
import { GamesService } from './games.service';

@UseGuards(GamePlatformSessionGuard)
@Controller()
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @Get('games')
  listGames() {
    return { games: this.games.listGames() };
  }

  @Get('emotes')
  listEmotes(@CurrentUser() user: AuthAccount) {
    return this.games.listEmotes(user);
  }

  @Put('emotes/:slot')
  saveEmote(
    @Param('slot') slot: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { gridSize?: number; cells?: Array<string | null> },
  ) {
    return this.games.saveEmote(user, Number(slot), body);
  }

  @Post('sudoku/sessions')
  createSudoku(@CurrentUser() user: AuthAccount, @Body() body: { difficulty?: Difficulty; opponentAccountId?: string }) {
    return this.games.createSudokuSession(user, body.difficulty ?? 'easy', body.opponentAccountId);
  }

  @Get('sudoku/sessions/:id')
  getSudoku(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getSudokuSession(id, user);
  }

  @Patch('sudoku/sessions/:id/cells')
  updateSudokuCell(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { row: number; col: number; value: number }) {
    return this.games.updateSudokuCell(id, user, Number(body.row), Number(body.col), Number(body.value));
  }

  @Post('sudoku/sessions/:id/submit')
  submitSudoku(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { board?: number[][] }) {
    return this.games.submitSudoku(id, user, body.board);
  }

  @Post('sudoku/sessions/:id/emotes')
  sendSudokuEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendSudokuEmote(id, user, Number(body.slot));
  }

  @Post('games/:gameKey/sessions/:id/pause')
  pauseGame(@Param('gameKey') gameKey: string, @Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.pauseMatchedGame(gameKey, id, user);
  }

  @Post('games/:gameKey/sessions/:id/resume')
  resumeGame(@Param('gameKey') gameKey: string, @Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.resumeMatchedGame(gameKey, id, user);
  }

  @Post('gomoku/sessions')
  createGomoku(@CurrentUser() user: AuthAccount, @Body() body: { opponentAccountId?: string; difficulty?: Difficulty }) {
    return this.games.createGomokuSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'easy');
  }

  @Get('gomoku/sessions/:id')
  getGomoku(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getGomokuSession(id, user);
  }

  @Post('gomoku/sessions/:id/moves')
  playGomokuMove(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { row: number; col: number }) {
    return this.games.playGomokuMove(id, user, Number(body.row), Number(body.col));
  }

  @Post('gomoku/sessions/:id/emotes')
  sendGomokuEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendGomokuEmote(id, user, Number(body.slot));
  }

  @Post('gomoku/sessions/:id/forfeit')
  forfeitGomoku(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitGomoku(id, user);
  }

  @Post('alkkagi/sessions')
  createAlkkagi(@CurrentUser() user: AuthAccount, @Body() body: { opponentAccountId?: string; difficulty?: Difficulty }) {
    return this.games.createAlkkagiSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'easy');
  }

  @Get('alkkagi/sessions/:id')
  getAlkkagi(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getAlkkagiSession(id, user);
  }

  @Post('alkkagi/sessions/:id/shots')
  shootAlkkagi(
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { pieceId: string; vx: number; vy: number },
  ) {
    return this.games.shootAlkkagi(id, user, body.pieceId, Number(body.vx), Number(body.vy));
  }

  @Post('alkkagi/sessions/:id/emotes')
  sendAlkkagiEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendAlkkagiEmote(id, user, Number(body.slot));
  }

  @Post('alkkagi/sessions/:id/drag')
  updateAlkkagiDrag(
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { pieceId: string; startX: number; startY: number; currentX: number; currentY: number; phase?: string },
  ) {
    return this.games.updateAlkkagiDrag(id, user, {
      pieceId: body.pieceId,
      startX: Number(body.startX),
      startY: Number(body.startY),
      currentX: Number(body.currentX),
      currentY: Number(body.currentY),
      phase: body.phase,
    });
  }

  @Post('alkkagi/sessions/:id/forfeit')
  forfeitAlkkagi(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitAlkkagi(id, user);
  }
}
