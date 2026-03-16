import { useState, useMemo, useRef } from 'react';
import {
  getValidMoves,
  wallCellsFromSlot,
  isValidWall,
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
  // Tracks the wall slot key ("row,col") selected by a tap — second tap on same key places.
  const [pendingWall, setPendingWall] = useState<string | null>(null);
  // Set in pointerdown for touch; cleared in click. Lets click handler skip for touch
  // (all touch logic lives in handlePointerDown so React's microtask state flushing
  // between touch events and synthesized clicks can't cause races).
  const isTouchRef = useRef(false);

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

  // Pointer down: handles ALL touch input.  pointerType tells us the input
  // device without any timing heuristics.  Mouse pointerdown is ignored here
  // — mouse placement goes through the click handler instead.
  const handlePointerDown = (e: React.PointerEvent, row: number, col: number) => {
    if (e.pointerType !== 'touch' || !isMyTurn) return;
    isTouchRef.current = true;

    const isSquare = row % 2 === 0 && col % 2 === 0;
    if (isSquare) {
      setPendingWall(null);
      setHoveredWall(null);
      if (validMoveSet.has(`${row},${col}`)) onPawnMove(row, col);
    } else if (walls[currentPlayer - 1] > 0) {
      const key = `${row},${col}`;
      if (pendingWall === key) {
        // Second tap on same slot → place the wall
        const cells = wallCellsFromSlot(row, col);
        if (cells && isValidWall(board, cells)) onWallPlace(cells);
        setPendingWall(null);
        setHoveredWall(null);
      } else {
        // First tap (or moved to a different slot) → preview only
        setPendingWall(key);
        const cells = wallCellsFromSlot(row, col);
        setHoveredWall(cells);
      }
    }
  };

  // Click: handles mouse input only.  The synthesized click that follows a
  // touch pointerdown is suppressed via isTouchRef.
  const handleClick = (row: number, col: number) => {
    if (isTouchRef.current) { isTouchRef.current = false; return; }
    if (!isMyTurn) return;

    const isSquare = row % 2 === 0 && col % 2 === 0;
    if (isSquare) {
      if (validMoveSet.has(`${row},${col}`)) onPawnMove(row, col);
    } else if (walls[currentPlayer - 1] > 0) {
      // Mouse: hover already shows the preview — click places immediately
      const cells = wallCellsFromSlot(row, col);
      if (cells && isValidWall(board, cells)) onWallPlace(cells);
    }
  };

  // Mouse hover preview (desktop only; touch devices don't fire real mouseenter)
  const handleWallEnter = (row: number, col: number) => {
    if (!isMyTurn) return;
    const cells = wallCellsFromSlot(row, col);
    if (cells) setHoveredWall(cells);
  };

  const clearPreview = () => { setHoveredWall(null); setPendingWall(null); };

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

  // ── Render ────────────────────────────────────────────────────────────────

  const oppPlayer = (3 - myPlayer) as Player;

  return (
    <>
      <div className="wall-summary">
        <span className={`p${myPlayer}-color`}>You: {walls[myPlayer - 1]}</span>
        <span className="wall-summary-sep">·</span>
        <span className={`p${oppPlayer}-color`}>Opp: {walls[oppPlayer - 1]}</span>
        <span className="wall-summary-label">walls left</span>
      </div>

      {/* onMouseLeave on board clears preview; squares clear it on enter.
          Corners have no handler so crossing them doesn't flicker the preview. */}
      <div className="board-wrap">
        <div className="board-col-labels" aria-hidden="true">
          {['A','B','C','D','E','F','G','H','I'].map(l => (
            <span key={l} className="coord-label">{l}</span>
          ))}
        </div>
        <div className="board-inner">
          <div className="board-row-labels" aria-hidden="true">
            {[1,2,3,4,5,6,7,8,9].map(n => (
              <span key={n} className="coord-label">{n}</span>
            ))}
          </div>
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
                      onPointerDown={(e) => handlePointerDown(e, r, c)}
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
        </div>
      </div>

    </>
  );
}
