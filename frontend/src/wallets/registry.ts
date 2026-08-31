/**
 * Curated Solana wallet registry for the connect picker.
 *
 * Ported from Kintara.com's `wallet-registry.mjs` (same catalog, icons, merge +
 * ordering logic) — lets high-value wallets render in the picker even when not
 * installed locally, each with an install / deep-link CTA. Detected Wallet
 * Standard wallets are merged on top so an installed wallet always shows as
 * connectable, and unknown installed wallets still appear even if they aren't in
 * this curated list.
 *
 * Pure data + merge logic — no DOM, no browser APIs.
 */

const svg = (markup: string) =>
  'data:image/svg+xml,' + encodeURIComponent(markup.replace(/\s+/g, ' ').trim());

const WALLET_ICONS: Record<string, string> = {
  phantom: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#AB9FF2"/><path fill="#fff" d="M32 16c-9.6 0-17.4 7.6-17.4 17v11.5c0 1.4 1.7 2.1 2.7 1.1l2.6-2.5c.7-.7 1.8-.7 2.5 0l2.4 2.4c.7.7 1.8.7 2.5 0l2.4-2.3c.7-.7 1.8-.7 2.5 0l2.4 2.3c.7.7 1.8.7 2.5 0l2.4-2.4c.7-.7 1.8-.7 2.5 0l2.6 2.5c1 1 2.7.3 2.7-1.1V33c0-9.4-7.8-17-17.5-17z"/><ellipse cx="28" cy="32" rx="2.7" ry="4.1" fill="#AB9FF2"/><ellipse cx="37" cy="32" rx="2.7" ry="4.1" fill="#AB9FF2"/></svg>`),
  solflare: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="sf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD23F"/><stop offset="1" stop-color="#FE8B01"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#sf)"/><circle cx="32" cy="32" r="8.5" fill="#fff"/><g fill="#fff"><circle cx="32" cy="15" r="3"/><circle cx="32" cy="49" r="3"/><circle cx="15" cy="32" r="3"/><circle cx="49" cy="32" r="3"/><circle cx="20" cy="20" r="2.3"/><circle cx="44" cy="44" r="2.3"/><circle cx="44" cy="20" r="2.3"/><circle cx="20" cy="44" r="2.3"/></g></svg>`),
  backpack: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#E33E3F"/><path fill="#fff" d="M23 27c0-5 4-9 9-9s9 4 9 9v1.2c2.8.8 5 3.4 5 6.6v12.2c0 2.2-1.8 4-4 4H22c-2.2 0-4-1.8-4-4V34.8c0-3.2 2.2-5.8 5-6.6V27zm5 .6h8V27c0-2.2-1.8-4-4-4s-4 1.8-4 4v.6z"/><rect x="27" y="38" width="10" height="6" rx="2" fill="#E33E3F"/></svg>`),
  coinbase: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#0052FF"/><circle cx="32" cy="32" r="15" fill="#fff"/><rect x="26" y="26" width="12" height="12" rx="2.5" fill="#0052FF"/></svg>`),
  okx: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#0b0b0b"/><g fill="#fff"><rect x="14" y="14" width="12" height="12" rx="2"/><rect x="38" y="14" width="12" height="12" rx="2"/><rect x="26" y="26" width="12" height="12" rx="2"/><rect x="14" y="38" width="12" height="12" rx="2"/><rect x="38" y="38" width="12" height="12" rx="2"/></g></svg>`),
  trust: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#3375BB"/><path fill="#fff" d="M32 16l13 4.6v11.2c0 9.8-5.4 15.6-13 19.2-7.6-3.6-13-9.4-13-19.2V20.6z"/></svg>`),
  metamask: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#fff"/><g transform="translate(11 12.5) scale(1.2)"><g stroke-linecap="round" stroke-linejoin="round" stroke-width=".25"><path d="m32.9582 1-13.1341 9.7183 2.4424-5.72731z" fill="#e17726" stroke="#e17726"/><g fill="#e27625" stroke="#e27625"><path d="m2.66296 1 13.01714 9.809-2.3254-5.81802z"/><path d="m28.2295 23.5335-3.4947 5.3386 7.4829 2.0603 2.1436-7.2823z"/><path d="m1.27281 23.6501 2.13055 7.2823 7.46994-2.0603-3.48166-5.3386z"/><path d="m10.4706 14.5149-2.0786 3.1358 7.405.3369-.2469-7.969z"/><path d="m25.1505 14.5149-5.1575-4.58704-.1688 8.05974 7.4049-.3369z"/><path d="m10.8733 28.8721 4.4819-2.1639-3.8583-3.0062z"/><path d="m20.2659 26.7082 4.4689 2.1639-.6105-5.1701z"/></g><path d="m24.7348 28.8721-4.469-2.1639.3638 2.9025-.039 1.231z" fill="#d5bfb2" stroke="#d5bfb2"/><path d="m10.8732 28.8721 4.1572 1.9696-.026-1.231.3508-2.9025z" fill="#d5bfb2" stroke="#d5bfb2"/><path d="m15.1084 21.7842-3.7155-1.0884 2.6243-1.2051z" fill="#233447" stroke="#233447"/><path d="m20.5126 21.7842 1.0913-2.2935 2.6372 1.2051z" fill="#233447" stroke="#233447"/><path d="m10.8733 28.8721.6495-5.3386-4.13117.1167z" fill="#cc6228" stroke="#cc6228"/><path d="m24.0982 23.5335.6366 5.3386 3.4946-5.2219z" fill="#cc6228" stroke="#cc6228"/><path d="m27.2291 17.6507-7.405.3369.6885 3.7966 1.0913-2.2935 2.6372 1.2051z" fill="#cc6228" stroke="#cc6228"/><path d="m11.3929 20.6958 2.6242-1.2051 1.0913 2.2935.6885-3.7966-7.40495-.3369z" fill="#cc6228" stroke="#cc6228"/><path d="m8.392 17.6507 3.1049 6.0513-.1039-3.0062z" fill="#e27525" stroke="#e27525"/><path d="m24.2412 20.6958-.1169 3.0062 3.1049-6.0513z" fill="#e27525" stroke="#e27525"/><path d="m15.797 17.9876-.6886 3.7967.8704 4.4833.1949-5.9087z" fill="#e27525" stroke="#e27525"/><path d="m19.8242 17.9876-.3638 2.3584.1819 5.9216.8704-4.4833z" fill="#e27525" stroke="#e27525"/><path d="m20.5127 21.7842-.8704 4.4834.6236.4406 3.8584-3.0062.1169-3.0062z" fill="#f5841f" stroke="#f5841f"/><path d="m11.3929 20.6958.104 3.0062 3.8583 3.0062.6236-.4406-.8704-4.4834z" fill="#f5841f" stroke="#f5841f"/><path d="m20.5906 30.8417.039-1.231-.3378-.2851h-4.9626l-.3248.2851.026 1.231-4.1572-1.9696 1.4551 1.1921 2.9489 2.0344h5.0536l2.962-2.0344 1.442-1.1921z" fill="#c0ac9d" stroke="#c0ac9d"/><path d="m20.2659 26.7082-.6236-.4406h-3.6635l-.6236.4406-.3508 2.9025.3248-.2851h4.9626l.3378.2851z" fill="#161616" stroke="#161616"/><path d="m33.5168 11.3532 1.1043-5.36447-1.6629-4.98873-12.6923 9.3944 4.8846 4.1205 6.8983 2.0085 1.52-1.7752-.6626-.4795 1.0523-.9588-.8054-.622 1.0523-.8034z" fill="#763e1a" stroke="#763e1a"/><path d="m1 5.98873 1.11724 5.36447-.71451.5313 1.06527.8034-.80545.622 1.05228.9588-.66255.4795 1.51997 1.7752 6.89835-2.0085 4.8846-4.1205-12.69233-9.3944z" fill="#763e1a" stroke="#763e1a"/><path d="m32.0489 16.5234-6.8983-2.0085 2.0786 3.1358-3.1049 6.0513 4.1052-.0519h6.1318z" fill="#f5841f" stroke="#f5841f"/><path d="m10.4705 14.5149-6.89828 2.0085-2.29944 7.1267h6.11883l4.10519.0519-3.10487-6.0513z" fill="#f5841f" stroke="#f5841f"/><path d="m19.8241 17.9876.4417-7.5932 2.0007-5.4034h-8.9119l2.0006 5.4034.4417 7.5932.1689 2.3842.013 5.8958h3.6635l.013-5.8958z" fill="#f5841f" stroke="#f5841f"/></g></g></svg>`),
  brave: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="bv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF5500"/><stop offset="1" stop-color="#FF2000"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#bv)"/><path fill="#fff" d="M32 17c-3 0-5 1.5-6.5 3.5C23 19 20 19 20 19s.5 3 2 4.5c-2 2-3 5-3 8 0 8 6 13 13 13s13-5 13-13c0-3-1-6-3-8 1.5-1.5 2-4.5 2-4.5s-3 0-5.5 1.5C37 18.5 35 17 32 17z"/></svg>`),
  glow: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="gl" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#FFE873"/><stop offset="1" stop-color="#FF9417"/></radialGradient></defs><rect width="64" height="64" rx="15" fill="#1a1205"/><circle cx="32" cy="32" r="16" fill="url(#gl)"/><circle cx="32" cy="32" r="9" fill="#fff" opacity=".85"/></svg>`),
  exodus: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="ex" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8C66FC"/><stop offset="1" stop-color="#1F8FFF"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="#1B1136"/><path fill="url(#ex)" d="M32 16l16 16-16 16-6-6 10-10-10-10z"/><path fill="#fff" opacity=".55" d="M32 16L16 32l16 16 6-6-10-10 10-10z"/></svg>`),
  jupiter: svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#0E1726"/><circle cx="32" cy="32" r="13" fill="#22D1AA"/><ellipse cx="32" cy="32" rx="19" ry="6" fill="none" stroke="#C7F284" stroke-width="2.6" transform="rotate(-20 32 32)"/></svg>`),
};

