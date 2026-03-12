# Code & UX Review — Opus

Reviewed every file in the codebase. Overall this is impressive for a vibe-coded project — the Nostr protocol usage is sound, the game logic is correct, and the UI works. Below are actionable suggestions grouped by priority.

---

## Critical / Bugs

### 1. `searchProfiles` leaks WebSocket connections on rapid typing

Each debounced search opens up to 3 raw WebSocket connections. If the user types fast, old searches aren't cancelled — their WebSockets stay open until EOSE or the 5s timeout. With 400ms debounce and 3 relays, aggressive typing can pile up 15+ dangling sockets.

**Fix:** Track the current search generation with a counter. When a new search starts, increment the counter and have the `finish()` closures for older generations just close without resolving. Or simpler: keep a single persistent WebSocket per search relay (open on first search, reuse thereafter).

**File:** `src/nostr.ts` — `searchOnRelay()` / `searchProfiles()`

### 2. Join code shown to wrong player after invitee-first-move change

Line 844 in App.tsx:
```tsx
{activeEntry.session.myPlayer === 1 && !activeEntry.opponentSeen && (
```
This used to correctly show the join code to the creator (who was always P1). But now with the invitee-first-move change, the creator is P2 for manual invites. So this condition should check whether **I am the creator**, not whether I am P1. The creator is the one who generated the join code and needs to share it.

**Fix:** Either store `isCreator` in the Session type, or derive it: the creator is the one whose pubkey is encoded in the join code. Simplest: add `isCreator: boolean` to `Session` and set it in `doCreate`/`doJoin`.

**File:** `src/App.tsx` — line 844

### 3. No validation of incoming game state from opponent

When receiving an opponent's move via `subscribeToGame`, the decrypted `GameState` is blindly trusted (`JSON.parse(event.content) as GameState`). A malicious opponent could send arbitrary state: move their pawn to the finish, set winner to themselves, give themselves extra walls, etc.

**Fix:** Validate the incoming state against the current state. At minimum:
- `moveNumber` should be exactly `currentState.moveNumber + 1`
- Only one thing changed (one pawn moved or one wall placed)
- The change is a valid move per `getValidMoves` or `isValidWall`
- `winner` is correctly derived from the board

This can be a `validateIncomingState(current, incoming): boolean` function in `game.ts`.

**File:** `src/nostr.ts` — `subscribeToGame()` event handler, `src/game.ts` (new function)

### 4. `handlePawnMove` / `handleWallPlace` duplicate ~40 lines

The two handlers are nearly identical (apply state, optimistic update, publish, rollback on error). This isn't just a style issue — if one gets a bug fix and the other doesn't, they'll diverge.

**Fix:** Extract a shared `handleMove(applyFn: (state) => GameState)` helper.

**File:** `src/App.tsx` — lines 419–483

---

## Important / UX

### 5. Board is not responsive — breaks on mobile

The board is hardcoded at `52px` per square with `8px` wall gaps. Total width: `9 * 52 + 8 * 8 + 28px padding + 16px border = 560px`. Most phones are 360–414px wide.

**Fix:** Use CSS `min()` or `clamp()` for cell sizing, or calculate cell size from `min(viewportWidth, maxSize)` and pass it as a CSS custom property. Something like:
```css
.board {
  --cell: min(52px, (100vw - 120px) / 12.5);
}
.cell.square { width: var(--cell); height: var(--cell); }
.cell.wall-v { width: calc(var(--cell) * 0.15); height: var(--cell); }
```

**File:** `src/App.css` — board section

### 6. No feedback when the opponent hasn't joined yet

After creating a game and sharing the join code, the player sees "Waiting for opponent..." forever with no indication of whether the opponent has even received or opened the code. The `opponentSeen` flag exists but only gates the join code visibility.

**Fix:** Add a subtle "Opponent hasn't connected yet" indicator (distinct from "waiting for their move") when `!opponentSeen`. Maybe a pulsing dot or status line under the join code.

**File:** `src/App.tsx` — playing screen, around line 844

### 7. Abandon should be called "Resign" for a board game

"Abandon" has a connotation of walking away from something broken. In board games the standard term is **Resign** or **Forfeit**. Small UX polish that makes the app feel more like a proper game.

**File:** `src/App.tsx` — all button labels + `confirmAbandon` state name (optional, but the labels definitely)

### 8. No move history or undo indication

There's no way to see what the opponent just did. When you come back to a game and it's your turn, you have no idea what changed. Even a simple "Last move: pawn to E5" or "Last move: wall placed" would help enormously.

