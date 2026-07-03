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
    return this.games.createSudokuSession(user, body.difficulty ?? 'medium', body.opponentAccountId);
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

  @Post('games/:gameKey/sessions/:id/local-save-restore')
  restoreLocalSave(
    @Param('gameKey') gameKey: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: Record<string, unknown>,
  ) {
    return this.games.restoreLocalSaveSnapshot(gameKey, id, user, body);
  }

  @Post('gomoku/sessions')
  createGomoku(@CurrentUser() user: AuthAccount, @Body() body: { opponentAccountId?: string; difficulty?: Difficulty }) {
    return this.games.createGomokuSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium');
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
    return this.games.createAlkkagiSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium');
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

  @Post('othello/sessions')
  createOthello(@CurrentUser() user: AuthAccount, @Body() body: { opponentAccountId?: string; difficulty?: Difficulty }) {
    return this.games.createOthelloSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium');
  }

  @Get('othello/sessions/:id')
  getOthello(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getOthelloSession(id, user);
  }

  @Post('othello/sessions/:id/moves')
  playOthelloMove(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { row: number; col: number }) {
    return this.games.playOthelloMove(id, user, Number(body.row), Number(body.col));
  }

  @Post('othello/sessions/:id/emotes')
  sendOthelloEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendOthelloEmote(id, user, Number(body.slot));
  }

  @Post('othello/sessions/:id/forfeit')
  forfeitOthello(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitOthello(id, user);
  }

  @Post('sokoban/sessions')
  createSokoban(@CurrentUser() user: AuthAccount, @Body() body: { difficulty?: Difficulty; opponentAccountId?: string }) {
    return this.games.createSokobanSession(user, body.difficulty ?? 'medium', body.opponentAccountId);
  }

  @Get('sokoban/sessions/:id')
  getSokoban(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getSokobanSession(id, user);
  }

  @Post('sokoban/sessions/:id/moves')
  moveSokoban(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { direction: string }) {
    return this.games.moveSokoban(id, user, body.direction);
  }

  @Post('sokoban/sessions/:id/emotes')
  sendSokobanEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendSokobanEmote(id, user, Number(body.slot));
  }

  @Post('sokoban/sessions/:id/forfeit')
  forfeitSokoban(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitSokoban(id, user);
  }

  @Post('splendor/sessions')
  createSplendor(@CurrentUser() user: AuthAccount, @Body() body: { opponentAccountId?: string; difficulty?: Difficulty }) {
    return this.games.createSplendorSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium');
  }

  @Get('splendor/sessions/:id')
  getSplendor(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getSplendorSession(id, user);
  }

  @Post('splendor/sessions/:id/tokens')
  takeSplendorTokens(
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body()
    body: {
      tokens?: Record<string, number>;
      discardTokens?: Record<string, number>;
    },
  ) {
    return this.games.takeSplendorTokens(id, user, body.tokens ?? {}, body.discardTokens ?? {});
  }

  @Post('splendor/sessions/:id/reserve')
  reserveSplendorCard(
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body()
    body: {
      cardId?: string;
      tier?: string;
      discardTokens?: Record<string, number>;
    },
  ) {
    return this.games.reserveSplendorCard(id, user, body);
  }

  @Post('splendor/sessions/:id/buy')
  buySplendorCard(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { cardId: string }) {
    return this.games.buySplendorCard(id, user, body.cardId);
  }

  @Post('splendor/sessions/:id/preview')
  previewSplendorSelection(
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { cardId?: string | null; tokens?: Record<string, number> },
  ) {
    return this.games.previewSplendorSelection(id, user, body);
  }

  @Post('splendor/sessions/:id/emotes')
  sendSplendorEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendSplendorEmote(id, user, Number(body.slot));
  }

  @Post('splendor/sessions/:id/forfeit')
  forfeitSplendor(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitSplendor(id, user);
  }

  @Post('fortress/sessions')
  createFortress(@CurrentUser() user: AuthAccount, @Body() body: { opponentAccountId?: string; difficulty?: Difficulty }) {
    return this.games.createFortressSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium');
  }

  @Get('fortress/sessions/:id')
  getFortress(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getFortressSession(id, user);
  }

  @Post('fortress/sessions/:id/select-tank')
  selectFortressTank(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { tankKey: string }) {
    return this.games.selectFortressTank(id, user, body.tankKey);
  }

  @Post('fortress/sessions/:id/moves')
  moveFortress(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { distance: number }) {
    return this.games.moveFortress(id, user, Number(body.distance));
  }

  @Post('fortress/sessions/:id/shots')
  shootFortress(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { angle: number; power: number }) {
    return this.games.shootFortress(id, user, Number(body.angle), Number(body.power));
  }

  @Post('fortress/sessions/:id/emotes')
  sendFortressEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendFortressEmote(id, user, Number(body.slot));
  }

  @Post('fortress/sessions/:id/forfeit')
  forfeitFortress(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitFortress(id, user);
  }
}