export interface CuratedWallet {
  id: string;
  name: string;
  match: RegExp;
  installUrl: string;
  icon: string;
  injected?: string[];
}

/**
 * Curated Solana wallets. Array order = the rank used to sort NOT-installed
 * wallets in the picker. First three are FEATURED in a fixed order (Phantom,
 * MetaMask, Jupiter) regardless of market share; the rest follow by approximate
 * market share. Installed wallets always sort above this list.
 */
export const CURATED_WALLETS: CuratedWallet[] = [
  { id: 'phantom', name: 'Phantom', match: /phantom/i, installUrl: 'https://phantom.app/download', icon: WALLET_ICONS.phantom, injected: ['phantom.solana'] },
  { id: 'metamask', name: 'MetaMask', match: /meta\s*mask/i, installUrl: 'https://metamask.io/download/', icon: WALLET_ICONS.metamask },
  { id: 'jupiter', name: 'Jupiter', match: /jupiter|jup\b/i, installUrl: 'https://www.jup.ag/wallet', icon: WALLET_ICONS.jupiter },
  { id: 'solflare', name: 'Solflare', match: /solflare/i, installUrl: 'https://solflare.com/download', icon: WALLET_ICONS.solflare, injected: ['solflare'] },
  { id: 'backpack', name: 'Backpack', match: /backpack/i, installUrl: 'https://backpack.app/download', icon: WALLET_ICONS.backpack, injected: ['backpack'] },
  { id: 'coinbase', name: 'Coinbase Wallet', match: /coinbase/i, installUrl: 'https://www.coinbase.com/wallet/downloads', icon: WALLET_ICONS.coinbase, injected: ['coinbaseSolana'] },
  { id: 'okx', name: 'OKX Wallet', match: /okx/i, installUrl: 'https://www.okx.com/web3', icon: WALLET_ICONS.okx, injected: ['okxwallet.solana'] },
  { id: 'trust', name: 'Trust Wallet', match: /trust/i, installUrl: 'https://trustwallet.com/download', icon: WALLET_ICONS.trust, injected: ['trustwallet.solana'] },
  { id: 'brave', name: 'Brave Wallet', match: /brave/i, installUrl: 'https://brave.com/wallet/', icon: WALLET_ICONS.brave, injected: ['braveSolana'] },
  { id: 'glow', name: 'Glow', match: /glow/i, installUrl: 'https://glow.app/download', icon: WALLET_ICONS.glow, injected: ['glowSolana', 'glow'] },
  { id: 'exodus', name: 'Exodus', match: /exodus/i, installUrl: 'https://www.exodus.com/download/', icon: WALLET_ICONS.exodus, injected: ['exodus.solana'] },
];