**Fix:** Add `lastMove?: { type: 'pawn' | 'wall', description: string }` to `GameState`, populate it in `applyPawnMove` / `applyWallPlace`. Display it above the board.

**File:** `src/game.ts`, `src/App.tsx`

### 9. Wall placement UX is easy to misclick

Walls are only 8px wide — easy to miss on desktop, nearly impossible to tap on mobile. There's no way to "confirm" a wall placement, it happens instantly on click. Misplacing a wall is catastrophic in Quoridor (walls are permanent and limited).

**Fix:** Consider a two-step placement: click to preview/lock, click again (or a "Place" button) to confirm. This also helps on mobile where hover isn't available.

**File:** `src/GameBoard.tsx`

### 10. `useProfile` hook fires on every render when pubkey is null-ish

The hook takes `pubkey: string | null` but the early return for `!pubkey` still creates a new effect closure each render. Minor, but consider using a stable no-op when pubkey is null.

**File:** `src/UserCard.tsx` — `useProfile` hook

---

## Nice-to-Have / Polish

### 11. The game board lacks coordinate labels

Chess and Go boards have rank/file labels (A-I, 1-9). Quoridor players need these to communicate about moves ("wall at E4"). Adding subtle labels on the edges would make the game significantly more readable.

**File:** `src/GameBoard.tsx`, `src/App.css`

### 12. Sound effects for moves

A subtle wood-knock sound when a pawn moves and a wall-thud when a wall is placed would add a lot of game feel. Use the Web Audio API with a short generated tone to avoid loading audio files.

**File:** New utility, called from `GameBoard.tsx`

### 13. Pawn movement animation

Pawns currently teleport between cells. A brief CSS transition (100–200ms) would make the game feel much smoother. Since pawns are `::after` pseudo-elements, this could be tricky — might need to switch to actual elements.

**File:** `src/App.css`, possibly `src/GameBoard.tsx`

### 14. App.tsx is 875 lines — should be split

The component does connection management, matchmaking, game logic orchestration, timeout checking, notifications, move publishing, and rendering 5 different screens. Consider extracting:
- `useNostrConnection()` — connection + resume logic
- `useGameManager()` — games state, subscriptions, move handlers
- `useMatchmaking()` — seek/invite state
- `LobbyScreen`, `PlayingScreen`, `ConnectScreen` — separate components

**File:** `src/App.tsx`

### 15. Dark mode is the only mode

The warm brown theme looks great, but users on bright screens outdoors will struggle. Consider adding a light theme variant (even if it's not a priority now, using CSS custom properties for all colors would make it trivial later).

**File:** `src/App.css`, `src/index.css`

### 16. `profileCache` never expires

The `Map<string, UserProfile>` in `nostr.ts` grows forever within a session. If someone changes their display name or picture, you'll never see the update. Consider a TTL (5–10 min) or a max cache size with LRU eviction.

**File:** `src/nostr.ts` — `profileCache`

### 17. CORS proxy is a single point of failure

NIP-05 verification goes through `corsproxy.io`. If it's down, all NIP-05 shows as unverified. Consider trying the direct fetch first (some domains do set CORS headers), then falling back to the proxy.

**File:** `src/nostr.ts` — `verifyNip05()`

### 18. `NDKSubscription` import only used for type

Line 31 of App.tsx imports `NDKSubscription` from `@nostr-dev-kit/ndk` just for the `subsRef` and `seekSubRef` type annotations. This works but could use `import type` to make it clear and ensure it's tree-shaken.

**File:** `src/App.tsx` — line 31

### 19. `game.ts` wall encoding overloads the value `1`

In the board array, `1` means both "player 1's pawn" and "wall present". This works because pawns are on even-indexed cells and walls on odd-indexed cells, so there's no ambiguity. But it's a trap for anyone reading the code. Consider using a named constant like `WALL = 1` and `P1 = 1` — or better, distinct values (e.g., `WALL = -1`).

**File:** `src/game.ts`

### 20. The "declare yourself the winner" timeout has no actual button

The timeout banner says "You may declare yourself the winner" but there's no button to actually do it. The user has to figure out that "Abandon" does the opposite. There should be a "Claim win" button in the timeout banner.

**File:** `src/App.tsx` — timeout banner section (around line 856)

---

## Summary

The top 5 things I'd fix first:
1. **Join code shown to wrong player** (#2) — this is a regression from the invitee-first-move change
2. **Board responsiveness** (#5) — unplayable on mobile
3. **Validate incoming state** (#3) — trust-but-verify for P2P games
4. **WebSocket leak in search** (#1) — real resource leak under normal usage
5. **Rename Abandon to Resign + add Claim Win button** (#7 + #20) — quick UX wins
