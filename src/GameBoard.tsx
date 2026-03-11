import { useState, useMemo } from 'react';
import {
  getValidMoves,
  wallCellsFromSlot,
  isValidWall,
  WALLS_PER_PLAYER,
  GRID,
  type GameState,
  type Player,
} from './game';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  state: GameState;
  myPlayer: Player;
  onPawnMove: (row: number, col: number) => void;
  onWallPlace: (cells: [number, number][]) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GameBoard({ state, myPlayer, onPawnMove, onWallPlace }: Props) {
  const { board, currentPlayer, walls, winner } = state;
  const isMyTurn = !winner && currentPlayer === myPlayer;
  const [hoveredWall, setHoveredWall] = useState<[number, number][] | null>(null);

  // Valid pawn moves (only computed when it's my turn)
  const validMoveSet = useMemo<Set<string>>(() => {
    if (!isMyTurn) return new Set();
    return new Set(getValidMoves(board, currentPlayer).map(([r, c]) => `${r},${c}`));
  }, [board, currentPlayer, isMyTurn]);

  // Wall hover preview
  const wallPreview = useMemo(() => {
    const empty = { cells: new Set<string>(), valid: false };
    if (!hoveredWall || !isMyTurn || walls[currentPlayer - 1] === 0) return empty;
    return {
      cells: new Set(hoveredWall.map(([r, c]) => `${r},${c}`)),
      valid: isValidWall(board, hoveredWall),
    };
  }, [hoveredWall, board, currentPlayer, walls, isMyTurn]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleClick = (row: number, col: number) => {
    if (!isMyTurn) return;
    const isSquare = row % 2 === 0 && col % 2 === 0;
    if (isSquare) {
      if (validMoveSet.has(`${row},${col}`)) onPawnMove(row, col);
    } else {
      if (wallPreview.valid && hoveredWall) onWallPlace(hoveredWall);
    }
  };

  const handleWallEnter = (row: number, col: number) => {
    if (!isMyTurn) return;
    setHoveredWall(wallCellsFromSlot(row, col));
  };

  const clearPreview = () => setHoveredWall(null);

  // ── CSS class builder ─────────────────────────────────────────────────────

  const getCellClass = (row: number, col: number): string => {
    const evenR = row % 2 === 0, evenC = col % 2 === 0;
    const val = board[row][col];
    const key = `${row},${col}`;
    const cls: string[] = ['cell'];

    if (evenR && evenC) {
      cls.push('square');
      if (val === 1) cls.push('p1');
      else if (val === 2) cls.push('p2');
      else if (validMoveSet.has(key)) cls.push('hint');
    } else if (evenR && !evenC) {
      cls.push('wall-v');
      if (val === 1) cls.push('wall-placed');
      else if (wallPreview.cells.has(key))
        cls.push(wallPreview.valid ? 'wall-preview' : 'wall-preview-bad');
    } else if (!evenR && evenC) {
      cls.push('wall-h');
      if (val === 1) cls.push('wall-placed');
      else if (wallPreview.cells.has(key))
        cls.push(wallPreview.valid ? 'wall-preview' : 'wall-preview-bad');
    } else {
      cls.push('corner');
      if (val === 1) cls.push('wall-placed');
      else if (wallPreview.cells.has(key))
        cls.push(wallPreview.valid ? 'wall-preview' : 'wall-preview-bad');
    }

    return cls.join(' ');
  };

  // ── Wall pip indicator ────────────────────────────────────────────────────

  const WallPips = ({ player }: { player: Player }) => (
    <div className="wall-pips">
      {Array.from({ length: WALLS_PER_PLAYER }, (_, i) => (
        <span key={i} className={`pip ${i < walls[player - 1] ? `pip-p${player}` : 'pip-used'}`} />
      ))}
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="wall-counts">
        {([1, 2] as Player[]).map(p => (
          <div key={p} className="wall-row">
            <span className={`p${p}-color wall-label`}>P{p}{p === myPlayer ? ' (you)' : ''}</span>
            <WallPips player={p} />
            <span className="wall-num">{walls[p - 1]}</span>
          </div>
        ))}
      </div>

      {/* onMouseLeave on board clears preview; squares clear it on enter.
          Corners have no handler so crossing them doesn't flicker the preview. */}
      <div className="board" onMouseLeave={clearPreview}>
        {Array.from({ length: GRID }, (_, r) => (
          <div key={r} className="row">
            {Array.from({ length: GRID }, (_, c) => {
              const isSquare = r % 2 === 0 && c % 2 === 0;
              const isWallSlot = r % 2 !== c % 2;
              return (
                <div
                  key={c}
                  className={getCellClass(r, c)}
                  onClick={() => handleClick(r, c)}
                  onMouseEnter={
                    isWallSlot ? () => handleWallEnter(r, c) :
                    isSquare   ? clearPreview :
                    undefined
                  }
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className="legend">
        <span className="p1-color">● P1</span> reaches bottom &nbsp;·&nbsp;
        <span className="p2-color">● P2</span> reaches top &nbsp;·&nbsp;
        hover wall gaps to preview
      </div>
    </>
  );
}
