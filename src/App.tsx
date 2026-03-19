import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';
import './App.css';
import { GameBoard } from './GameBoard';
import {
  createInitialState,
  applyPawnMove,
  applyWallPlace,
  diffBoards,
  type GameState,
  type Player,
  type OpponentMove,
} from './game';
import {
  connectWithExtension,
  connectWithTempKey,
  connectWithSavedKey,
  connectWithNsec,
  nsecHexToBech32,
  fetchLatestGameState,
  pubkeyFromNpub,
  npubFromPubkey,
  publishMove,
  publishProfile,
  subscribeToGame,
  publishSeek,
  cancelSeek,
  subscribeToSeekList,
  cancelOwnStaleSeeks,
  publishInvite,
  subscribeToInvites,
  reconnectRelays,
  type SeekListEntry,
} from './nostr';
import { UserCard, useProfile } from './UserCard';
import { PlayerSearch } from './PlayerSearch';
import { savedKey, savedSessions } from './storage';
import type { NDKSubscription } from '@nostr-dev-kit/ndk';

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// crypto.randomUUID() requires a secure context (HTTPS/localhost).
// Fall back to a Math.random UUID for plain HTTP (e.g. LAN dev).
function randomUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'disconnected' | 'resume-prompt' | 'reconnecting' | 'connecting' | 'lobby' | 'playing';

interface SeekEntry {
  id: string;         // local UUID, used as d-tag suffix and React key
  eventId: string | null; // Nostr event id (null while publishing)
  refreshIntervalId: ReturnType<typeof setInterval> | null;
}

interface Session {
  myPubkey: string;
  opponentPubkey: string;
  gameId: string;
  myPlayer: Player;
  lastEventId: string | null;
  joinCode: string;
  isCreator: boolean;
}

