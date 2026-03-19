const P = 'nostridor:';

function safeSetItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage may be full or unavailable (e.g. private browsing)
    console.warn('localStorage.setItem failed for key:', key);
  }
}

// ─── Saved key ────────────────────────────────────────────────────────────────

export type SavedKeyType = 'extension' | 'ephemeral' | 'nsec';

export interface SavedKey {
  type: SavedKeyType;
  nsecHex?: string; // present for ephemeral (throwaway) and nsec (real identity) types
  displayName?: string; // chosen name for anonymous sessions
}

export const savedKey = {
  save: (data: SavedKey) => safeSetItem(P + 'key', JSON.stringify(data)),
  load: (): SavedKey | null => {
    const raw = localStorage.getItem(P + 'key');
    return raw ? (JSON.parse(raw) as SavedKey) : null;
  },
  clear: () => localStorage.removeItem(P + 'key'),
};

// ─── Saved game sessions ──────────────────────────────────────────────────────

export interface SavedSession {
  gameId: string;
  myPubkey: string;
  opponentPubkey: string;
  myPlayer: 1 | 2;
  joinCode: string;
  lastMoveAt?: number;      // ms timestamp of the most recent move (ours or opponent's)
  finishReason?: 'timeout' | 'resign' | 'no-contest';
}

export const savedSessions = {
  load: (): Record<string, SavedSession> => {
    const raw = localStorage.getItem(P + 'sessions');
    return raw ? (JSON.parse(raw) as Record<string, SavedSession>) : {};
  },
  save: (sessions: Record<string, SavedSession>) =>
    safeSetItem(P + 'sessions', JSON.stringify(sessions)),
  upsert: (session: SavedSession) => {
    const all = savedSessions.load();
    all[session.gameId] = session;
    savedSessions.save(all);
  },
  remove: (gameId: string) => {
    const all = savedSessions.load();
    delete all[gameId];
    savedSessions.save(all);
  },
  clear: () => localStorage.removeItem(P + 'sessions'),
};
