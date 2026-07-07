import { GameDescriptor, GameEngine } from './game-engine';
import { ALKKAGI_ENGINE } from '../alkkagi-engine';
import { CRAZY_ARCADE_ENGINE } from '../crazy-arcade-engine';
import { FORTRESS_ENGINE } from '../fortress-engine';
import { GOMOKU_ENGINE } from '../gomoku-engine';
import { MIGHTY_ENGINE } from '../mighty-engine';
import { OTHELLO_ENGINE } from '../othello-engine';
import { SOKOBAN_ENGINE } from '../sokoban-engine';
import { SPLENDOR_ENGINE } from '../splendor-engine';
import { SUDOKU_ENGINE } from '../sudoku-engine';

export const GAME_ENGINES = [
  SUDOKU_ENGINE,
  GOMOKU_ENGINE,
  ALKKAGI_ENGINE,
  OTHELLO_ENGINE,
  SOKOBAN_ENGINE,
  SPLENDOR_ENGINE,
  FORTRESS_ENGINE,
  CRAZY_ARCADE_ENGINE,
  MIGHTY_ENGINE,
];

export const GAME_DESCRIPTORS: GameDescriptor[] = [
  SUDOKU_ENGINE.descriptor,
  GOMOKU_ENGINE.descriptor,
  ALKKAGI_ENGINE.descriptor,
  OTHELLO_ENGINE.descriptor,
  SOKOBAN_ENGINE.descriptor,
  SPLENDOR_ENGINE.descriptor,
  FORTRESS_ENGINE.descriptor,
  CRAZY_ARCADE_ENGINE.descriptor,
  MIGHTY_ENGINE.descriptor,
];

export class GameRegistry {
  private readonly descriptorsByKey = new Map(
    GAME_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]),
  );
  private readonly enginesByKey = new Map(
    GAME_ENGINES.map((engine) => [engine.descriptor.key, engine as GameEngine<unknown>]),
  );

  list(): GameDescriptor[] {
    return GAME_DESCRIPTORS.map(cloneDescriptor);
  }

  get(key: string): GameDescriptor | undefined {
    const descriptor = this.descriptorsByKey.get(key);
    return descriptor ? cloneDescriptor(descriptor) : undefined;
  }

  engine(key: string): GameEngine<unknown> | undefined {
    return this.enginesByKey.get(key);
  }

  require(key: string): GameDescriptor {
    const descriptor = this.get(key);
    if (!descriptor) {
      throw new Error(`Unknown game key: ${key}`);
    }
    return descriptor;
  }

  has(key: string): boolean {
    return this.descriptorsByKey.has(key);
  }

  supportsMode(key: string, mode: GameDescriptor['modes'][number]): boolean {
    return this.descriptorsByKey.get(key)?.modes.includes(mode) ?? false;
  }

  supportsMatchSave(key: string): boolean {
    return this.descriptorsByKey.get(key)?.supportsMatchSave === true;
  }

  playerBounds(key: string): { minPlayers: number; maxPlayers: number } | undefined {
    const descriptor = this.descriptorsByKey.get(key);
    return descriptor
      ? { minPlayers: descriptor.minPlayers, maxPlayers: descriptor.maxPlayers }
      : undefined;
  }
}

function cloneDescriptor(descriptor: GameDescriptor): GameDescriptor {
  return {
    ...descriptor,
    modes: [...descriptor.modes],
  };
}

export const GAME_REGISTRY = new GameRegistry();

export function gameDescriptorFor(key: string): GameDescriptor | undefined {
  return GAME_REGISTRY.get(key);
}

export function assertKnownGameKey(key: string): GameDescriptor {
  return GAME_REGISTRY.require(key);
}