interface GameEntry {
  session: Session;
  gameState: GameState;
  opponentSeen: boolean;          // true once we receive the first event from the opponent
  finishReason?: 'timeout' | 'resign' | 'no-contest';
  opponentLastMove?: OpponentMove;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function OpponentName({ pubkey }: { pubkey: string }) {
  const profile = useProfile(pubkey);
  return <>{profile?.displayName ?? 'Opponent'}</>;
}

// ─── Seek list helpers ────────────────────────────────────────────────────────

function relTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function SeekRow({ entry, onMatch }: { entry: SeekListEntry; onMatch: () => void }) {
  const [clicked, setClicked] = React.useState(false);
  return (
    <div className="seek-row">
      <div className="seek-row-info">
        <UserCard pubkey={entry.pubkey} size="sm" />
        <span className="seek-row-time">{relTime(entry.createdAt)}</span>
      </div>
      <button
        className="btn btn-small btn-primary"
        disabled={clicked}
        onClick={() => { setClicked(true); onMatch(); }}
      >
        Play
      </button>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Core state ─────────────────────────────────────────────────────────────

  const [phase, setPhase] = useState<Phase>('disconnected');
  const [error, setError] = useState('');
  const [myPubkey, setMyPubkey] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(false);

  const makeFunnyName = () => uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals],
    style: 'capital',
    separator: '',
  });
  const [anonName, setAnonName] = useState(makeFunnyName);

  // All active games, keyed by gameId.
  const [games, setGames] = useState<Record<string, GameEntry>>({});
  const [highlightKey, setHighlightKey] = useState(0);
  const gamesRef = useRef<Record<string, GameEntry>>({});
  gamesRef.current = games;

  // Which game is currently being viewed on the playing screen.
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const activeGameIdRef = useRef<string | null>(null);
  activeGameIdRef.current = activeGameId;

  // One subscription per game.
  const subsRef = useRef<Map<string, NDKSubscription>>(new Map());

  // ── Matchmaking state ───────────────────────────────────────────────────────
  const [seeks, setSeeks] = useState<SeekEntry[]>([]);
  const seeksRef            = useRef<SeekEntry[]>([]);
  seeksRef.current = seeks;
  const availableSeekIdsRef = useRef<Set<string>>(new Set());
  const inviteSubRef        = useRef<NDKSubscription | null>(null);

  // Seek list (live, keyed by pubkey for easy upsert).
  const [seekList, setSeekList] = useState<Record<string, SeekListEntry>>({});
  const seekListSubRef = useRef<NDKSubscription | null>(null);
  const [seekPage, setSeekPage] = useState(0);

  // ── Lobby form state ────────────────────────────────────────────────────────

  const [lobbySection, setLobbySection] = useState<'active' | 'new' | 'history'>(
    Object.keys(savedSessions.load()).length > 0 ? 'active' : 'new'
  );
  const [newGameTab, setNewGameTab] = useState<'create' | 'join'>('create');
  const [selectedOpponentPubkey, setSelectedOpponentPubkey] = useState<string | null>(null);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [confirmAbandon, setConfirmAbandon] = useState<string | null>(null); // gameId pending confirm
  const [copiedId, setCopiedId] = useState<string | null>(null); // tracks which button shows "Copied!"
  const [showNsecInput, setShowNsecInput] = useState(false);
  const [nsecInput, setNsecInput] = useState('');
  const [showNsecReveal, setShowNsecReveal] = useState(false);

  const nsecBech32 = useMemo(() => {
    if (!showNsecReveal) return '';
    const sk = savedKey.load();
    return sk?.nsecHex ? nsecHexToBech32(sk.nsecHex) : '';
  }, [showNsecReveal]);

  const copyWithFeedback = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(prev => prev === id ? null : prev), 1500);
  }, []);

  // ── Timeout ─────────────────────────────────────────────────────────────────

  // ── Cleanup all subscriptions on unmount ────────────────────────────────────

  useEffect(() => () => {
    subsRef.current.forEach(sub => sub.stop());
    inviteSubRef.current?.stop();
    seekListSubRef.current?.stop();
    for (const seek of seeksRef.current) {
      if (seek.refreshIntervalId !== null) clearInterval(seek.refreshIntervalId);
      if (seek.eventId) cancelSeek(seek.eventId);
    }
  }, []);

  // ── Notifications ───────────────────────────────────────────────────────────

  const requestNotifyPermission = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  };

  const notifyTurn = (gameId: string) => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    new Notification('Quoridor — your turn!', {
      body: 'Your opponent has moved.',
      tag: `quoridor-${gameId}`,
    });
  };

  // Auto-resolve a single timed-out game.
  const resolveTimeout = useCallback(async (gameId: string) => {
    const entry = gamesRef.current[gameId];
    if (!entry || entry.gameState.winner || entry.finishReason === 'no-contest') return;
    const { session, gameState } = entry;

    const isNoContest = gameState.moveNumber === 0;

    const ss = savedSessions.load()[gameId];
    subsRef.current.get(gameId)?.stop();
    subsRef.current.delete(gameId);

    if (isNoContest) {
      // No moves were made — mark as no contest locally.
      setGames(prev => ({ ...prev, [gameId]: { ...prev[gameId], finishReason: 'no-contest' } }));
      if (ss) savedSessions.upsert({ ...ss, finishReason: 'no-contest' });
    } else {
      // Opponent timed out — auto-win.
      const win: GameState = { ...gameState, winner: session.myPlayer };
      try {
        await publishMove({
          gameId,
          p1Pubkey: session.myPlayer === 1 ? session.myPubkey : session.opponentPubkey,
          p2Pubkey: session.myPlayer === 1 ? session.opponentPubkey : session.myPubkey,
          myPlayer: session.myPlayer,
          prevEventId: session.lastEventId,
          state: win,
        });
      } catch { /* best-effort */ }
      setGames(prev => ({ ...prev, [gameId]: { ...prev[gameId], gameState: win, finishReason: 'timeout' } }));
      if (ss) savedSessions.upsert({ ...ss, finishReason: 'timeout' });
    }

    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(isNoContest ? 'Quoridor — game expired' : 'Quoridor — you win by timeout!', {
        body: isNoContest ? 'No moves were made. Game marked as no contest.' : 'Your opponent did not move in time.',
        tag: `quoridor-timeout-${gameId}`,
      });
    }
  }, []);

  // Periodically check all games for timeouts.
  const checkAllTimeouts = useCallback(() => {
    const all = savedSessions.load();
    for (const [gameId, entry] of Object.entries(gamesRef.current)) {
      const { session, gameState } = entry;
      if (gameState.winner || entry.finishReason === 'no-contest') continue;
      if (gameState.currentPlayer === session.myPlayer) continue;
      const ss = all[gameId];
      if (!ss?.lastMoveAt) continue;
      if (Date.now() - ss.lastMoveAt < TIMEOUT_MS) continue;
      void resolveTimeout(gameId);
    }
  }, [resolveTimeout]);

  // Run periodic timeout check while connected.
  useEffect(() => {
    if (phase !== 'lobby' && phase !== 'playing') return;
    checkAllTimeouts(); // run immediately on connect
    const id = setInterval(checkAllTimeouts, 60_000);
    return () => clearInterval(id);
  }, [phase, checkAllTimeouts]);

  // Refetch game state for all active games when the tab comes back into focus.
  // Mobile browsers suspend WebSocket connections in the background, so moves
  // published while the tab was hidden are missed by the subscription.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'lobby') return;
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;

      // Re-establish WebSocket connections that the browser may have killed
      // while the tab was backgrounded.
      reconnectRelays();

      // Re-subscribe to all active games and fetch latest state in parallel.
      const activeEntries = Object.values(gamesRef.current)
        .filter(entry => !entry.gameState.winner && !entry.finishReason);

      for (const { session } of activeEntries) {
        addSubscription(session.gameId, session.myPlayer, session.opponentPubkey);
      }

      const results = await Promise.allSettled(
        activeEntries.map(({ session }) =>
          fetchLatestGameState(session.gameId, session.myPubkey, session.opponentPubkey)
            .then(result => result ? { gameId: session.gameId, result } : null)
        ),
      );

      for (const settled of results) {
        if (settled.status !== 'fulfilled' || !settled.value) continue;
        const { gameId, result } = settled.value;
        setGames(prev => {
          const e = prev[gameId];
          if (!e) return prev;
          if (result.state.moveNumber <= e.gameState.moveNumber) return prev;
          const movedBy = e.gameState.currentPlayer;
          const opponentLastMove = diffBoards(e.gameState.board, result.state.board, movedBy) ?? e.opponentLastMove;
          return { ...prev, [gameId]: { ...e, gameState: result.state, opponentSeen: true, opponentLastMove } };
        });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [phase]); // addSubscription is stable (useCallback with [] deps)

  // Subscribe to seek list while in lobby.
  useEffect(() => {
    if (phase !== 'lobby' || !myPubkey) return;
    setSeekList({});
    setSeekPage(0);

    // Cancel any orphaned seek events left by closed/reloaded tabs, but only when
    // we have no actively-tracked seek of our own (avoids cancelling a live one).
    if (seeksRef.current.length === 0) {
      cancelOwnStaleSeeks(myPubkey).catch(() => {});
    }

    seekListSubRef.current = subscribeToSeekList(entry => {
      setSeekList(prev => ({ ...prev, [entry.pubkey]: entry }));
    });
    return () => { seekListSubRef.current?.stop(); seekListSubRef.current = null; };
  }, [phase, myPubkey]);

  // ── Subscribe helper ────────────────────────────────────────────────────────

  const addSubscription = useCallback((gameId: string, myPlayer: Player, opponentPubkey: string) => {
    subsRef.current.get(gameId)?.stop();

    const sub = subscribeToGame(
      gameId,
      opponentPubkey,
      myPlayer,
      () => gamesRef.current[gameId]?.gameState ?? null,
      (incoming) => {
        setGames(prev => {
          const entry = prev[gameId];
          if (!entry) return prev;
          const isForfeit = incoming.moveNumber === entry.gameState.moveNumber && incoming.winner !== null;
          if (!isForfeit && incoming.moveNumber <= entry.gameState.moveNumber) return prev;
          const all = savedSessions.load();
          if (all[gameId]) savedSessions.upsert({
            ...all[gameId],
            lastMoveAt: Date.now(),
          });
          const movedBy = entry.gameState.currentPlayer;
          const opponentLastMove =
            diffBoards(entry.gameState.board, incoming.board, movedBy) ?? entry.opponentLastMove;
          return { ...prev, [gameId]: { ...entry, gameState: incoming, opponentSeen: true, opponentLastMove } };
        });
        if (incoming.currentPlayer === myPlayer) {
          notifyTurn(gameId);
          setHighlightKey(k => k + 1);
        }
      },
    );

    subsRef.current.set(gameId, sub);
  }, []);

  // ── Matchmaking ─────────────────────────────────────────────────────────────

  // Stop and clean up seek subscriptions (not the seek events themselves).
  const stopSeekSubscriptions = useCallback(() => {
    inviteSubRef.current?.stop();
    inviteSubRef.current = null;
  }, []);

  const clearSeekRefresh = useCallback((slot: SeekEntry) => {
    if (slot.refreshIntervalId !== null) clearInterval(slot.refreshIntervalId);
  }, []);

  // Claim one available seek slot; returns the full SeekEntry or null if none left.
  // With targetId: claims that specific seek (invite path).
  // Without targetId: claims any available seek (creator path).
  const claimSeekSlot = useCallback((targetId?: string): SeekEntry | null => {
    const id = targetId !== undefined
      ? (availableSeekIdsRef.current.has(targetId) ? targetId : undefined)
      : availableSeekIdsRef.current.values().next().value;
    if (id === undefined) return null;
    availableSeekIdsRef.current.delete(id);
    const entry = seeksRef.current.find(s => s.id === id) ?? { id, eventId: null, refreshIntervalId: null };
    if (entry.refreshIntervalId !== null) clearInterval(entry.refreshIntervalId);
    setSeeks(prev => prev.filter(s => s.id !== id));
    if (availableSeekIdsRef.current.size === 0) stopSeekSubscriptions();
    return entry;
  }, [stopSeekSubscriptions]);

  // Start invite subscription (only called when first seek is added).
  const startSeekSubscriptions = useCallback(() => {
    // When someone invites us (they are P1, we are P2) — auto-join their game.
    inviteSubRef.current = subscribeToInvites(myPubkey, async (joinCode, _inviter, seekDTag) => {
      // Extract the local seek id from the d-tag (strip 'quoridor-seek-' prefix if present).
      // Reject invites that don't reference a specific seek — prevents old invite events
      // (which have empty seekDTag) from claiming a brand-new seek slot.
      if (!seekDTag) return;
      const seekId = seekDTag.startsWith('quoridor-seek-')
        ? seekDTag.slice('quoridor-seek-'.length)
        : seekDTag;
      if (!seekId) return;
      const slot = claimSeekSlot(seekId);
      if (!slot) return;
      clearSeekRefresh(slot);
      if (slot.eventId) cancelSeek(slot.eventId);
      await doJoin(joinCode);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPubkey, claimSeekSlot, clearSeekRefresh]);

  const handleAddSeek = async () => {
    if (seeksRef.current.length >= 1) return;
    setError('');
    await requestNotifyPermission();

    const id = randomUUID();
    const entry: SeekEntry = { id, eventId: null, refreshIntervalId: null };
    availableSeekIdsRef.current.add(id);
    setSeeks(prev => [...prev, entry]);

    // Start subscriptions only when adding the very first seek.
    if (seeksRef.current.length === 0) startSeekSubscriptions();

    try {
      const eventId = await publishSeek(id);
      setSeeks(prev => prev.map(s => s.id === id ? { ...s, eventId } : s));

      // Refresh the seek every 2 minutes so it stays near the top of seekers' lists.
      const refreshIntervalId = setInterval(async () => {
        try {
          const newEventId = await publishSeek(id);
          setSeeks(prev => prev.map(s => s.id === id ? { ...s, eventId: newEventId } : s));
        } catch { /* best-effort */ }
      }, 2 * 60 * 1000);
      setSeeks(prev => prev.map(s => s.id === id ? { ...s, refreshIntervalId } : s));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to publish seek');
      availableSeekIdsRef.current.delete(id);
      setSeeks(prev => prev.filter(s => s.id !== id));
      if (availableSeekIdsRef.current.size === 0) stopSeekSubscriptions();
    }
  };

  const handleCancelSeek = useCallback((id: string) => {
    availableSeekIdsRef.current.delete(id);
    const seek = seeksRef.current.find(s => s.id === id);
    if (seek?.refreshIntervalId !== undefined && seek.refreshIntervalId !== null) clearInterval(seek.refreshIntervalId);
    if (seek?.eventId) cancelSeek(seek.eventId);
    setSeeks(prev => prev.filter(s => s.id !== id));
    if (availableSeekIdsRef.current.size === 0) stopSeekSubscriptions();
  }, [stopSeekSubscriptions]);

  // Shared helpers used by both manual lobby and matchmaking.

  // creatorPlayer = 1 for random-seek games (creator moves first),
  //               = 2 for manual invites (invitee moves first).
  const doCreate = async (opponentPubkey: string, creatorPlayer: 1 | 2 = 2, opponentSeekDTag?: string) => {
    const gameId = randomUUID();
    const initial = createInitialState();
    // Encode creator's player number so the joiner can derive theirs.
    const code = `${gameId}:${npubFromPubkey(myPubkey)}:${creatorPlayer}`;

    const p1Pubkey = creatorPlayer === 1 ? myPubkey : opponentPubkey;
    const p2Pubkey = creatorPlayer === 1 ? opponentPubkey : myPubkey;

    addSubscription(gameId, creatorPlayer, opponentPubkey);
    try {
      const eventId = await publishMove({
        gameId,
        p1Pubkey,
        p2Pubkey,
        myPlayer: creatorPlayer,
        prevEventId: null,
        state: initial,
      });
      await publishInvite(opponentPubkey, gameId, code, opponentSeekDTag ?? '');

      const session: Session = { myPubkey, opponentPubkey, gameId, myPlayer: creatorPlayer, lastEventId: eventId, joinCode: code, isCreator: true };
      setGames(prev => ({ ...prev, [gameId]: { session, gameState: initial, opponentSeen: false } }));
      savedSessions.upsert({ gameId, myPubkey, opponentPubkey, myPlayer: creatorPlayer, joinCode: code, lastMoveAt: Date.now() });
      setActiveGameId(gameId);
      setPhase('playing');
    } catch (e) {
      subsRef.current.get(gameId)?.stop();
      subsRef.current.delete(gameId);
      setError(e instanceof Error ? e.message : 'Failed to create game');
    }
  };

  const doJoin = async (joinCodeStr: string) => {
    const parts = joinCodeStr.split(':');
    if (parts.length < 2) { setError('Invalid join code received'); return; }
    const gameId = parts[0].trim();
    const creatorNpubRaw = parts[1].trim();
    // Third segment is creator's player number; default to 1 for old codes.
    const creatorPlayer = parts[2] === '2' ? 2 : 1;
    const myPlayer = (3 - creatorPlayer) as 1 | 2;

    if (games[gameId]) { setActiveGameId(gameId); setPhase('playing'); return; }

    let creatorPubkey: string;
    try { creatorPubkey = pubkeyFromNpub(creatorNpubRaw); }
    catch { setError('Received malformed join code'); return; }

    addSubscription(gameId, myPlayer, creatorPubkey);
    const session: Session = { myPubkey, opponentPubkey: creatorPubkey, gameId, myPlayer, lastEventId: null, joinCode: joinCodeStr, isCreator: false };
    setGames(prev => ({ ...prev, [gameId]: { session, gameState: createInitialState(), opponentSeen: false } }));
    savedSessions.upsert({ gameId, myPubkey, opponentPubkey: creatorPubkey, myPlayer, joinCode: joinCodeStr, lastMoveAt: Date.now() });
    setActiveGameId(gameId);
    setPhase('playing');
  };

  const handlePickSeeker = async (seeker: SeekListEntry) => {
    setError('');
    for (const seek of seeksRef.current) handleCancelSeek(seek.id);
    await requestNotifyPermission();
    await doCreate(seeker.pubkey, 1, seeker.dTag); // picker is P1, moves first
  };

  // ── Connect handlers ────────────────────────────────────────────────────────

  const handleConnect = async (withExtension: boolean, displayName?: string) => {
    setPhase('connecting');
    setError('');
    try {
      if (withExtension) {
        const pubkey = await connectWithExtension();
        savedKey.save({ type: 'extension' });
        setMyPubkey(pubkey);
        setIsAnonymous(false);
      } else {
        const { pubkey, nsecHex } = await connectWithTempKey();
        savedKey.save({ type: 'ephemeral', nsecHex, displayName });
        setMyPubkey(pubkey);
        setIsAnonymous(true);
        if (displayName) {
          publishProfile(displayName).catch(() => {}); // best-effort; don't block
        }
      }
      setPhase('lobby');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
      setPhase('disconnected');
    }
  };

  const handleConnectNsec = async (nsec: string) => {
    setPhase('connecting');
    setError('');
    try {
      const { pubkey, nsecHex } = await connectWithNsec(nsec);
      savedKey.save({ type: 'nsec', nsecHex });
      setMyPubkey(pubkey);
      setIsAnonymous(false);
      setNsecInput('');
      setPhase('lobby');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
      setPhase('disconnected');
    }
  };

  // ── Create game ─────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    setError('');
    if (!selectedOpponentPubkey) {
      setError('Search for an opponent first.');
      return;
    }
    await requestNotifyPermission();
    const pubkey = selectedOpponentPubkey;
    setSelectedOpponentPubkey(null);
    await doCreate(pubkey, 2); // invitee moves first
  };

  // ── Join game ───────────────────────────────────────────────────────────────

  const handleJoin = async () => {
    setError('');
    if (!joinCodeInput.includes(':')) {
      setError('Invalid join code');
      return;
    }
    await requestNotifyPermission();
    const code = joinCodeInput.trim();
    setJoinCodeInput('');
    await doJoin(code);
  };

  // ── Navigation ──────────────────────────────────────────────────────────────

  const handleEnterGame = (gameId: string) => {
    setActiveGameId(gameId);
    setHighlightKey(0);
    setError('');
    setPhase('playing');
  };

  const handleBackToLobby = () => {
    setActiveGameId(null);
    setError('');
    setPhase('lobby');
  };

  const handleAbandonGame = async (gameId: string) => {
    const entry = gamesRef.current[gameId];
    setConfirmAbandon(null);
    if (!entry) return;

    if (entry.gameState.winner) {
      // Game already finished — just dismiss it from the list.
      subsRef.current.get(gameId)?.stop();
      subsRef.current.delete(gameId);
      setGames(prev => { const next = { ...prev }; delete next[gameId]; return next; });
      savedSessions.remove(gameId);
      if (activeGameId === gameId) { setActiveGameId(null); setPhase('lobby'); }
      return;
    }

    // Active game — publish forfeit so opponent sees the result.
    const { session, gameState } = entry;
    const opponentPlayer = (3 - session.myPlayer) as Player;
    const forfeit: GameState = { ...gameState, winner: opponentPlayer };

    // Apply forfeit optimistically so the resign button disappears immediately.
    setGames(prev => ({ ...prev, [gameId]: { ...prev[gameId], gameState: forfeit, finishReason: 'resign' } }));

    try {
      await publishMove({
        gameId,
        p1Pubkey: session.myPlayer === 1 ? session.myPubkey : session.opponentPubkey,
        p2Pubkey: session.myPlayer === 1 ? session.opponentPubkey : session.myPubkey,
        myPlayer: session.myPlayer,
        prevEventId: session.lastEventId,
        state: forfeit,
      });
    } catch { /* best-effort */ }

    subsRef.current.get(gameId)?.stop();
    subsRef.current.delete(gameId);
    const ss = savedSessions.load()[gameId];
    if (ss) savedSessions.upsert({ ...ss, finishReason: 'resign' });
    if (activeGameId === gameId) { setActiveGameId(null); setPhase('lobby'); }
  };

  // ── Move handlers ───────────────────────────────────────────────────────────

  const handleMove = useCallback(async (applyFn: (state: GameState) => GameState, errorLabel: string) => {
    const gameId = activeGameIdRef.current;
    if (!gameId) return;
    const entry = gamesRef.current[gameId];
    if (!entry) return;
    const { session, gameState } = entry;
    const next = applyFn(gameState);

    setGames(prev => ({ ...prev, [gameId]: { ...prev[gameId], gameState: next } }));

    try {
      const eventId = await publishMove({
        gameId: session.gameId,
        p1Pubkey: session.myPlayer === 1 ? session.myPubkey : session.opponentPubkey,
        p2Pubkey: session.myPlayer === 1 ? session.opponentPubkey : session.myPubkey,
        myPlayer: session.myPlayer,
        prevEventId: session.lastEventId,
        state: next,
      });
      setGames(prev => {
        const e = prev[gameId];
        if (!e) return prev;
        return { ...prev, [gameId]: { ...e, session: { ...e.session, lastEventId: eventId } } };
      });
      const all = savedSessions.load();
      if (all[gameId]) savedSessions.upsert({
        ...all[gameId],
        lastMoveAt: Date.now(),
      });
    } catch (e) {
      setGames(prev => {
        const entry = prev[gameId];
        if (!entry || entry.gameState !== next) return prev; // opponent moved in the meantime
        return { ...prev, [gameId]: { ...entry, gameState } };
      });
      setError(e instanceof Error ? e.message : errorLabel);
    }
  }, []);

  const handlePawnMove = useCallback((row: number, col: number) => {
    void handleMove(state => applyPawnMove(state, row, col), 'Failed to publish move');
  }, [handleMove]);

  const handleWallPlace = useCallback((cells: [number, number][]) => {
    void handleMove(state => applyWallPlace(state, cells), 'Failed to publish wall');
  }, [handleMove]);

  // ── Resume handler ──────────────────────────────────────────────────────────

  const handleResume = async (sk: ReturnType<typeof savedKey.load>) => {
    setPhase('reconnecting');
    setError('');
    try {
      if (!sk) throw new Error('No saved key found');
      let pubkey: string;
      if (sk.type === 'extension') {
        pubkey = await connectWithExtension();
        setIsAnonymous(false);
      } else {
        if (!sk.nsecHex) throw new Error('Saved key is missing');
        if (sk.type === 'nsec') {
          pubkey = (await connectWithNsec(sk.nsecHex)).pubkey;
          setIsAnonymous(false);
        } else {
          pubkey = await connectWithSavedKey(sk.nsecHex);
          setIsAnonymous(true);
        }
      }
      setMyPubkey(pubkey);

      await requestNotifyPermission();

      const all = savedSessions.load();
      const newGames: Record<string, GameEntry> = {};

      for (const ss of Object.values(all)) {
        const resumed = await fetchLatestGameState(ss.gameId, ss.myPubkey, ss.opponentPubkey);

        // Backward-compat: old storage may have finishReason: 'finished' (since removed).
        // If the relay fetch also failed, we have no winner info — skip rather than show
        // the game as active. It reappears correctly once the relay is reachable again.
        if ((ss.finishReason as string) === 'finished' && !resumed) continue;

        addSubscription(ss.gameId, ss.myPlayer, ss.opponentPubkey);
        const gameState = resumed?.state ?? createInitialState();
        // Derive isCreator: the creator's npub is the 2nd segment of the join code
        const joinParts = ss.joinCode.split(':');
        const isCreator = joinParts.length >= 2 && (() => {
          try { return pubkeyFromNpub(joinParts[1]) === pubkey; } catch { return false; }
        })();
        const session: Session = {
          myPubkey: ss.myPubkey,
          opponentPubkey: ss.opponentPubkey,
          gameId: ss.gameId,
          myPlayer: ss.myPlayer,
          lastEventId: resumed?.myLastEventId ?? null,
          joinCode: ss.joinCode,
          isCreator,
        };
        newGames[ss.gameId] = { session, gameState, opponentSeen: false, finishReason: ss.finishReason };
      }

      setGames(newGames);
      setPhase('lobby');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resume failed');
      setPhase('resume-prompt');
    }
  };


  // ── Detect saved session on first load ──────────────────────────────────────

  useEffect(() => {
    const sk = savedKey.load();
    const all = savedSessions.load();
    if (sk || Object.keys(all).length > 0) setPhase('resume-prompt');
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  const activeEntry = activeGameId ? games[activeGameId] : null;
  const gameList = Object.values(games);
  const sessionTimestamps = useMemo(() => savedSessions.load(), [games]);

  return (
    <div className="app">
      <h1 className="app-title">Quoridor <span className="nostr-badge">⚡ Nostr</span></h1>

      {error && (
        <div className="error-banner">
          {error}
          <button className="error-close" onClick={() => setError('')}>✕</button>
        </div>
      )}

      {/* ── Resume prompt ── */}
      {phase === 'resume-prompt' && (() => {
        const sk = savedKey.load();
        const all = savedSessions.load();
        const count = Object.values(all).filter(s => !s.finishReason).length;
        return (
          <div className="screen connect-screen">
            <p className="screen-subtitle">Previous session detected</p>
            {count > 0 && (
              <div className="resume-info">
                <div className="resume-row">
                  <span className="resume-label">Games</span>
                  <span>{count} active game{count !== 1 ? 's' : ''}</span>
                </div>
              </div>
            )}
            <div className="connect-buttons">
              <button className="btn btn-primary" onClick={() => handleResume(sk)}>
                Resume session
              </button>
              <button className="btn btn-secondary" onClick={() => {
                savedKey.clear(); savedSessions.clear(); setPhase('disconnected');
              }}>
                Start fresh
                <span className="btn-sub">discards saved key &amp; games</span>
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── Reconnecting ── */}
      {phase === 'reconnecting' && (
        <div className="screen center">
          <div className="spinner" />
          <p>Reconnecting…</p>
        </div>
      )}

      {/* ── Disconnected ── */}
      {phase === 'disconnected' && (
        <div className="screen connect-screen">
          <p className="screen-subtitle">Play Quoridor online — no account needed.</p>
          <div className="connect-buttons">
            <div className="anon-section">
              <div className="anon-name-row">
                <input
                  className="form-input"
                  value={anonName}
                  onChange={e => setAnonName(e.target.value)}
                  placeholder="Your name"
                  maxLength={40}
                />
                <button
                  className="btn btn-small btn-ghost"
                  title="Generate new name"
                  onClick={() => setAnonName(makeFunnyName())}
                >↺</button>
              </div>
              <button className="btn btn-primary" onClick={() => handleConnect(false, anonName.trim() || undefined)}>
                Play anonymous
              </button>
            </div>

            <div className="nostr-login-section">
              <button className="btn btn-secondary" onClick={() => handleConnect(true)}>
                Login with Nostr
                <span className="btn-sub">Alby, nos2x, or other Nostr extension</span>
              </button>
              <a className="nostr-what-link" href="https://nostr.com" target="_blank" rel="noreferrer">What is Nostr?</a>
            </div>

            <div className="nsec-section">
              <button
                className="btn-link nsec-toggle"
                onClick={() => { setShowNsecInput(v => !v); setNsecInput(''); }}
              >
                {showNsecInput ? '▲ Hide' : '▼ Log in with private key (advanced)'}
              </button>
              {showNsecInput && (
                <div className="nsec-panel">
                  <p className="nsec-warning">
                    ⚠ Your nsec <strong>is</strong> your Nostr identity — if it leaks,
                    your account is compromised permanently. Prefer the extension option
                    above: your key never leaves it.
                  </p>
                  <input
                    className="form-input"
                    type="password"
                    placeholder="Private key (nsec1… or hex)"
                    value={nsecInput}
                    onChange={e => setNsecInput(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    className="btn btn-secondary"
                    disabled={!nsecInput.trim()}
                    onClick={() => handleConnectNsec(nsecInput.trim())}
                  >
                    Log in with key
                    <span className="btn-sub">stores key in this browser</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="about-section">
            <h2 className="about-title">What is Quoridor?</h2>
            <p className="about-text">
              Quoridor is a two-player strategy board game. Each player has one pawn
              that starts on opposite sides of a 9×9 grid. Your goal is to be the
              first to reach the other side — but both players can place walls to
              block the way. Every turn you either move your pawn one square or place
              one wall segment. The twist: you can never fully trap your opponent;
              a path to their goal must always remain open.
            </p>
            <p className="about-text">
              Easy to learn, surprisingly deep.{' '}
              <a
                className="about-link"
                href="https://en.wikipedia.org/wiki/Quoridor"
                target="_blank"
                rel="noreferrer"
              >
                Full rules on Wikipedia →
              </a>
            </p>
            <p className="about-text about-meta">
              Open source &mdash;{' '}
              <a
                className="about-link"
                href="https://github.com/jeroenubbink/quoridor"
                target="_blank"
                rel="noreferrer"
              >
                github.com/jeroenubbink/quoridor
              </a>
              {' '}&mdash; MIT licence
            </p>
            <h2 className="about-title">Features</h2>
            <ul className="about-features">
              <li>Fully peer-to-peer — game state lives on Nostr relays, no server</li>
              <li>Play with your Nostr identity or jump in anonymously</li>
              <li>Invite a specific player by searching their name or player ID</li>
              <li>Find a random opponent with one click</li>
              <li>Run multiple games at the same time</li>
              <li>Sessions survive page reloads and reconnects</li>
              <li>Browser notifications when it's your turn</li>
            </ul>
          </div>
        </div>
      )}

      {/* ── Connecting ── */}
      {phase === 'connecting' && (
        <div className="screen center">
          <div className="spinner" />
          <p>Connecting to Nostr relays…</p>
        </div>
      )}

      {/* ── Lobby ── */}
      {phase === 'lobby' && (() => {
        const timestamps = sessionTimestamps;
        const isFinished = (e: GameEntry) => !!e.gameState.winner || e.finishReason === 'no-contest';
        const activeGames = gameList
          .filter(e => !isFinished(e))
          .sort((a, b) => {
            const aMyTurn = a.gameState.currentPlayer === a.session.myPlayer ? 1 : 0;
            const bMyTurn = b.gameState.currentPlayer === b.session.myPlayer ? 1 : 0;
            if (aMyTurn !== bMyTurn) return bMyTurn - aMyTurn;
            const aTs = timestamps[a.session.gameId]?.lastMoveAt ?? 0;
            const bTs = timestamps[b.session.gameId]?.lastMoveAt ?? 0;
            return bTs - aTs;
          });
        const finishedGames = gameList.filter(isFinished).sort((a, b) => {
          const aTs = timestamps[a.session.gameId]?.lastMoveAt ?? 0;
          const bTs = timestamps[b.session.gameId]?.lastMoveAt ?? 0;
          return bTs - aTs;
        });

        const statusText = (e: GameEntry) => {
          if (e.finishReason === 'no-contest') return 'No contest';
          if (e.gameState.winner) {
            if (e.finishReason === 'timeout') return 'Won by timeout';
            if (e.finishReason === 'resign') return 'Resigned';
            return e.gameState.winner === e.session.myPlayer ? 'You won' : 'You lost';
          }
          return e.gameState.currentPlayer === e.session.myPlayer ? 'Your turn' : 'Opponent\'s turn';
        };
        const statusClass = (e: GameEntry) => {
          if (e.finishReason === 'no-contest') return 'lost';
          if (e.gameState.winner) return e.gameState.winner === e.session.myPlayer ? 'won' : 'lost';
          return e.gameState.currentPlayer === e.session.myPlayer ? 'your-turn' : '';
        };
        const renderItem = (entry: GameEntry) => {
          const { session } = entry;
          const done = isFinished(entry);
          return (
            <div key={session.gameId} className="game-list-item">
              <div className="game-list-info">
                <span className={`game-list-status ${statusClass(entry)}`}>{statusText(entry)}</span>
                <UserCard pubkey={session.opponentPubkey} size="sm" label="vs" />
              </div>
              <div className="game-list-actions">
                <button className="btn btn-small btn-primary" onClick={() => handleEnterGame(session.gameId)}>
                  {done ? 'View' : 'Enter'}
                </button>
                {done ? (
                  <button className="btn btn-small btn-ghost" onClick={() => handleAbandonGame(session.gameId)}>
                    Dismiss
                  </button>
                ) : confirmAbandon === session.gameId ? (
                  <>
                    <button className="btn btn-small btn-danger" onClick={() => handleAbandonGame(session.gameId)}>
                      Confirm resign
                    </button>
                    <button className="btn btn-small btn-ghost" onClick={() => setConfirmAbandon(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="btn btn-small btn-ghost" onClick={() => setConfirmAbandon(session.gameId)}>
                    Resign
                  </button>
                )}
              </div>
            </div>
          );
        };

        return (
          <div className="screen lobby-screen">
            <div className="identity-line">
              <UserCard pubkey={myPubkey} size={isAnonymous ? 'md' : 'lg'} label="You" />
              {!isAnonymous && (
                <button
                  className="btn btn-small btn-ghost"
                  style={{ marginTop: '0.25rem' }}
                  onClick={() => copyWithFeedback(npubFromPubkey(myPubkey), 'npub')}
                >{copiedId === 'npub' ? 'Copied!' : 'Copy player ID'}</button>
              )}
              {isAnonymous && savedKey.load()?.type === 'ephemeral' && (
                <>
                  <button
                    className="btn btn-small btn-ghost"
                    style={{ marginTop: '0.25rem' }}
                    onClick={() => setShowNsecReveal(v => !v)}
                  >
                    {showNsecReveal ? 'Hide' : 'Continue on another device'}
                  </button>
                  {showNsecReveal && (
                    <div className="nsec-reveal-panel">
                      <p className="nsec-info">
                        Copy this key and paste it on the other device or browser when logging in
                        — choose "Use saved key" on the login screen.
                      </p>
                      <p className="nsec-warning">
                        ⚠ This is a Nostr private key (nsec). Anyone who sees it can use your
                        anonymous identity permanently. Only copy it to a device you trust.
                      </p>
                      <div className="nsec-reveal-row">
                        <code className="nsec-reveal-value">{nsecBech32}</code>
                        <button
                          className="btn btn-small btn-ghost"
                          onClick={() => { copyWithFeedback(nsecBech32, 'nsec-export'); setShowNsecReveal(false); }}
                        >
                          {copiedId === 'nsec-export' ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Main nav */}
            <div className="lobby-nav">
              <button
                className={`lobby-nav-btn ${lobbySection === 'active' ? 'active' : ''} ${activeGames.length === 0 ? 'empty' : ''}`}
                onClick={() => setLobbySection('active')}
              >
                Active games
                {activeGames.length > 0 && <span className="lobby-nav-badge">{activeGames.length}</span>}
              </button>
              <button
                className={`lobby-nav-btn ${lobbySection === 'new' ? 'active' : ''}`}
                onClick={() => setLobbySection('new')}
              >
                New game
              </button>
              <button
                className={`lobby-nav-btn ${lobbySection === 'history' ? 'active' : ''} ${finishedGames.length === 0 ? 'empty' : ''}`}
                onClick={() => setLobbySection('history')}
              >
                History
                {finishedGames.length > 0 && <span className="lobby-nav-badge">{finishedGames.length}</span>}
              </button>
            </div>

            {/* Active games */}
            {lobbySection === 'active' && (
              activeGames.length === 0 ? (
                <div className="lobby-empty">
                  <p>No active games yet.</p>
                  <button className="btn btn-primary" onClick={() => setLobbySection('new')}>
                    Start a new game
                  </button>
                </div>
              ) : (
                <div className="game-list">{activeGames.map(renderItem)}</div>
              )
            )}

            {/* New game */}
            {lobbySection === 'new' && (
              <>
                {(() => {
                  const entries = Object.values(seekList)
                    .filter(e => e.pubkey !== myPubkey)
                    .sort((a, b) => b.createdAt - a.createdAt);
                  const PAGE_SIZE = 5;
                  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
                  const page = Math.min(seekPage, totalPages - 1);
                  const pageEntries = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
                  const isInQueue = seeks.length > 0;
                  const hasOtherSeekers = entries.length > 0;

                  const seekListBlock = (
                    <>
                      <div className="seek-list">
                        {pageEntries.map(entry => (
                          <SeekRow key={entry.pubkey} entry={entry} onMatch={() => handlePickSeeker(entry)} />
                        ))}
                      </div>
                      {totalPages > 1 && (
                        <div className="seek-list-pagination">
                          <button className="btn btn-small btn-ghost" disabled={page === 0}
                            onClick={() => setSeekPage(p => Math.max(0, p - 1))}>← Prev</button>
                          <span>{page + 1} / {totalPages}</span>
                          <button className="btn btn-small btn-ghost" disabled={page >= totalPages - 1}
                            onClick={() => setSeekPage(p => Math.min(totalPages - 1, p + 1))}>Next →</button>
                        </div>
                      )}
                    </>
                  );

                  return (
                    <div className="seek-section">
                      {!isInQueue && !hasOtherSeekers && (
                        <div className="seek-empty-state">
                          <p className="seek-empty-heading">No opponents available yet.</p>
                          <p className="seek-empty-body">
                            Be the first in the queue — when another player opens the game,
                            they'll see you here and can start a game with you.
                          </p>
                          <button className="btn btn-primary" onClick={handleAddSeek}>
                            Find an opponent
                          </button>
                        </div>
                      )}

                      {!isInQueue && hasOtherSeekers && (
                        <>
                          <h3 className="seek-list-header">Players looking for a game</h3>
                          {seekListBlock}
                          <div className="seek-or-divider">or</div>
                          <button className="btn btn-secondary" onClick={handleAddSeek}>
                            Add me to the list
                            <span className="btn-sub">join the queue — others can pick you</span>
                          </button>
                        </>
                      )}

                      {isInQueue && (
                        <>
                          <div className="seeking-status">
                            <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                            <span>Waiting for an opponent...</span>
                            <button className="btn btn-small btn-ghost"
                              onClick={() => handleCancelSeek(seeks[0].id)}>Cancel</button>
                          </div>
                          {!hasOtherSeekers && (
                            <p className="seek-hint">
                              When someone opens the game, they'll see you and can start a game.
                            </p>
                          )}
                          {hasOtherSeekers && (
                            <>
                              <div className="seek-or-divider">Or pick someone already waiting</div>
                              {seekListBlock}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}


                <div className="tabs">
                  <button className={`tab ${newGameTab === 'create' ? 'active' : ''}`} onClick={() => setNewGameTab('create')}>
                    Create game
                  </button>
                  <button className={`tab ${newGameTab === 'join' ? 'active' : ''}`} onClick={() => setNewGameTab('join')}>
                    Join game
                  </button>
                </div>

                {newGameTab === 'create' && (
                  <div className="lobby-form">
                    <label className="form-label">Opponent</label>
                    <PlayerSearch
                      selectedPubkey={selectedOpponentPubkey}
                      onSelect={setSelectedOpponentPubkey}
                      onClear={() => setSelectedOpponentPubkey(null)}
                    />
                    <button className="btn btn-primary" onClick={handleCreate}>
                      Create game
                    </button>
                  </div>
                )}

                {newGameTab === 'join' && (
                  <div className="lobby-form">
                    <label className="form-label">Join code</label>
                    <input
                      className="form-input"
                      placeholder="Paste join code…"
                      value={joinCodeInput}
                      onChange={e => setJoinCodeInput(e.target.value)}
                    />
                    <button className="btn btn-primary" onClick={handleJoin}>
                      Join game
                    </button>
                  </div>
                )}
              </>
            )}

            {/* History */}
            {lobbySection === 'history' && (
              finishedGames.length === 0 ? (
                <div className="lobby-empty">
                  <p>No finished games yet.</p>
                </div>
              ) : (
                <div className="game-list">{finishedGames.map(renderItem)}</div>
              )
            )}
          </div>
        );
      })()}

      {/* ── Playing ── */}
      {phase === 'playing' && activeEntry && (
        <div className="screen playing-screen">
          <div className="game-header">
            <div className="game-status">
              {activeEntry.finishReason === 'no-contest' ? (
                <span className="waiting">No contest</span>
              ) : activeEntry.gameState.winner ? (
                <>
                  <span className={`pname p${activeEntry.gameState.winner}-color`}>
                    {activeEntry.gameState.winner === activeEntry.session.myPlayer
                      ? 'You'
                      : <OpponentName pubkey={activeEntry.session.opponentPubkey} />}
                  </span>{' '}
                  win{activeEntry.gameState.winner === activeEntry.session.myPlayer ? '!' : 's.'}
                  {activeEntry.finishReason === 'timeout' && ' (timeout)'}
                </>
              ) : activeEntry.gameState.currentPlayer === activeEntry.session.myPlayer ? (
                <>
                  <span className={`pname p${activeEntry.session.myPlayer}-color`}>
                    Your turn
                  </span>
                  {activeEntry.opponentLastMove && (
                    <button
                      className="replay-btn"
                      onClick={() => setHighlightKey(k => k + 1)}
                      title="Replay opponent's last move"
                    > · Last opp move</button>
                  )}
                </>
              ) : (
                <span className="waiting">
                  {!activeEntry.opponentSeen ? 'Waiting for opponent to join…' : 'Waiting for opponent\'s move…'}
                </span>
              )}
            </div>
            <div className="game-players">
              <UserCard
                pubkey={activeEntry.session.myPlayer === 1 ? activeEntry.session.myPubkey : activeEntry.session.opponentPubkey}
                size="md"
                label={`P1${activeEntry.session.myPlayer === 1 ? ' (you)' : ''}`}
                playerColor={1}
              />
              <span className="game-vs">vs</span>
              <UserCard
                pubkey={activeEntry.session.myPlayer === 2 ? activeEntry.session.myPubkey : activeEntry.session.opponentPubkey}
                size="md"
                label={`P2${activeEntry.session.myPlayer === 2 ? ' (you)' : ''}`}
                playerColor={2}
              />
            </div>
            {activeEntry.session.isCreator && activeEntry.session.myPlayer === 2 && activeEntry.gameState.moveNumber === 0 && (
              <div className="join-code-box" style={{ marginTop: '0.5rem' }}>
                <p className="join-code-label">Share this code with your opponent:</p>
                <code className="join-code">{activeEntry.session.joinCode}</code>
                <button
                  className="btn btn-small"
                  onClick={() => copyWithFeedback(activeEntry.session.joinCode, 'joincode')}
                >{copiedId === 'joincode' ? 'Copied!' : 'Copy'}</button>
              </div>
            )}
          </div>

          <GameBoard
            state={activeEntry.gameState}
            myPlayer={activeEntry.session.myPlayer}
            onPawnMove={handlePawnMove}
            onWallPlace={handleWallPlace}
            opponentLastMove={activeEntry.opponentLastMove}
            highlightKey={highlightKey}
          />

          <div className="game-footer">
            <button className="btn btn-secondary" onClick={handleBackToLobby}>← Games</button>
            {!activeEntry.gameState.winner && activeEntry.finishReason !== 'no-contest' && (
              confirmAbandon === activeGameId ? (
                <>
                  <button className="btn btn-danger" onClick={() => handleAbandonGame(activeGameId!)}>
                    Confirm resign
                  </button>
                  <button className="btn btn-ghost" onClick={() => setConfirmAbandon(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn btn-ghost btn-resign" onClick={() => setConfirmAbandon(activeGameId)}>
                  Resign
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
