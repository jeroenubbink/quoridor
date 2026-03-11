import { useState, useEffect } from 'react';
import { fetchUserProfile, npubFromPubkey, shortenNpub, type UserProfile } from './nostr';

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useProfile(pubkey: string | null) {
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    fetchUserProfile(pubkey)
      .then(p => { if (!cancelled) setProfile(p); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pubkey]);

  return profile;
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

function pubkeyHue(pubkey: string): number {
  return parseInt(pubkey.slice(0, 8), 16) % 360;
}

interface AvatarProps {
  pubkey: string;
  picture: string | null;
  size: number; // px
}

function Avatar({ pubkey, picture, size }: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const hue = pubkeyHue(pubkey);

  if (picture && !imgFailed) {
    return (
      <img
        src={picture}
        alt=""
        width={size}
        height={size}
        className="avatar-img"
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div
      className="avatar-fallback"
      style={{
        width: size,
        height: size,
        background: `hsl(${hue}, 55%, 40%)`,
        fontSize: size * 0.42,
      }}
    >
      {pubkey.slice(0, 1).toUpperCase()}
    </div>
  );
}

// ─── UserCard ─────────────────────────────────────────────────────────────────

interface UserCardProps {
  pubkey: string;
  /** 'sm' = avatar + name only; 'md' = + NIP-05; 'lg' = + full npub row */
  size?: 'sm' | 'md' | 'lg';
  /** Extra label shown above the name, e.g. "Player 1" */
  label?: string;
  playerColor?: 1 | 2;
}

export function UserCard({ pubkey, size = 'sm', label, playerColor }: UserCardProps) {
  const profile = useProfile(pubkey);
  const npub = npubFromPubkey(pubkey);
  const name = profile?.displayName ?? shortenNpub(npub);
  const avatarSize = size === 'lg' ? 48 : size === 'md' ? 36 : 28;

  const nip05Label = profile?.nip05
    ? profile.nip05.startsWith('_@')
      ? profile.nip05.slice(2)       // _@domain → domain
      : profile.nip05
    : null;

  return (
    <div className={`user-card user-card-${size}`}>
      <Avatar pubkey={pubkey} picture={profile?.picture ?? null} size={avatarSize} />
      <div className="user-card-body">
        {label && (
          <span className={`user-card-label${playerColor ? ` p${playerColor}-color` : ''}`}>
            {label}
          </span>
        )}
        <span className="user-card-name">{name}</span>
        {(size === 'md' || size === 'lg') && nip05Label && (
          <span className={`user-nip05 ${profile?.nip05Valid ? 'nip05-valid' : 'nip05-unverified'}`}>
            {profile?.nip05Valid ? '✓ ' : ''}{nip05Label}
          </span>
        )}
        {size === 'lg' && (
          <code className="user-npub">{npub}</code>
        )}
      </div>
    </div>
  );
}
