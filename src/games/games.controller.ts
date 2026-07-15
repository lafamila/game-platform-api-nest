import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthAccount } from '../auth/auth.types';
import { GamePlatformSessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user';
import { Difficulty, PlayerColor } from './games.types';
import { GamesService } from './games.service';

@UseGuards(GamePlatformSessionGuard)
@Controller()
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @Get('games')
  listGames() {
    return { games: this.games.listGames() };
  }

  @Post('games/:gameKey/sessions')
  createGameSession(
    @Param('gameKey') gameKey: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { opponentAccountId?: string; difficulty?: Difficulty; config?: Record<string, unknown> },
  ) {
    return this.games.createGameSession(gameKey, user, body);
  }

  @Get('games/:gameKey/sessions/:id')
  getGameSession(
    @Param('gameKey') gameKey: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
  ) {
    return this.games.getGameSession(gameKey, id, user);
  }

  @Get('sessions/active')
  listActiveSessions(@CurrentUser() user: AuthAccount) {
    return this.games.listActiveSessions(user);
  }

  @Post('sessions/active/forfeit')
  forfeitActiveSessions(@CurrentUser() user: AuthAccount) {
    return this.games.forfeitActiveSessions(user);
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

  @Post('sudoku/sessions/:id/forfeit')
  forfeitSudoku(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitSudoku(id, user);
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

  @Post('games/:gameKey/sessions/:id/actions')
  applyGameAction(
    @Param('gameKey') gameKey: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { type?: string; payload?: Record<string, unknown>; clientMoveId?: string },
  ) {
    return this.games.applyGameAction(gameKey, id, user, body);
  }

  @Post('games/:gameKey/sessions/:id/emotes')
  sendGameEmote(
    @Param('gameKey') gameKey: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { slot: number },
  ) {
    return this.games.sendGameEmote(gameKey, id, user, Number(body.slot));
  }

  @Post('games/:gameKey/sessions/:id/claim-win')
  claimDisconnectedWin(@Param('gameKey') gameKey: string, @Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.claimDisconnectedWin(gameKey, id, user);
  }

  @Post('games/:gameKey/sessions/:id/wait')
  waitForOpponent(@Param('gameKey') gameKey: string, @Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.waitForOpponent(gameKey, id, user);
  }

  @Post('games/:gameKey/sessions/:id/save')
  saveGameSession(
    @Param('gameKey') gameKey: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { slot?: number; label?: string },
  ) {
    return this.games.saveGameSessionToSlot(gameKey, id, user, body);
  }

  @Get('saves')
  listSaves(@CurrentUser() user: AuthAccount, @Query('gameKey') gameKey?: string) {
    return this.games.listGameSaves(user, gameKey);
  }

  @Post('saves/:id/continue')
  continueSave(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { difficulty?: Difficulty }) {
    return this.games.continueGameSave(id, user, body);
  }

  @Delete('saves/:id')
  deleteSave(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.deleteGameSave(id, user);
  }

  @Post('local-ai-results/batch')
  uploadLocalAiResults(
    @CurrentUser() user: AuthAccount,
    @Body() body: { results?: unknown[] },
  ) {
    return this.games.uploadLocalAiResults(user, body);
  }

  @Post('rooms')
  createRoom(
    @CurrentUser() user: AuthAccount,
    @Body() body: { gameKey?: string; maxPlayers?: number; visibility?: string; config?: Record<string, unknown> },
  ) {
    return this.games.createRoom(user, body);
  }

  @Get('rooms/:id')
  getRoom(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getRoom(id, user);
  }

  @Post('rooms/:id/invite')
  inviteToRoom(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { accountId?: string }) {
    return this.games.inviteToRoom(id, user, body);
  }

  @Post('rooms/:id/ai')
  addAiToRoom(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { difficulty?: Difficulty }) {
    return this.games.addAiToRoom(id, user, body);
  }

  @Post('rooms/:id/accept')
  acceptRoomInvite(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.acceptRoomInvite(id, user);
  }

  @Post('rooms/:id/reject')
  rejectRoomInvite(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.rejectRoomInvite(id, user);
  }

  @Post('rooms/:id/emotes')
  sendRoomEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot?: number }) {
    return this.games.sendRoomEmote(id, user, Number(body.slot));
  }

  @Post('rooms/join')
  joinRoom(@CurrentUser() user: AuthAccount, @Body() body: { roomCode?: string }) {
    return this.games.joinRoom(user, body);
  }

  @Post('rooms/:id/ready')
  setRoomReady(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { ready?: boolean }) {
    return this.games.setRoomReady(id, user, body);
  }

  @Post('rooms/:id/start')
  startRoom(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.startRoom(id, user);
  }

  @Post('gomoku/sessions')
  createGomoku(
    @CurrentUser() user: AuthAccount,
    @Body() body: { opponentAccountId?: string; difficulty?: Difficulty; color?: PlayerColor },
  ) {
    return this.games.createGomokuSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium', body.color);
  }

  @Get('gomoku/sessions/:id')
  getGomoku(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getGomokuSession(id, user);
  }

  @Post('gomoku/sessions/:id/moves')
  playGomokuMove(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { row: number; col: number; clientMoveId?: string }) {
    return this.games.playGomokuMove(id, user, Number(body.row), Number(body.col), body.clientMoveId);
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
    @Body() body: { pieceId: string; vx: number; vy: number; clientMoveId?: string },
  ) {
    return this.games.shootAlkkagi(id, user, body.pieceId, Number(body.vx), Number(body.vy), body.clientMoveId);
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
  createOthello(
    @CurrentUser() user: AuthAccount,
    @Body() body: { opponentAccountId?: string; difficulty?: Difficulty; color?: PlayerColor },
  ) {
    return this.games.createOthelloSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium', body.color);
  }

  @Get('othello/sessions/:id')
  getOthello(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getOthelloSession(id, user);
  }

  @Post('othello/sessions/:id/moves')
  playOthelloMove(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { row: number; col: number; clientMoveId?: string }) {
    return this.games.playOthelloMove(id, user, Number(body.row), Number(body.col), body.clientMoveId);
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
  moveSokoban(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { direction: string; clientMoveId?: string }) {
    return this.games.moveSokoban(id, user, body.direction, body.clientMoveId);
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
      clientMoveId?: string;
    },
  ) {
    return this.games.takeSplendorTokens(id, user, body.tokens ?? {}, body.discardTokens ?? {}, body.clientMoveId);
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
      clientMoveId?: string;
    },
  ) {
    return this.games.reserveSplendorCard(id, user, body, body.clientMoveId);
  }

  @Post('splendor/sessions/:id/buy')
  buySplendorCard(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { cardId: string; clientMoveId?: string }) {
    return this.games.buySplendorCard(id, user, body.cardId, body.clientMoveId);
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
  moveFortress(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { distance: number; clientMoveId?: string }) {
    return this.games.moveFortress(id, user, Number(body.distance), body.clientMoveId);
  }

  @Post('fortress/sessions/:id/aim')
  updateFortressAim(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { angle: number; power: number; charging?: boolean }) {
    return this.games.updateFortressAim(id, user, Number(body.angle), Number(body.power), body.charging === true);
  }

  @Post('fortress/sessions/:id/shots')
  shootFortress(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { angle: number; power: number; item?: 'doubleShot' | 'airStrike'; clientMoveId?: string }) {
    return this.games.shootFortress(id, user, Number(body.angle), Number(body.power), body.item, body.clientMoveId);
  }

  @Post('fortress/sessions/:id/emotes')
  sendFortressEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendFortressEmote(id, user, Number(body.slot));
  }

  @Post('fortress/sessions/:id/forfeit')
  forfeitFortress(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitFortress(id, user);
  }

  @Post('four-ball/sessions')
  createFourBall(@CurrentUser() user: AuthAccount, @Body() body: { opponentAccountId?: string; difficulty?: Difficulty }) {
    return this.games.createFourBallSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium');
  }

  @Get('four-ball/sessions/:id')
  getFourBall(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getFourBallSession(id, user);
  }

  @Post('four-ball/sessions/:id/select-target')
  selectFourBallTarget(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { target: number; clientMoveId?: string }) {
    return this.games.applyGameAction('four_ball', id, user, { type: 'select_target', payload: { target: Number(body.target) }, clientMoveId: body.clientMoveId });
  }

  @Post('four-ball/sessions/:id/aim')
  aimFourBall(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { angle: number; power?: number; tipX?: number; tipY?: number }) {
    return this.games.applyGameAction('four_ball', id, user, { type: 'aim', payload: { angle: body.angle, power: body.power, tipX: body.tipX, tipY: body.tipY } });
  }

  @Post('four-ball/sessions/:id/shots')
  shootFourBall(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { angle: number; power: number; tipX: number; tipY: number; clientMoveId?: string }) {
    return this.games.applyGameAction('four_ball', id, user, { type: 'shoot', payload: { angle: body.angle, power: body.power, tipX: body.tipX, tipY: body.tipY }, clientMoveId: body.clientMoveId });
  }

  @Post('four-ball/sessions/:id/emotes')
  sendFourBallEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendFourBallEmote(id, user, Number(body.slot));
  }

  @Post('four-ball/sessions/:id/forfeit')
  forfeitFourBall(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitFourBall(id, user);
  }

  @Post('crazy-arcade/sessions')
  createCrazyArcade(@CurrentUser() user: AuthAccount, @Body() body: { opponentAccountId?: string; difficulty?: Difficulty }) {
    return this.games.createCrazyArcadeSession(user, body.opponentAccountId, undefined, body.difficulty ?? 'medium');
  }

  @Get('crazy-arcade/sessions/:id')
  getCrazyArcade(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.getCrazyArcadeSession(id, user);
  }

  @Post('crazy-arcade/sessions/:id/sync')
  syncCrazyArcadeState(
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: { snapshot?: Record<string, unknown>; status?: string; winnerSide?: string | null; finishReason?: string; version?: number },
  ) {
    return this.games.syncCrazyArcadeState(id, user, body);
  }

  @Post('crazy-arcade/sessions/:id/input')
  updateCrazyArcadeInput(
    @Param('id') id: string,
    @CurrentUser() user: AuthAccount,
    @Body() body: Record<string, unknown>,
  ) {
    const { clientMoveId, ...input } = body;
    return this.games.updateCrazyArcadeInput(
      id,
      user,
      input,
      typeof clientMoveId === 'string' ? clientMoveId : undefined,
    );
  }

  @Post('crazy-arcade/sessions/:id/emotes')
  sendCrazyArcadeEmote(@Param('id') id: string, @CurrentUser() user: AuthAccount, @Body() body: { slot: number }) {
    return this.games.sendCrazyArcadeEmote(id, user, Number(body.slot));
  }

  @Post('crazy-arcade/sessions/:id/forfeit')
  forfeitCrazyArcade(@Param('id') id: string, @CurrentUser() user: AuthAccount) {
    return this.games.forfeitCrazyArcade(id, user);
  }
}
