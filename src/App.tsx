import { useState, useEffect, useRef, useCallback } from 'react';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';
import './App.css';
import { GameBoard } from './GameBoard';
import {
  createInitialState,
  applyPawnMove,
  applyWallPlace,
  type GameState,
  type Player,
} from './game';
import {
  connectWithExtension,
  connectWithTempKey,
  connectWithSavedKey,
  fetchLatestGameState,
  pubkeyFromNpub,
  npubFromPubkey,
  publishMove,
  publishProfile,
  subscribeToGame,
  publishSeek,
  cancelSeek,
  subscribeToSeeks,
  publishInvite,
  subscribeToInvites,
} from './nostr';
import { UserCard } from './UserCard';
import { savedKey, savedSessions } from './storage';
import type { NDKSubscription } from '@nostr-dev-kit/ndk';

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'disconnected' | 'resume-prompt' | 'reconnecting' | 'connecting' | 'lobby' | 'playing';

interface Session {
  myPubkey: string;
  opponentPubkey: string;
  gameId: string;
  myPlayer: Player;
  lastEventId: string | null;
  joinCode: string;
}

interface GameEntry {
  session: Session;
  gameState: GameState;
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
  const gamesRef = useRef<Record<string, GameEntry>>({});
  gamesRef.current = games;

  // Which game is currently being viewed on the playing screen.
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const activeGameIdRef = useRef<string | null>(null);
  activeGameIdRef.current = activeGameId;

  // One subscription per game.
  const subsRef = useRef<Map<string, NDKSubscription>>(new Map());

  // ── Matchmaking state ───────────────────────────────────────────────────────
  const [seeking, setSeeking] = useState(false);
  const seekEventIdRef  = useRef<string | null>(null);
  const seekSubRef      = useRef<NDKSubscription | null>(null);
  const inviteSubRef    = useRef<NDKSubscription | null>(null);
  const matchedRef      = useRef(false); // prevents double-match race

  // ── Lobby form state ────────────────────────────────────────────────────────

  const [lobbyTab, setLobbyTab] = useState<'create' | 'join'>('create');
  const [opponentInput, setOpponentInput] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [confirmAbandon, setConfirmAbandon] = useState<string | null>(null); // gameId pending confirm

  // ── Timeout warning (for the currently active game) ─────────────────────────

  const [timeoutWarning, setTimeoutWarning] = useState(false);
  useEffect(() => setTimeoutWarning(false), [activeGameId]);

  // ── Cleanup all subscriptions on unmount ────────────────────────────────────

