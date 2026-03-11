// ─── Constants ───────────────────────────────────────────────────────────────

export const BOARD_SIZE = 9;
export const GRID = BOARD_SIZE * 2 - 1;          // 17
export const CENTER_COL = BOARD_SIZE - 1;          // 8  (cell col 4)
export const WALLS_PER_PLAYER = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

export type Player = 1 | 2;
export type Board = number[][];

export interface GameState {
  board: Board;
  currentPlayer: Player;
  walls: [number, number];   // walls remaining [p1, p2]
  winner: Player | null;
  moveNumber: number;        // used to discard stale Nostr events
}

// ─── State helpers ────────────────────────────────────────────────────────────

export function createInitialState(): GameState {
  return {
    board: Array.from({ length: GRID }, (_, r) =>
      Array.from({ length: GRID }, (_, c) => {
        if (r === 0 && c === CENTER_COL) return 1;
        if (r === GRID - 1 && c === CENTER_COL) return 2;
        return 0;
      })
    ),
    currentPlayer: 1,
    walls: [WALLS_PER_PLAYER, WALLS_PER_PLAYER],
    winner: null,
    moveNumber: 0,
  };
}

// ─── Board queries ────────────────────────────────────────────────────────────

/** Scan only even-indexed positions (player cells, never wall slots). */
export function findPlayer(board: Board, player: Player): [number, number] {
  for (let r = 0; r < GRID; r += 2)
    for (let c = 0; c < GRID; c += 2)
      if (board[r][c] === player) return [r, c];
  throw new Error(`Player ${player} not found`);
}

export function getValidMoves(board: Board, player: Player): [number, number][] {
  const [pr, pc] = findPlayer(board, player);
  const opp = (3 - player) as Player;
  const moves: [number, number][] = [];

  for (const [dr, dc] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as [number, number][]) {
    const wr = pr + dr / 2, wc = pc + dc / 2;
    const tr = pr + dr,     tc = pc + dc;

    if (tr < 0 || tr >= GRID || tc < 0 || tc >= GRID) continue;
    if (board[wr][wc] === 1) continue; // wall

    if (board[tr][tc] === opp) {
      // Straight jump
      const jr = tr + dr, jc = tc + dc;
      const jwr = tr + dr / 2, jwc = tc + dc / 2;
      if (jr >= 0 && jr < GRID && jc >= 0 && jc < GRID && board[jwr][jwc] !== 1) {
        moves.push([jr, jc]);
      } else {
        // Diagonal jumps
        const perps: [number, number][] = dr !== 0 ? [[0, -2], [0, 2]] : [[-2, 0], [2, 0]];
        for (const [ldr, ldc] of perps) {
          const diagR = tr + ldr, diagC = tc + ldc;
          const dwr = tr + ldr / 2, dwc = tc + ldc / 2;
          if (diagR >= 0 && diagR < GRID && diagC >= 0 && diagC < GRID && board[dwr][dwc] !== 1)
            moves.push([diagR, diagC]);
        }
      }
    } else if (board[tr][tc] === 0) {
      moves.push([tr, tc]);
    }
  }
  return moves;
}

export function checkWinner(board: Board): Player | null {
  for (let c = 0; c < GRID; c += 2) {
    if (board[GRID - 1][c] === 1) return 1;
    if (board[0][c] === 2) return 2;
  }
  return null;
}

/** BFS over wall structure only — ignores pawn positions. */
export function hasPath(board: Board, player: Player): boolean {
  const [startR, startC] = findPlayer(board, player);
  const goalRow = player === 1 ? GRID - 1 : 0;
  const visited = new Set<string>([`${startR},${startC}`]);
  const queue: [number, number][] = [[startR, startC]];

  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    if (r === goalRow) return true;
    for (const [dr, dc] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as [number, number][]) {
      const wr = r + dr / 2, wc = c + dc / 2;
      const nr = r + dr,     nc = c + dc;
      if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
      if (board[wr][wc] === 1) continue;
      const key = `${nr},${nc}`;
      if (!visited.has(key)) { visited.add(key); queue.push([nr, nc]); }
    }
  }
  return false;
}

/**
 * Given a wall-slot click, returns the 3 board cells the wall spans
 * [slot, corner, slot], or null for non-slot positions.
 * Always clamps so the wall stays in bounds.
 */
export function wallCellsFromSlot(row: number, col: number): [number, number][] | null {
  if (row % 2 === 1 && col % 2 === 0) {         // horizontal slot
    const s = Math.min(col, GRID - 3);
    return [[row, s], [row, s + 1], [row, s + 2]];
  }
  if (row % 2 === 0 && col % 2 === 1) {         // vertical slot
    const s = Math.min(row, GRID - 3);
    return [[s, col], [s + 1, col], [s + 2, col]];
  }
  return null;
}

export function isValidWall(board: Board, cells: [number, number][]): boolean {
  for (const [r, c] of cells) if (board[r][c] !== 0) return false;
  const test = board.map(r => [...r]);
  for (const [r, c] of cells) test[r][c] = 1;
  return hasPath(test, 1) && hasPath(test, 2);
}

// ─── Move application ─────────────────────────────────────────────────────────

export function applyPawnMove(state: GameState, row: number, col: number): GameState {
  const newBoard = state.board.map(r => [...r]);
  const [pr, pc] = findPlayer(state.board, state.currentPlayer);
  newBoard[pr][pc] = 0;
  newBoard[row][col] = state.currentPlayer;
  const winner = checkWinner(newBoard);
  return {
    board: newBoard,
    currentPlayer: winner ? state.currentPlayer : (3 - state.currentPlayer) as Player,
    walls: state.walls,
    winner,
    moveNumber: state.moveNumber + 1,
  };
}

export function applyWallPlace(state: GameState, cells: [number, number][]): GameState {
  const newBoard = state.board.map(r => [...r]);
  for (const [r, c] of cells) newBoard[r][c] = 1;
  const newWalls: [number, number] = [state.walls[0], state.walls[1]];
  newWalls[state.currentPlayer - 1]--;
  return {
    board: newBoard,
    currentPlayer: (3 - state.currentPlayer) as Player,
    walls: newWalls,
    winner: null,
    moveNumber: state.moveNumber + 1,
  };
}
