# Quoridor on Nostr

A peer-to-peer [Quoridor](https://en.wikipedia.org/wiki/Quoridor) board game that runs entirely in the browser. No server, no matchmaking backend — game state is published as encrypted events on [Nostr](https://nostr.com) relays.

**Source:** https://github.com/jeroenubbink/quoridor

---

## What is Quoridor?

Two players, one pawn each, opposite sides of a 9×9 grid. First to reach the other side wins. On each turn you either move your pawn or place a wall to slow your opponent down — but you can never fully trap them; a path to their goal must always remain open.

[Full rules on Wikipedia →](https://en.wikipedia.org/wiki/Quoridor)

---

## Features

- **No account needed** — jump in with an auto-generated anonymous name, or connect with a NIP-07 browser extension (Alby, nos2x, …) for a persistent Nostr identity
- **Fully peer-to-peer** — game state lives on Nostr relays as NIP-44 encrypted kind-30078 events; no central server
- **Seek list matchmaking** — browse players looking for a game and pick one; your own seek stays listed until you cancel it or get matched
- **Invite a specific player** — search by name or paste an npub; NIP-50 full-text search via relay.nostr.band
- **Multiple simultaneous games** — all games live side by side in the lobby, organised into Active / New / History tabs
- **Session persistence** — sessions survive page reloads; reconnect picks up the latest state from relays
- **Mobile-friendly** — reconnects and re-syncs game state when a backgrounded tab comes back into focus
- **Browser notifications** — get pinged when it's your turn
- **NIP-05 verification** — display names and verified identifiers shown via NIP-01 kind-0 profiles
- **Automatic timeout enforcement** — if an opponent does not move within 2 days the game resolves automatically; "no contest" if no moves were made at all
- **Resign support** — either player can resign at any time; the opponent is notified immediately

---

## Tech stack

| Layer | Library |
|---|---|
| Framework | React 19 + TypeScript |
| Build | Vite |
| Nostr | [NDK](https://github.com/nostr-dev-kit/ndk) v3 |
| Encryption | NIP-44 (via NDK) |
| Name generation | unique-names-generator |

---

## Running locally

```bash
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

To build for production:

```bash
npm run build
```

Output goes to `dist/` and can be served as a static site from any host.

---

## How it works

Each move is published as a **kind-30078 parameterized replaceable event**. The content is the full game state serialised as JSON and encrypted with NIP-44 to the opponent's public key. Because the event kind is replaceable, each player's relay only keeps their latest state — old moves are superseded automatically.

Matchmaking uses two event tags:
- `quoridor-seek` — broadcast that you're looking for a game (carries a `v` tag for protocol version); refreshed every 2 minutes to stay visible; stale seeks from closed tabs are cleaned up on lobby entry
- `quoridor-invite` — direct invite to a specific seeker (carries a `seek` tag referencing the matched seek d-tag so the seeker can cancel it)

The player who sends the invite is Player 1 and moves first.

Game state events carry a `version` field; a state update is rejected if it was produced by a different protocol version.

---

## License

[MIT](LICENSE)
