import NDK, {
  NDKNip07Signer,
  NDKPrivateKeySigner,
  NDKEvent,
  NDKUser,
  NDKSubscription,
  type NDKFilter,
} from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import { validateIncomingState, GAME_VERSION, type GameState, type Player } from './game';

// ─── Constants ───────────────────────────────────────────────────────────────

export const GAME_KIND = 30078;

// Bootstrap relays used for connection and fallback.
// purplepag.es indexes NIP-65 relay lists, which NDK uses for outbox routing.
const BOOTSTRAP_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
];

// ─── NDK singleton ────────────────────────────────────────────────────────────

let _ndk: NDK | null = null;

export function getNdk(): NDK {
  if (!_ndk) throw new Error('NDK not initialised — call connect first');
  return _ndk;
}

// Reconnect all relays in the pool. Call this when the tab becomes visible
// after a long background period — browsers kill WebSocket connections and
// NDK may not have detected the drop yet.
export function reconnectRelays(): void {
  if (!_ndk) return;
  _ndk.pool?.relays.forEach(relay => {
    relay.connect().catch(() => {}); // best-effort
  });
}

// ─── Connection ───────────────────────────────────────────────────────────────

async function initNdk(signer: NDKNip07Signer | NDKPrivateKeySigner, autoConnectUserRelays: boolean): Promise<NDK> {
  if (_ndk) {
    try { _ndk.pool?.relays.forEach(r => r.disconnect()); } catch { /* best-effort cleanup */ }
  }
  const ndk = new NDK({
    explicitRelayUrls: BOOTSTRAP_RELAYS,
    signer,
    enableOutboxModel: true,
    autoConnectUserRelays,
  });
  await ndk.connect(3000);
  _ndk = ndk;
  return ndk;
}

export async function connectWithExtension(): Promise<string> {
  if (typeof window === 'undefined' || !('nostr' in window)) {
    throw new Error(
      'No Nostr extension found. Install Alby, nos2x, or another NIP-07 extension.',
    );
  }

  const signer = new NDKNip07Signer();

  // Check NIP-44 support before proceeding — not all extensions support it.
  try {
    const supported = await signer.encryptionEnabled?.('nip44');
    if (!supported || !supported.includes('nip44')) {
      throw new Error(
        'Your Nostr extension does not support NIP-44 encryption.\n' +
          'Please update it or use a compatible extension such as Alby.',
      );
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('NIP-44')) throw e;
    // encryptionEnabled may not exist on older extensions; try anyway.
  }

  await initNdk(signer, true);
  const user = await signer.user();
  return user.pubkey;
}

export async function connectWithTempKey(): Promise<{ pubkey: string; nsecHex: string }> {
  const signer = NDKPrivateKeySigner.generate();
  await initNdk(signer, false); // no key published so nothing to look up
  const user = await signer.user();
  return { pubkey: user.pubkey, nsecHex: signer.privateKey! };
}

export async function connectWithNsec(nsecOrHex: string): Promise<{ pubkey: string; nsecHex: string }> {
  let privkeyHex: string;
  if (nsecOrHex.startsWith('nsec1')) {
    const decoded = nip19.decode(nsecOrHex);
    if (decoded.type !== 'nsec') throw new Error('Invalid nsec');
    privkeyHex = Array.from(decoded.data as Uint8Array)
      .map(b => b.toString(16).padStart(2, '0')).join('');
  } else {
    if (!/^[0-9a-f]{64}$/i.test(nsecOrHex)) throw new Error('Invalid private key — must be nsec1… or 64-char hex');
    privkeyHex = nsecOrHex.toLowerCase();
  }
  const signer = new NDKPrivateKeySigner(privkeyHex);
  await initNdk(signer, true);
  const user = await signer.user();
  return { pubkey: user.pubkey, nsecHex: privkeyHex };
}

