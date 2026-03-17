import { useState, useEffect, useRef } from 'react';
import {
  searchProfiles,
  pubkeyFromNpub,
  npubFromPubkey,
  shortenNpub,
  type ProfileSearchResult,
} from './nostr';
import { useProfile } from './UserCard';

// ─── Selected badge ───────────────────────────────────────────────────────────

function SelectedUser({ pubkey, onClear }: { pubkey: string; onClear: () => void }) {
  const profile = useProfile(pubkey);
  const npub = npubFromPubkey(pubkey);
  const name = profile?.displayName ?? shortenNpub(npub);

  return (
    <div className="search-selected">
      {profile?.picture && (
        <img src={profile.picture} alt="" className="avatar-img" width={24} height={24}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      )}
      <span className="search-selected-name">{name}</span>
      {profile?.nip05 && (
        <span className="search-selected-nip05">{profile.nip05.startsWith('_@') ? profile.nip05.slice(2) : profile.nip05}</span>
      )}
      <button className="search-clear" onClick={onClear} title="Change opponent">✕</button>
    </div>
  );
}

// ─── Result row ───────────────────────────────────────────────────────────────

function ResultRow({ result, onSelect }: { result: ProfileSearchResult; onSelect: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const nip05Label = result.nip05?.startsWith('_@')
    ? result.nip05.slice(2)
    : result.nip05;

  return (
    <button className="search-result" onMouseDown={onSelect}>
      {result.picture && !imgFailed ? (
        <img src={result.picture} alt="" className="avatar-img" width={28} height={28}
          onError={() => setImgFailed(true)} />
      ) : (
        <div className="avatar-fallback" style={{
          width: 28, height: 28, fontSize: 12,
          background: `hsl(${parseInt(result.pubkey.slice(0, 8), 16) % 360}, 55%, 40%)`,
        }}>
          {(result.displayName ?? '?')[0].toUpperCase()}
        </div>
      )}
      <div className="search-result-info">
        <span className="search-result-name">{result.displayName ?? shortenNpub(npubFromPubkey(result.pubkey))}</span>
        {nip05Label && <span className="search-result-nip05">{nip05Label}</span>}
      </div>
    </button>
  );
}

// ─── PlayerSearch ─────────────────────────────────────────────────────────────

interface PlayerSearchProps {
  onSelect: (pubkey: string) => void;
  onClear: () => void;
  selectedPubkey: string | null;
}

export function PlayerSearch({ onSelect, onClear, selectedPubkey }: PlayerSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProfileSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isNpub = query.trim().toLowerCase().startsWith('npub1');

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (isNpub || query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await searchProfiles(query.trim());
        setResults(r);
        setOpen(r.length > 0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 400);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, isNpub]);

  const handleSelect = (pubkey: string) => {
    setOpen(false);
    setQuery('');
    setResults([]);
    onSelect(pubkey);
  };

  const handleNpubConfirm = () => {
    try {
      const pubkey = pubkeyFromNpub(query.trim());
      handleSelect(pubkey);
    } catch {
      // invalid — leave as-is, parent will show error on submit
    }
  };

  if (selectedPubkey) {
    return <SelectedUser pubkey={selectedPubkey} onClear={() => { onClear(); setQuery(''); }} />;
  }

  return (
    <div className="player-search">
      <div className="search-input-row">
        <input
          ref={inputRef}
          className="form-input"
          placeholder="Search by name or paste player ID…"
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={e => { if (e.key === 'Enter' && isNpub) handleNpubConfirm(); }}
          autoComplete="off"
        />
        {loading && <span className="search-spinner" />}
        {isNpub && query.trim().length > 10 && (
          <button className="btn btn-small btn-ghost" onClick={handleNpubConfirm}>Use</button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="search-dropdown">
          {results.map(r => (
            <ResultRow key={r.pubkey} result={r} onSelect={() => handleSelect(r.pubkey)} />
          ))}
        </div>
      )}
    </div>
  );
}
