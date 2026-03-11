import NDK, {
  NDKNip07Signer,
  NDKPrivateKeySigner,
  NDKEvent,
  NDKUser,
  NDKSubscription,
  type NDKFilter,
} from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import type { GameState } from './game';

// ─── Constants ───────────────────────────────────────────────────────────────

export const GAME_KIND = 30078;

// Bootstrap relays used for connection and fallback.
// purplepag.es indexes NIP-65 relay lists, which NDK uses for outbox routing.
const BOOTSTRAP_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

// ─── NDK singleton ────────────────────────────────────────────────────────────

let _ndk: NDK | null = null;

export function getNdk(): NDK {
  if (!_ndk) throw new Error('NDK not initialised — call connect first');
  return _ndk;
}

// ─── Connection ───────────────────────────────────────────────────────────────

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

  _ndk = new NDK({
    explicitRelayUrls: BOOTSTRAP_RELAYS,
    signer,
    enableOutboxModel: true,
    autoConnectUserRelays: true,
  });

  await _ndk.connect(3000);
  const user = await signer.user();
  return user.pubkey;
}

export async function connectWithTempKey(): Promise<{ pubkey: string; nsecHex: string }> {
  const signer = NDKPrivateKeySigner.generate();

  _ndk = new NDK({
    explicitRelayUrls: BOOTSTRAP_RELAYS,
    signer,
    enableOutboxModel: true,
    autoConnectUserRelays: false, // no key published so nothing to look up
  });

  await _ndk.connect(3000);
  const user = await signer.user();
  return { pubkey: user.pubkey, nsecHex: signer.privateKey! };
}

/** Reconnect using a previously saved ephemeral private key (hex). */
export async function connectWithSavedKey(nsecHex: string): Promise<string> {
  const signer = new NDKPrivateKeySigner(nsecHex);

  _ndk = new NDK({
    explicitRelayUrls: BOOTSTRAP_RELAYS,
    signer,
    enableOutboxModel: true,
    autoConnectUserRelays: false,
  });

  await _ndk.connect(3000);
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

// ─── Subscribe ────────────────────────────────────────────────────────────────

/**
 * Subscribes to the opponent's game-state events for the given game.
 * Calls onState whenever a newer (higher moveNumber) state arrives.
 * Returns the NDKSubscription so the caller can call .stop() on cleanup.
 */
export function subscribeToGame(
  gameId: string,
  opponentPubkey: string,
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
      onState(state);
    } catch (err) {
      console.error('Failed to decrypt/parse game event:', err);
    }
  });

  return sub;
}