export function nsecHexToBech32(nsecHex: string): string {
  const bytes = new Uint8Array(nsecHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  return nip19.nsecEncode(bytes);
}

/** Reconnect using a previously saved ephemeral private key (hex). */
export async function connectWithSavedKey(nsecHex: string): Promise<string> {
  const signer = new NDKPrivateKeySigner(nsecHex);
  await initNdk(signer, false);
  const user = await signer.user();
  return user.pubkey;
}

/**
 * Fetches both players' latest game events, decrypts them, and returns the
 * state with the higher moveNumber — that's the ground truth after a reconnect.
 * Also returns the ID of our own latest event (needed for the `prev` tag).
 */
export async function fetchLatestGameState(
  gameId: string,
  myPubkey: string,
  opponentPubkey: string,
): Promise<{ state: GameState; myLastEventId: string | null } | null> {
  const ndk = getNdk();

  const [myEvent, theirEvent] = await Promise.all([
    ndk.fetchEvent({ kinds: [GAME_KIND as number], authors: [myPubkey],       '#d': [gameId] }),
    ndk.fetchEvent({ kinds: [GAME_KIND as number], authors: [opponentPubkey], '#d': [gameId] }),
  ]);

  const candidates: { state: GameState; eventId: string; isMine: boolean }[] = [];

  // NIP-44 shared secret = ECDH(our_privkey, opponent_pubkey) in both directions.
  // Our own events were encrypted *to* the opponent, so decrypting them also
  // needs opponent_pubkey as the counterparty — not our own pubkey.
  const counterparty = new NDKUser({ pubkey: opponentPubkey });

  for (const [ev, isMine] of [[myEvent, true], [theirEvent, false]] as const) {
    if (!ev) continue;
    try {
      await ev.decrypt(counterparty, ndk.signer, 'nip44');
      candidates.push({ state: JSON.parse(ev.content) as GameState, eventId: ev.id, isMine });
    } catch {
      // relay may have returned a malformed or undecryptable event
    }
  }

  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => b.state.moveNumber > a.state.moveNumber ? b : a);
  const mine = candidates.find(c => c.isMine);

  return {
    state: best.state,
    myLastEventId: mine?.eventId ?? null,
  };
}

// ─── Profile publishing ───────────────────────────────────────────────────────

/** Publish a minimal kind-0 set_metadata event with just a display name. */
export async function publishProfile(displayName: string): Promise<void> {
  const ndk = getNdk();
  const event = new NDKEvent(ndk);
  event.kind = 0;
  event.content = JSON.stringify({ name: displayName, display_name: displayName });
  await event.publish();
}

// ─── Profile search ───────────────────────────────────────────────────────────

export interface ProfileSearchResult {
  pubkey: string;
  displayName: string | null;
  picture: string | null;
  nip05: string | null;
}

// Known NIP-50 full-text search relays, tried in parallel.
const SEARCH_RELAYS = [
  'wss://relay.nostr.band',
  'wss://search.nos.lol',
  'wss://relay.snort.social',
];

interface SearchHandle {
  promise: Promise<ProfileSearchResult[]>;
  cancel: () => void;
}

function searchOnRelay(relayUrl: string, query: string, limit: number): SearchHandle {
  let ws: WebSocket | undefined;
  let done = false;
  let resolveFn!: (r: ProfileSearchResult[]) => void;
  const results: ProfileSearchResult[] = [];

  const finish = (res: ProfileSearchResult[] = results) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { ws?.close(); } catch { /* ignore */ }
    resolveFn(res);
  };

  const timer = setTimeout(() => finish(), 5000);

  const promise = new Promise<ProfileSearchResult[]>(resolve => {
    resolveFn = resolve;

    try {
      ws = new WebSocket(relayUrl);
    } catch {
      clearTimeout(timer);
      resolve([]);
      return;
    }

    const subId = Math.random().toString(36).slice(2, 10);

    ws.onopen = () => {
      ws!.send(JSON.stringify(['REQ', subId, { kinds: [0], search: query, limit }]));
    };

    ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as unknown[];
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          const ev = msg[2] as { pubkey: string; content: string };
          const p = JSON.parse(ev.content) as Record<string, string>;
          results.push({
            pubkey: ev.pubkey,
            displayName: p.display_name?.trim() || p.name?.trim() || null,
            picture: p.picture?.trim() || p.image?.trim() || null,
            nip05: p.nip05?.trim() || null,
          });
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          finish();
        }
      } catch { /* malformed message */ }
    };

    ws.onerror = () => finish();
    ws.onclose = () => finish();
  });

  return { promise, cancel: () => finish([]) };
}

// Track in-flight search handles so we can cancel them on new searches.
let _activeSearchHandles: SearchHandle[] = [];

export async function searchProfiles(
  query: string,
  limit = 8,
): Promise<ProfileSearchResult[]> {
  // Cancel any in-progress searches before starting new ones.
  _activeSearchHandles.forEach(h => h.cancel());
  _activeSearchHandles = [];

  const handles = SEARCH_RELAYS.map(url => searchOnRelay(url, query, limit));
  _activeSearchHandles = handles;

  return new Promise(resolve => {
    let settled = false;
    let pending = handles.length;

    for (const handle of handles) {
      handle.promise.then(results => {
        pending--;
        if (!settled && results.length > 0) {
          settled = true;
          _activeSearchHandles = [];
          resolve(results);
        } else if (pending === 0 && !settled) {
          settled = true;
          resolve([]);
        }
      });
    }
  });
}