export function curatedIconForId(id: string): string {
  const entry = CURATED_WALLETS.find((c) => c.id === id);
  return entry && entry.icon ? entry.icon : '';
}

export function curatedRank(id: string): number {
  const i = CURATED_WALLETS.findIndex((c) => c.id === id);
  return i === -1 ? 999 : i;
}

export function curatedEntryForName(name: string): CuratedWallet | null {
  const n = String(name || '');
  if (!n) return null;
  return CURATED_WALLETS.find((c) => c.match.test(n)) || null;
}

/** Stable id for a wallet name (curated id if known, else a slug). */
export function idForName(name: string): string {
  const entry = curatedEntryForName(name);
  if (entry) return entry.id;
  return `w:${String(name || 'wallet').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export type WalletEntryKind = 'wallet-standard' | 'injected' | 'install';

export interface WalletEntry {
  id: string;
  name: string;
  icon: string;
  rank: number;
  kind: WalletEntryKind;
  installUrl?: string;
  /** Wallet Standard adapter (from useWallet().wallets) the entry maps to. */
  adapter?: unknown;
  remote?: boolean;
}

/**
 * Build the picker list. Installed wallets come first (Wallet Standard
 * detections + injected providers), then the curated catalog of not-installed
 * wallets as install CTAs. Ordering is applied by {@link orderWalletEntries}.
 */
export function buildWalletList(
  opts: { detected?: { name: string; icon?: string; adapter: unknown }[]; includeCurated?: boolean } = {}
): WalletEntry[] {
  const detected = Array.isArray(opts.detected) ? opts.detected : [];
  const includeCurated = opts.includeCurated !== false;

  const out: WalletEntry[] = [];
  const seenIds = new Set<string>();

  for (const w of detected) {
    const id = idForName(w.name);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    out.push({
      id,
      name: String(w.name || 'Wallet'),
      icon: String(w.icon || '') || curatedIconForId(id),
      kind: 'wallet-standard',
      adapter: w.adapter,
      rank: curatedRank(id),
    });
  }

  if (includeCurated) {
    for (const c of CURATED_WALLETS) {
      if (seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      out.push({
        id: c.id,
        name: c.name,
        icon: c.icon || '',
        kind: 'install',
        installUrl: c.installUrl,
        rank: curatedRank(c.id),
      });
    }
  }

  return out;
}

/**
 * Order picker entries in tiers:
 * 1. Installed wallets — most-recently-used, then market share.
 * 2. Remote connectable wallets (e.g. MetaMask without a local extension).
 * 3. Install CTAs — by market share.
 */
export function orderWalletEntries(
  list: WalletEntry[],
  recency: Record<string, number> = {}
): WalletEntry[] {
  const installed = list.filter((e) => e.kind !== 'install' && !e.remote);
  const remote = list.filter((e) => e.kind !== 'install' && e.remote);
  const installs = list.filter((e) => e.kind === 'install');
  const byShare = (a: WalletEntry, b: WalletEntry) => {
    const ra = typeof a.rank === 'number' ? a.rank : 999;
    const rb = typeof b.rank === 'number' ? b.rank : 999;
    if (ra !== rb) return ra - rb;
    return String(a.name).localeCompare(String(b.name));
  };
  installed.sort((a, b) => {
    const ua = recency[a.id] || 0;
    const ub = recency[b.id] || 0;
    if (ua !== ub) return ub - ua;
    return byShare(a, b);
  });
  remote.sort(byShare);
  installs.sort(byShare);
  return installed.concat(remote, installs);
}

export const WALLET_RECENCY_KEY = 'pw_wallet_recent_v1';

export function readWalletRecency(): Record<string, number> {
  try {
    const raw = localStorage.getItem(WALLET_RECENCY_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function recordWalletUsed(id: string): void {
  if (!id) return;
  try {
    const map = readWalletRecency();
    map[id] = Date.now();
    localStorage.setItem(WALLET_RECENCY_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota — recency is best-effort */
  }
}