  useEffect(() => () => {
    subsRef.current.forEach(sub => sub.stop());
    seekSubRef.current?.stop();
    inviteSubRef.current?.stop();
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

  // Fire the browser notification exactly once when the warning first appears.
  useEffect(() => {
    if (!timeoutWarning || !activeGameId) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification('Quoridor — opponent overdue!', {
      body: 'Your opponent has not moved in 2 days. You may declare yourself the winner.',
      tag: `quoridor-timeout-${activeGameId}`,
    });
  }, [timeoutWarning, activeGameId]);

  // ── Timeout check ───────────────────────────────────────────────────────────

  const checkAllTimeouts = useCallback(() => {
    const all = savedSessions.load();
    for (const [gameId, entry] of Object.entries(gamesRef.current)) {
      const { session, gameState } = entry;
      if (gameState.winner) continue;
      if (gameState.currentPlayer === session.myPlayer) continue; // our turn
      const ss = all[gameId];
      if (!ss?.lastMoveAt) continue;
      if (Date.now() - ss.lastMoveAt < TIMEOUT_MS) continue;

      if (gameId === activeGameIdRef.current) {
        setTimeoutWarning(true); // useEffect above fires the notification
      } else {
        // Background game — notify directly (no UI to update)
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('Quoridor — opponent overdue!', {
            body: 'Your opponent has not moved in 2 days.',
            tag: `quoridor-timeout-${gameId}`,
          });
        }
      }
    }
  }, []);

  // Run periodic timeout check while connected.
  useEffect(() => {
    if (phase !== 'lobby' && phase !== 'playing') return;
    const id = setInterval(checkAllTimeouts, 60_000);
    return () => clearInterval(id);
  }, [phase, checkAllTimeouts]);

  // Check timeout when entering a game (in case it was already overdue).
  useEffect(() => {
    if (!activeGameId || phase !== 'playing') return;
    const entry = gamesRef.current[activeGameId];
    if (!entry || entry.gameState.winner) return;
    if (entry.gameState.currentPlayer === entry.session.myPlayer) return;
    const ss = savedSessions.load()[activeGameId];
    if (ss?.lastMoveAt && Date.now() - ss.lastMoveAt >= TIMEOUT_MS) setTimeoutWarning(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGameId, phase]);

  // ── Subscribe helper ────────────────────────────────────────────────────────

  const addSubscription = useCallback((gameId: string, myPlayer: Player, opponentPubkey: string) => {
    subsRef.current.get(gameId)?.stop();

    const sub = subscribeToGame(gameId, opponentPubkey, (incoming) => {
      setGames(prev => {
        const entry = prev[gameId];
        if (!entry || incoming.moveNumber <= entry.gameState.moveNumber) return prev;
        // Stamp timestamp and clear timeout warning for this game.
        const all = savedSessions.load();
        if (all[gameId]) savedSessions.upsert({ ...all[gameId], lastMoveAt: Date.now() });
        if (gameId === activeGameIdRef.current) setTimeoutWarning(false);
        return { ...prev, [gameId]: { ...entry, gameState: incoming } };
      });
      if (incoming.currentPlayer === myPlayer) notifyTurn(gameId);
    });

    subsRef.current.set(gameId, sub);
  }, []);

  // ── Matchmaking ─────────────────────────────────────────────────────────────

  const stopSeeking = useCallback(() => {
    seekSubRef.current?.stop();
    inviteSubRef.current?.stop();
    seekSubRef.current = null;
    inviteSubRef.current = null;
    if (seekEventIdRef.current) {
      cancelSeek(seekEventIdRef.current);
      seekEventIdRef.current = null;
    }
    matchedRef.current = false;
    setSeeking(false);
  }, []);

  const handleSeek = async () => {
    setError('');
    setSeeking(true);
    matchedRef.current = false;

    await requestNotifyPermission();

    let seekId: string;
    try {
      seekId = await publishSeek();
      seekEventIdRef.current = seekId;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to publish seek');
      setSeeking(false);
      return;
    }

    // When someone invites us (they are P1, we are P2) — auto-join their game.
    inviteSubRef.current = subscribeToInvites(myPubkey, async (joinCode, _inviterPubkey) => {
      if (matchedRef.current) return;
      matchedRef.current = true;
      stopSeeking();
      await doJoin(joinCode);
    });

    // When we see another seeker: lower pubkey becomes P1 and creates the game.
    seekSubRef.current = subscribeToSeeks(myPubkey, async (opponentPubkey) => {
      if (matchedRef.current) return;
      if (myPubkey > opponentPubkey) return; // they will invite us — wait
      matchedRef.current = true;
      stopSeeking();
      await doCreate(opponentPubkey);
    });
  };

  // Shared helpers used by both manual lobby and matchmaking.

  const doCreate = async (opponentPubkey: string) => {
    const gameId = crypto.randomUUID();
    const initial = createInitialState();
    const code = `${gameId}:${npubFromPubkey(myPubkey)}`;

    addSubscription(gameId, 1, opponentPubkey);
    try {
      const eventId = await publishMove({
        gameId,
        p1Pubkey: myPubkey,
        p2Pubkey: opponentPubkey,
        myPlayer: 1,
        prevEventId: null,
        state: initial,
      });
      await publishInvite(opponentPubkey, gameId, code);

      const session: Session = { myPubkey, opponentPubkey, gameId, myPlayer: 1, lastEventId: eventId, joinCode: code };
      setGames(prev => ({ ...prev, [gameId]: { session, gameState: initial } }));
      savedSessions.upsert({ gameId, myPubkey, opponentPubkey, myPlayer: 1, joinCode: code, lastMoveAt: Date.now() });
      setActiveGameId(gameId);
      setPhase('playing');
    } catch (e) {
      subsRef.current.get(gameId)?.stop();
      subsRef.current.delete(gameId);
      setError(e instanceof Error ? e.message : 'Failed to create game');
    }
  };

  const doJoin = async (joinCodeStr: string) => {
    const colonIdx = joinCodeStr.indexOf(':');
    if (colonIdx === -1) { setError('Invalid join code received'); return; }
    const gameId   = joinCodeStr.slice(0, colonIdx).trim();
    const p1NpubRaw = joinCodeStr.slice(colonIdx + 1).trim();

    if (games[gameId]) { setActiveGameId(gameId); setPhase('playing'); return; }

    let p1Pubkey: string;
    try { p1Pubkey = pubkeyFromNpub(p1NpubRaw); }
    catch { setError('Received malformed join code'); return; }

    addSubscription(gameId, 2, p1Pubkey);
    const session: Session = { myPubkey, opponentPubkey: p1Pubkey, gameId, myPlayer: 2, lastEventId: null, joinCode: joinCodeStr };
    setGames(prev => ({ ...prev, [gameId]: { session, gameState: createInitialState() } }));
    savedSessions.upsert({ gameId, myPubkey, opponentPubkey: p1Pubkey, myPlayer: 2, joinCode: joinCodeStr, lastMoveAt: Date.now() });
    setActiveGameId(gameId);
    setPhase('playing');
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

  // ── Create game ─────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    setError('');
    let opponentPubkey: string;
    try {
      opponentPubkey = pubkeyFromNpub(opponentInput.trim());
    } catch {
      setError('Invalid npub — paste your opponent\'s npub1… identifier.');
      return;
    }
    await requestNotifyPermission();
    setOpponentInput('');
    await doCreate(opponentPubkey);
  };

  // ── Join game ───────────────────────────────────────────────────────────────

  const handleJoin = async () => {
    setError('');
    if (!joinCodeInput.includes(':')) {
      setError('Invalid join code — expected format: <game-id>:<p1npub>');
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
    setError('');
    setPhase('playing');
  };

  const handleBackToLobby = () => {
    setActiveGameId(null);
    setError('');
    stopSeeking();
    setPhase('lobby');
  };

  const handleAbandonGame = async (gameId: string) => {
    const entry = gamesRef.current[gameId];
    if (entry && !entry.gameState.winner) {
      // Publish a forfeit: set winner to the opponent so they see the result.
      const { session, gameState } = entry;
      const opponentPlayer = (3 - session.myPlayer) as Player;
      const forfeit: GameState = { ...gameState, winner: opponentPlayer };
      try {
        await publishMove({
          gameId,
          p1Pubkey: session.myPlayer === 1 ? session.myPubkey : session.opponentPubkey,
          p2Pubkey: session.myPlayer === 1 ? session.opponentPubkey : session.myPubkey,
          myPlayer: session.myPlayer,
          prevEventId: session.lastEventId,
          state: forfeit,
        });
      } catch {
        // Best-effort — remove locally regardless
      }
    }

    subsRef.current.get(gameId)?.stop();
    subsRef.current.delete(gameId);
    setGames(prev => { const next = { ...prev }; delete next[gameId]; return next; });
    savedSessions.remove(gameId);
    setConfirmAbandon(null);
    if (activeGameId === gameId) {
      setActiveGameId(null);
      setPhase('lobby');
    }
  };

  // ── Move handlers ───────────────────────────────────────────────────────────

  const handlePawnMove = useCallback(async (row: number, col: number) => {
    const gameId = activeGameIdRef.current;
    if (!gameId) return;
    const entry = gamesRef.current[gameId];
    if (!entry) return;
    const { session, gameState } = entry;
    const next = applyPawnMove(gameState, row, col);

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
      if (all[gameId]) savedSessions.upsert({ ...all[gameId], lastMoveAt: Date.now() });
      setTimeoutWarning(false);
    } catch (e) {
      setGames(prev => ({ ...prev, [gameId]: { ...prev[gameId], gameState } }));
      setError(e instanceof Error ? e.message : 'Failed to publish move');
    }
  }, []);

  const handleWallPlace = useCallback(async (cells: [number, number][]) => {
    const gameId = activeGameIdRef.current;
    if (!gameId) return;
    const entry = gamesRef.current[gameId];
    if (!entry) return;
    const { session, gameState } = entry;
    const next = applyWallPlace(gameState, cells);

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
      if (all[gameId]) savedSessions.upsert({ ...all[gameId], lastMoveAt: Date.now() });
      setTimeoutWarning(false);
    } catch (e) {
      setGames(prev => ({ ...prev, [gameId]: { ...prev[gameId], gameState } }));
      setError(e instanceof Error ? e.message : 'Failed to publish wall');
    }
  }, []);

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
        if (!sk.nsecHex) throw new Error('Saved ephemeral key is missing');
        pubkey = await connectWithSavedKey(sk.nsecHex);
        setIsAnonymous(true);
      }
      setMyPubkey(pubkey);