// ─── User profiles ────────────────────────────────────────────────────────────

export interface UserProfile {
  displayName: string | null; // display_name → name fallback
  picture: string | null;
  nip05: string | null;
  nip05Valid: boolean;
}

const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const profileCache = new Map<string, { profile: UserProfile; ts: number }>();

/**
 * Verify NIP-05 by fetching /.well-known/nostr.json through a CORS proxy,
 * since most domains don't set CORS headers on that endpoint.
 * Falls back to an unverified state on any error.
 */
async function verifyNip05(nip05: string, pubkey: string): Promise<boolean> {
  const at = nip05.indexOf('@');
  if (at === -1) return false;
  const name = nip05.slice(0, at);
  const domain = nip05.slice(at + 1);
  if (!name || !domain) return false;

  const target = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

  const tryFetch = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return false;
      const data = await res.json() as { names?: Record<string, string> };
      return data?.names?.[name] === pubkey;
    } catch {
      return false;
    }
  };

  // Try direct first (some domains have CORS headers), then fall back to proxy.
  const direct = await tryFetch(target);
  if (direct) return true;
  return tryFetch(`https://corsproxy.io/?${encodeURIComponent(target)}`);
}

export async function fetchUserProfile(pubkey: string): Promise<UserProfile> {
  if (profileCache.has(pubkey)) {
    const entry = profileCache.get(pubkey)!;
    if (Date.now() - entry.ts < PROFILE_CACHE_TTL_MS) return entry.profile;
  }

  const ndk = getNdk();
  const user = ndk.getUser({ pubkey });
  await user.fetchProfile();

  const p = user.profile;
  const displayName = p?.displayName?.trim() || p?.name?.trim() || null;
  const picture = p?.picture?.trim() || p?.image?.trim() || null;
  const nip05 = p?.nip05?.trim() || null;

  let nip05Valid = false;
  if (nip05) {
    nip05Valid = await verifyNip05(nip05, pubkey);
  }

  const result: UserProfile = { displayName, picture, nip05, nip05Valid };
  profileCache.set(pubkey, { profile: result, ts: Date.now() });
  return result;
}

// ─── Identity helpers ─────────────────────────────────────────────────────────

export function pubkeyFromNpub(npub: string): string {
  const decoded = nip19.decode(npub.trim());
  if (decoded.type !== 'npub') throw new Error('Not a valid npub');
  return decoded.data as string;
}