      await requestNotifyPermission();

      const all = savedSessions.load();
      const newGames: Record<string, GameEntry> = {};

      for (const ss of Object.values(all)) {
        addSubscription(ss.gameId, ss.myPlayer, ss.opponentPubkey);
        const resumed = await fetchLatestGameState(ss.gameId, ss.myPubkey, ss.opponentPubkey);
        const gameState = resumed?.state ?? createInitialState();
        const session: Session = {
          myPubkey: ss.myPubkey,
          opponentPubkey: ss.opponentPubkey,
          gameId: ss.gameId,
          myPlayer: ss.myPlayer,
          lastEventId: resumed?.myLastEventId ?? null,
          joinCode: ss.joinCode,
        };
        newGames[ss.gameId] = { session, gameState };
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
        const count = Object.keys(all).length;
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
          <p className="screen-subtitle">Play Quoridor peer-to-peer over Nostr</p>
          <div className="connect-buttons">
            <button className="btn btn-primary" onClick={() => handleConnect(true)}>
              Connect with extension
              <span className="btn-sub">NIP-07 (Alby, nos2x…)</span>
            </button>

            <div className="anon-section">
              <p className="anon-label">— or play anonymous —</p>
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
              <button className="btn btn-secondary" onClick={() => handleConnect(false, anonName.trim() || undefined)}>
                Play anonymous
              </button>
            </div>
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
      {phase === 'lobby' && (
        <div className="screen lobby-screen">
          <div className="identity-line">
            <UserCard pubkey={myPubkey} size={isAnonymous ? 'md' : 'lg'} label="You" />
            {!isAnonymous && (
              <button
                className="btn btn-small btn-ghost"
                style={{ marginTop: '0.25rem' }}
                onClick={() => navigator.clipboard.writeText(npubFromPubkey(myPubkey))}
              >Copy npub</button>
            )}
          </div>

          {/* Active games list */}
          {gameList.length > 0 && (
            <div className="game-list">
              <p className="game-list-title">Active games</p>
              {gameList.map(({ session, gameState }) => {
                const isMyTurn = !gameState.winner && gameState.currentPlayer === session.myPlayer;
                return (
                  <div key={session.gameId} className="game-list-item">
                    <div className="game-list-info">
                      <span className={`game-list-status ${gameState.winner ? (gameState.winner === session.myPlayer ? 'won' : 'lost') : isMyTurn ? 'your-turn' : ''}`}>
                        {gameState.winner
                          ? (gameState.winner === session.myPlayer ? 'You won' : 'You lost')
                          : isMyTurn ? 'Your turn' : 'Waiting'}
                      </span>
                      <UserCard pubkey={session.opponentPubkey} size="sm" label="vs" />
                    </div>
                    <div className="game-list-actions">
                      <button className="btn btn-small btn-primary" onClick={() => handleEnterGame(session.gameId)}>
                        Enter
                      </button>
                      {confirmAbandon === session.gameId ? (
                        <>
                          <button className="btn btn-small btn-danger" onClick={() => handleAbandonGame(session.gameId)}>
                            Confirm
                          </button>
                          <button className="btn btn-small btn-ghost" onClick={() => setConfirmAbandon(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-small btn-ghost" onClick={() => setConfirmAbandon(session.gameId)}>
                          Abandon
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Matchmaking */}
          <div className="seek-section">
            {seeking ? (
              <div className="seeking-status">
                <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                <span>Searching for opponent…</span>
                <button className="btn btn-small btn-ghost" onClick={stopSeeking}>Cancel</button>
              </div>
            ) : (
              <button className="btn btn-secondary" onClick={handleSeek}>
                Find random opponent
                <span className="btn-sub">match with another seeker on Nostr</span>
              </button>
            )}
          </div>

          <div className="tabs">
            <button className={`tab ${lobbyTab === 'create' ? 'active' : ''}`} onClick={() => setLobbyTab('create')}>
              Create game
            </button>
            <button className={`tab ${lobbyTab === 'join' ? 'active' : ''}`} onClick={() => setLobbyTab('join')}>
              Join game
            </button>
          </div>

          {lobbyTab === 'create' && (
            <div className="lobby-form">
              <label className="form-label">Opponent's npub</label>
              <input
                className="form-input"
                placeholder="npub1…"
                value={opponentInput}
                onChange={e => setOpponentInput(e.target.value)}
              />
              <button className="btn btn-primary" onClick={handleCreate}>
                Create game
              </button>
            </div>
          )}

          {lobbyTab === 'join' && (
            <div className="lobby-form">
              <label className="form-label">Join code</label>
              <input
                className="form-input"
                placeholder="<game-id>:<p1npub>"
                value={joinCodeInput}
                onChange={e => setJoinCodeInput(e.target.value)}
              />
              <button className="btn btn-primary" onClick={handleJoin}>
                Join game
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Playing ── */}
      {phase === 'playing' && activeEntry && (
        <div className="screen playing-screen">
          <div className="game-header">
            <div className="game-status">
              {activeEntry.gameState.winner ? (
                <>
                  <span className={`pname p${activeEntry.gameState.winner}-color`}>
                    {activeEntry.gameState.winner === activeEntry.session.myPlayer ? 'You' : 'Opponent'}
                  </span>{' '}
                  win{activeEntry.gameState.winner === activeEntry.session.myPlayer ? '!' : 's.'}
                </>
              ) : activeEntry.gameState.currentPlayer === activeEntry.session.myPlayer ? (
                <span className={`pname p${activeEntry.session.myPlayer}-color`}>Your turn</span>
              ) : (
                <span className="waiting">Waiting for opponent…</span>
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
            <div className="game-meta">
              <button className="btn btn-small btn-ghost" onClick={handleBackToLobby}>← Games</button>
              {!activeEntry.gameState.winner && (
                confirmAbandon === activeGameId ? (
                  <>
                    <button className="btn btn-small btn-danger" onClick={() => handleAbandonGame(activeGameId!)}>
                      Confirm abandon
                    </button>
                    <button className="btn btn-small btn-ghost" onClick={() => setConfirmAbandon(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="btn btn-small btn-ghost" onClick={() => setConfirmAbandon(activeGameId)}>
                    Abandon
                  </button>
                )
              )}
            </div>
            {activeEntry.session.myPlayer === 1 && (
              <div className="join-code-box" style={{ marginTop: '0.5rem' }}>
                <p className="join-code-label">Join code (share with opponent):</p>
                <code className="join-code">{activeEntry.session.joinCode}</code>
                <button
                  className="btn btn-small"
                  onClick={() => navigator.clipboard.writeText(activeEntry.session.joinCode)}
                >Copy</button>
              </div>
            )}
          </div>

          {timeoutWarning && !activeEntry.gameState.winner && (
            <div className="timeout-banner">
              ⏰ Your opponent has not moved in over 2 days.
              You may declare yourself the winner.
              <button className="error-close" onClick={() => setTimeoutWarning(false)}>✕</button>
            </div>
          )}

          <GameBoard
            state={activeEntry.gameState}
            myPlayer={activeEntry.session.myPlayer}
            onPawnMove={handlePawnMove}
            onWallPlace={handleWallPlace}
          />
        </div>
      )}
    </div>
  );
}