export function npubFromPubkey(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

export function shortenNpub(npub: string): string {
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

// ─── Publish ──────────────────────────────────────────────────────────────────

export interface PublishOpts {
  gameId: string;
  p1Pubkey: string;
  p2Pubkey: string;
  myPlayer: 1 | 2;
  prevEventId: string | null;
  state: GameState;
}

/**
 * Publishes a game-state event (kind 30078) with NIP-44 encrypted content.
 * Returns the published event's ID.
 */
export async function publishMove(opts: PublishOpts): Promise<string> {
  const ndk = getNdk();
  const { gameId, p1Pubkey, p2Pubkey, myPlayer, prevEventId, state } = opts;
  const opponentPubkey = myPlayer === 1 ? p2Pubkey : p1Pubkey;

  const event = new NDKEvent(ndk);
  event.kind = GAME_KIND;
  event.tags = [
    ['d', gameId],
    ['p', p1Pubkey],
    ['p', p2Pubkey],
    ['t', 'quoridor'],
    ['move', state.moveNumber.toString()],
    ...(prevEventId ? [['prev', prevEventId]] : []),
  ];

  // Save plaintext before encrypt() overwrites event.content with ciphertext.
  const plaintext = JSON.stringify(state);
  event.content = plaintext;

  const recipient = ndk.getUser({ pubkey: opponentPubkey });
  await event.encrypt(recipient, ndk.signer, 'nip44');

  const relays = await event.publish();
  if (relays.size === 0) throw new Error('Move not accepted by any relay');

  return event.id;
}

// ─── Matchmaking ──────────────────────────────────────────────────────────────

/** How long a seek event is considered fresh. */
export const SEEK_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Publish a "looking for game" replaceable event. Returns the event id. */
export async function publishSeek(seekId: string): Promise<string> {
  const ndk = getNdk();
  const event = new NDKEvent(ndk);
  event.kind = GAME_KIND;
  event.tags = [
    ['d', `quoridor-seek-${seekId}`],
    ['t', 'quoridor'],
    ['t', 'quoridor-seek'],
    ['v', String(GAME_VERSION)],
  ];
  event.content = '';
  const relays = await event.publish();
  if (relays.size === 0) throw new Error('Seek not accepted by any relay');
  return event.id;
}

/** NIP-09 delete the seek event so other clients see it's gone. Best-effort. */
export async function cancelSeek(seekEventId: string): Promise<void> {
  const ndk = getNdk();
  const del = new NDKEvent(ndk);
  del.kind = 5;
  del.tags = [['e', seekEventId]];
  del.content = 'seek cancelled';
  await del.publish().catch(() => {});
}

export interface SeekListEntry {
  pubkey: string;
  dTag: string;       // e.g. "quoridor-seek-uuid-1"
  createdAt: number;  // unix seconds
}

/**
 * Subscribe to all active seeks for display as a list.
 * Fires onSeek for each arriving/replacing event.
 * No batching/sorting — caller sorts client-side.
 * Includes own seeks so the user sees themselves in the list.
 */
export function subscribeToSeekList(
  onSeek: (entry: SeekListEntry) => void,
): NDKSubscription {
  const ndk = getNdk();
  const since = Math.floor((Date.now() - SEEK_EXPIRY_MS) / 1000);
  const sub = ndk.subscribe(
    { kinds: [GAME_KIND as number], '#t': ['quoridor-seek'], '#v': [String(GAME_VERSION)], since },
    { closeOnEose: false, groupable: false },
  );

  sub.on('event', (ev: NDKEvent) => {
    const age = Date.now() - (ev.created_at ?? 0) * 1000;
    if (age > SEEK_EXPIRY_MS) return;
    const dTag = ev.tags.find(t => t[0] === 'd')?.[1];
    if (!dTag) return;
    onSeek({ pubkey: ev.pubkey, dTag, createdAt: ev.created_at ?? 0 });
  });

  return sub;
}

/**
 * Cancel all active seek events published by myPubkey (from any session).
 * Called on lobby entry to clean up orphaned seeks left by closed tabs.
 */
export async function cancelOwnStaleSeeks(myPubkey: string): Promise<void> {
  const ndk = getNdk();
  const since = Math.floor((Date.now() - SEEK_EXPIRY_MS) / 1000);
  let events: Set<NDKEvent>;
  try {
    events = await ndk.fetchEvents({
      kinds: [GAME_KIND as number],
      authors: [myPubkey],
      '#t': ['quoridor-seek'],
      since,
    });
  } catch {
    return;
  }
  for (const ev of events) {
    cancelSeek(ev.id).catch(() => {});
  }
}

// ─── Match claims ─────────────────────────────────────────────────────────────

/**
 * Publish a lightweight "match claim" event when a picker selects a seeker.
 * Published before the game state and invite so other clients can see the
 * seek is taken as early as possible.
 * Returns the event's created_at timestamp (unix seconds).
 */
export async function publishMatchClaim(
  seekDTag: string,
  seekerPubkey: string,
): Promise<number> {
  const ndk = getNdk();
  const event = new NDKEvent(ndk);
  event.kind = GAME_KIND;
  event.tags = [
    ['d', `quoridor-match-${seekDTag}`],
    ['t', 'quoridor'],
    ['t', 'quoridor-match'],
    ['p', seekerPubkey],
  ];
  event.content = '';
  const relays = await event.publish();
  if (relays.size === 0) throw new Error('Match claim not accepted by any relay');
  return event.created_at ?? Math.floor(Date.now() / 1000);
}

/**
 * Subscribe to all match claim events in the lobby so the seek list can
 * remove entries and detect race conditions the moment a claim is seen.
 */
export function subscribeToMatchClaims(
  onClaimed: (seekDTag: string, pickerPubkey: string, timestamp: number) => void,
): NDKSubscription {
  const ndk = getNdk();
  const since = Math.floor((Date.now() - SEEK_EXPIRY_MS) / 1000);
  const sub = ndk.subscribe(
    { kinds: [GAME_KIND as number], '#t': ['quoridor-match'], since },
    { closeOnEose: false, groupable: false },
  );
  sub.on('event', (ev: NDKEvent) => {
    const dTag = ev.tags.find(t => t[0] === 'd')?.[1]; // "quoridor-match-{seekDTag}"
    const seekDTag = dTag?.replace(/^quoridor-match-/, '');
    if (seekDTag) onClaimed(seekDTag, ev.pubkey, ev.created_at ?? 0);
  });
  return sub;
}

/**
 * One-shot fetch: return the earliest match claim for a given seek, or null
 * if none exists. Used for the pre-flight check in handlePickSeeker.
 */
export async function fetchMatchClaim(
  seekDTag: string,
): Promise<{ pickerPubkey: string; timestamp: number } | null> {
  const ndk = getNdk();
  const since = Math.floor((Date.now() - SEEK_EXPIRY_MS) / 1000);
  try {
    const events = await ndk.fetchEvents({
      kinds: [GAME_KIND as number],
      '#d': [`quoridor-match-${seekDTag}`],
      since,
    });
    if (events.size === 0) return null;
    const earliest = [...events].reduce((a, b) =>
      (a.created_at ?? 0) < (b.created_at ?? 0) ? a : b,
    );
    return { pickerPubkey: earliest.pubkey, timestamp: earliest.created_at ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Publish a game invite to a specific seeker. The join code is public — the
 * game content itself is NIP-44 encrypted so this is safe.
 */
export async function publishInvite(
  seekerPubkey: string,
  gameId: string,
  joinCode: string,
  seekerSeekDTag: string,
): Promise<void> {
  const ndk = getNdk();
  const event = new NDKEvent(ndk);
  event.kind = GAME_KIND;
  event.tags = [
    ['d', `quoridor-invite-${gameId}`],
    ['t', 'quoridor'],
    ['t', 'quoridor-invite'],
    ['p', seekerPubkey],
    ['seek', seekerSeekDTag],
  ];
  event.content = joinCode;
  await event.publish();
}

/** Subscribe to game invites addressed to myPubkey. */
export function subscribeToInvites(
  myPubkey: string,
  onInvite: (joinCode: string, inviterPubkey: string, seekDTag: string) => void,
): NDKSubscription {
  const ndk = getNdk();
  const since = Math.floor((Date.now() - SEEK_EXPIRY_MS) / 1000); // 24h window for async matchmaking
  const sub = ndk.subscribe(
    {
      kinds: [GAME_KIND as number],
      '#t': ['quoridor-invite'],
      '#p': [myPubkey],
      since,
    },
    { closeOnEose: false, groupable: false },
  );
  sub.on('event', (ev: NDKEvent) => {
    if (ev.content) {
      const seekDTag = ev.tags.find(t => t[0] === 'seek')?.[1] ?? '';
      onInvite(ev.content, ev.pubkey, seekDTag);
    }
  });
  return sub;
}

// ─── Subscribe ────────────────────────────────────────────────────────────────

/**
 * Subscribes to the opponent's game-state events for the given game.
 * Calls onState whenever a newer (higher moveNumber) state arrives.
 * Returns the NDKSubscription so the caller can call .stop() on cleanup.
 */
export function subscribeToGame(
  gameId: string,
  opponentPubkey: string,
  myPlayer: Player,
  getCurrentState: () => GameState | null,
  onState: (state: GameState) => void,
): NDKSubscription {
  const ndk = getNdk();

  const filter: NDKFilter = {
    kinds: [GAME_KIND as number],
    '#d': [gameId],
    '#t': ['quoridor'],
    authors: [opponentPubkey],
  };

  const sub = ndk.subscribe(filter, {
    closeOnEose: false,  // stay open for live moves
    groupable: false,    // don't batch-delay — game moves are latency-sensitive
  });

  const opponentUser = new NDKUser({ pubkey: opponentPubkey });

  sub.on('event', async (event: NDKEvent) => {
    try {
      // decrypt() mutates event.content from ciphertext → plaintext
      await event.decrypt(opponentUser, ndk.signer, 'nip44');
      const state = JSON.parse(event.content) as GameState;
      const current = getCurrentState();
      const opponentPlayer = (3 - myPlayer) as Player;
      if (current && !validateIncomingState(current, state, opponentPlayer)) {
        // If the incoming state is ahead of ours, accept it anyway — we may
        // have missed intermediate events (subscription drop, relay rate-limit).
        // The full board is in every event, so skipping per-move validation is
        // safe enough; rejecting would leave the game permanently stuck.
        if (state.moveNumber <= current.moveNumber) {
          console.warn('Rejected invalid game state from opponent');
          return;
        }
        console.warn('Accepting ahead-of-sequence state (missed %d moves)',
          state.moveNumber - current.moveNumber);
      }
      onState(state);
    } catch (err) {
      console.error('Failed to decrypt/parse game event:', err);
    }
  });

  return sub;
}
