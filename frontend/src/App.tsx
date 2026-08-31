import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import {
  CoinbaseWalletAdapter,
  LedgerWalletAdapter,
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TorusWalletAdapter,
  TrustWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { PublicKey, Transaction } from "@solana/web3.js";
import { API_BASE } from "./api";
import "./App.css";
import { CanvasStage } from "./canvas/CanvasStage";
import { TopBar } from "./components/TopBar";
import { FillBar } from "./components/FillBar";
import { JackpotBar } from "./components/JackpotBar";
import { PixelPanel } from "./components/PixelPanel";
import { Leaderboard } from "./components/Leaderboard";
import { LiveFeed, LiveTicker } from "./components/LiveFeed";
import { BubbleNotifications, bubbleBody } from "./components/Notifications";
import { HoverTooltip } from "./components/HoverTooltip";
import { ReferralPanel } from "./components/ReferralPanel";
import { HowToPlay } from "./components/HowToPlay";
import { setLastWallet } from "./components/WalletPill";
import { useBoard } from "./hooks/useBoard";
import { useQuote } from "./hooks/useQuote";
import { useEvents, type NotifItem } from "./hooks/useEvents";
import { usePools } from "./hooks/usePools";
import { useNukes } from "./hooks/useNukes";
import { useKols } from "./hooks/useKols";
import { useReferral } from "./hooks/useReferral";
import { useSseStatus } from "./hooks/useSseStatus";
import { WalletPicker } from "./components/WalletPicker";
import { Sheet, type SheetSnap } from "./components/Sheet";
import { AdminApp } from "./AdminApp";
import { ADMIN_PATH } from "./adminPath";
import { buildPurchaseIxs } from "./pay";
import { useIsMobile } from "./hooks/useMediaQuery";
import { useTheme } from "./theme";
import { deriveCellInfo, fmtSol } from "./pricing";

// All on-chain RPC traffic is proxied through the backend (`/api/rpc`) so the Helius
// API key stays server-side and never leaks into the bundle. VITE_RPC_OVERRIDE is a
// debug-only escape hatch that bypasses the proxy; leave it unset in production.
//
// web3.js `new Connection()` REJECTS relative URLs ("Endpoint URL must start with
// http:/https:"), so the proxied `/api/rpc` must be absolutized against the page's
// origin. The vite proxy forwards that origin's /api/rpc to localhost:8787, and
// the wallet never sees a non-relative endpoint.
const endpoint = import.meta.env.VITE_RPC_OVERRIDE ?? new URL(`${API_BASE}/rpc`, window.location.origin).toString();
const ESCROW = import.meta.env.VITE_ESCROW_PUBLIC ?? "";

// A devnet/public-RPC getLatestBlockhash can take a second+ when rate-limited. The
// wallet adapter's sendTransaction(tx, connection) calls it synchronously right before
// it opens the approval popup for any tx WITHOUT a recentBlockhash, so that single RTT
// is pure dead time on the path from Buy-click → phantom popup. We keep the blockhash
// warm here (refetched when stale) and pin it on the Transaction, so sendTransaction
// never blocks. A refetched blockhash is only useful if it's still the canonical one at
// sign time; too-short cache vs. too-stale is a tradeoff. 20s balances both on a slow
// devnet.
const BLOCKHASH_FRESH_MS = 20_000;

function useWarmBlockhash(connection: any) {
  const ref = useRef<{ blockhash: string; at: number } | null>(null);
  // In-flight fetch so two concurrent buys share one RPC call instead of racing.
  const inflight = useRef<Promise<string> | null>(null);

  const get = useCallback(async (): Promise<string> => {
    const now = Date.now();
    if (ref.current && now - ref.current.at < BLOCKHASH_FRESH_MS) return ref.current.blockhash;
    if (inflight.current) return inflight.current;
    const p = connection
      .getLatestBlockhash("confirmed")
      .then((bh: any) => {
        ref.current = { blockhash: bh.blockhash, at: Date.now() };
        return bh.blockhash;
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, [connection]);

  // Keep the blockhash warm in the background so the FIRST buy (cold cache) doesn't
  // block on a getLatestBlockhash round-trip inside the Buy→popup path. Re-warm on an
  // interval just past the freshness window so the cache is virtually always hit.
  useEffect(() => {
    if (!connection) return;
    let alive = true;
    const warm = () => {
      if (!alive) return;
      get().catch(() => {}); // best-effort — a stale cache just means one buy waits once
    };
    warm(); // prime it immediately on mount
    const t = setInterval(() => {
      if (ref.current && Date.now() - ref.current.at < BLOCKHASH_FRESH_MS) return;
      warm();
    }, BLOCKHASH_FRESH_MS / 2);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connection, get]);

  return get;
}

function AppInner() {
  const { publicKey, connected, signTransaction, signMessage, wallet, select, connect } = useWallet();
  const { connection } = useConnection();
  const warmBlockhash = useWarmBlockhash(connection);
  const owner = publicKey?.toBase58() ?? null;

  // Read the "?ref=SLUG" param once on mount. Deliberately NOT stripped from the URL
  // here: the referral must stay visible until the wallet connects and the bind runs
  // (a page reload before connecting should NOT lose the invite context). Stripping
  // happens only after the bind resolves (see done() in the wallet-connect effect below).
  const refSlug = useRef<string | null>(null);
  {
    const params = new URLSearchParams(window.location.search);
    refSlug.current = params.get("ref");
  }
  const [referOpen, setReferOpen] = useState(false);

  // Persist the wallet address on connect → next visit (even if Phantom is closed)
  // TopBar still shows the user's wallet.
  useEffect(() => {
    if (connected && publicKey) setLastWallet(publicKey.toBase58());
  }, [connected, publicKey]);

  // Keep autoConnect from hanging in "Connecting" when Phantom is closed:
  // if the selected adapter is NotDetected, give up loading. If Installed/Loadable,
  // retry connecting (once the user picks it from the modal or Phantom opens).
  const [connErr, setConnErr] = useState<string | null>(null);
  useEffect(() => {
    if (connected || !wallet) return;
    const rs = wallet.readyState;
    if (rs === "Installed" || rs === "Loadable") {
      connect()
        .then(() => setConnErr(null))
        .catch((e: any) => setConnErr(e?.name ?? e?.message ?? String(e)));
    } else if (rs === "NotDetected") {
      select(null);
    }
  }, [wallet, connected, select, connect]);

  const { board, cells, liveBoard, pendingIntents } = useBoard();
  const { stale: sseStale } = useSseStatus(6000);
  const { pools, claim: doClaim } = usePools();
  const nukes = useNukes(owner);
  const kols = useKols();
  const [pickerOpen, setPickerOpen] = useState(false);
  const refer = useReferral(owner);

  // Bind the referral when a user who arrived via an invite link connects their wallet.
  // One-shot: refSlug is nulled after the signature; even if the bind call fails
  // (401/network) during the HELLO phase, no second signature prompt appears — a failed
  // real bind is left to the user via the panel's error + "retry" flow.
  // Once the attempt resolves (success OR the error nudge), drop ?ref=SLUG from the URL
  // so a later refresh doesn't re-trigger the bind — the invite context is captured by then.
  const bindAttempted = useRef(false);
  const clearRefSlug = useCallback(() => {
    refSlug.current = null;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("ref")) return;
    params.delete("ref");
    const qs = params.toString();
    history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }, []);
  useEffect(() => {
    if (!owner || !refSlug.current || bindAttempted.current) return;
    bindAttempted.current = true;
    const slug = refSlug.current;
    const done = () => clearRefSlug();
    if (signMessage) {
      refer.bind(owner, slug).then(done).catch(done);
    } else {
      done();
    }
  }, [owner, signMessage, refer.bind, clearRefSlug]);
  const { recent, notifs, dismiss, clear, activeCount } = useEvents({ myOwner: connected ? publicKey?.toBase58() ?? null : null });
  const { request: reqQuote, cancel: cancelQuote, confirm: confirmQuote } = useQuote();

  const isMobile = useIsMobile();
  const [lbOpen, setLbOpen] = useState(false);       // mobile leaderboard sheet
  const [feedOpen, setFeedOpen] = useState(false);   // mobile live feed sheet
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>("half"); // mobile pixel sheet snap
  const [lbCollapsed, setLbCollapsed] = useState(false); // desktop leaderboard rail
  const [autoApprove, setAutoApprove] = useState(false);
  const [notifOn, setNotifOn] = useState(true);
  const [htpOpen, setHtpOpen] = useState(false); // How to Play modal
  const [theme, toggleTheme] = useTheme();
  const [busy, setBusy] = useState(false);
  // In-app error/result messages (bubble instead of browser alert)
  const [toasts, setToasts] = useState<NotifItem[]>([]);
  const toastUid = useRef(0);
  const toast = useCallback((message: string, kind: "err" | "ok" | "warn" = "err") => {
    const uid = `toast${++toastUid.current}`;
    setToasts((t) => [{ type: "toast", uid, meta: { message, kind } }, ...t].slice(0, 8));
    setTimeout(() => setToasts((t) => t.filter((x) => x.uid !== uid)), 5000);
  }, []);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);

  // Guards the wallet popup: an injected wallet (Phantom) only handles ONE pending
  // sendTransaction over its message channel. If a previous sendTransaction is still
  // pending (user abandoned the popup → our Promise.race timed out but the adapter's
  // underlying promise never settled), starting a second one silently starves — the
  // new popup never opens. We therefore never begin a sendTransaction while the
  // previous one is unresolved; a new doBuy first awaits (bounded) the prior settle.
  const pendingSendRef = useRef<Promise<unknown> | null>(null);
  // Synchronous mirror of `busy` — guards doBuy reentrancy even under React batching.
  const busyRef = useRef(false);
  const [hoverScreen, setHoverScreen] = useState<{ x: number; y: number } | null>(null);
  const [nukeFlash, setNukeFlash] = useState<{ x: number; y: number; t: number } | null>(null);

  // Client-side pricing: /price removed — cell info is derived SYNC from cells+board
  // (kept live by useBoard's decay tick every second).
  const cellAt = useCallback((x: number, y: number) => cells.find((c) => c.x === x && c.y === y), [cells]);
  const [hoverCoord, setHoverCoord] = useState<{ x: number; y: number } | null>(null);
  const hoverInfo = useMemo(() => {
    if (!hoverCoord || !board) return null;
    return deriveCellInfo(hoverCoord.x, hoverCoord.y, cellAt(hoverCoord.x, hoverCoord.y), board);
  }, [hoverCoord, board, cellAt]);
  const selectedInfo = useMemo(
    () => (selected && board ? deriveCellInfo(selected.x, selected.y, cellAt(selected.x, selected.y), board) : null),
    [selected, board, cellAt]
  );
  // "This is my pixel" state — auto-updates when owner changes via an SSE cell_patch.
  const selectedIsMine = selectedInfo ? selectedInfo.owner === owner && Boolean(owner) : false;

  // Canvas tooltip — hover only feeds the tooltip, it does NOT change the side panel.
  // Derivation is sync since /price was removed: the cell coord + screen position are
  // stored, tooltip content is derived from cells/board in useMemo (no REST, no throttle).
  const onHover = useCallback((h: { x: number; y: number; screen: { x: number; y: number } } | null) => {
    if (!h) {
      setHoverCoord(null); setHoverScreen(null);
      return;
    }
    setHoverCoord({ x: h.x, y: h.y });
    setHoverScreen(h.screen);
  }, []);

  const doBuy = useCallback(async (x: number, y: number) => {
    // Reentrancy guard — must be synchronous (ref, not state) so rapid double-clicks
    // or quick-buy taps in the SAME render batch both see busy=true and can't each
    // spawn a quote + sendTransaction. The state `busy` updates async (batched), so
    // it alone can't stop a second click that lands before the re-render.
    if (busyRef.current) {
      toast("A purchase is already processing — wait for it to finish.", "warn");
      return;
    }
    if (!connected || !publicKey || !signTransaction) {
      toast("Connect your wallet first", "warn");
      return;
    }
    if (!ESCROW) {
      toast("VITE_ESCROW_PUBLIC env is not set", "err");
      return;
    }
    // Can't buy your own pixel
    if (cells.some((c) => c.x === x && c.y === y && c.owner === publicKey.toBase58())) {
      toast("You already own this pixel — you can't buy your own.", "warn");
      return;
    }
    // A previous sendTransaction is still unresolved — Phantom's message channel
    // is likely occupied by a popup the user backgrounded without dismissing. Give
    // it a 500ms grace (in case they *just* dismissed it and .then hasn't fired yet)
    // then abort with a clear instruction. Do NOT create a /quote here — that would
    // needlessly lock the pixel in "pending" for everyone while we silently starve.
    const pending = pendingSendRef.current;
    if (pending) {
      await Promise.race([
        pending.then(() => {}, () => {}),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
      // The ref gets cleared when its send settles — if it still holds the same
      // promise after the grace window, the signature popup is still unhandled.
      if (pendingSendRef.current === pending) {
        toast(
          "You have a pending signature request in your wallet. Open your wallet, dismiss/reject it, then try again.",
          "warn"
        );
        return;
      }
    }
    setBusy(true);
    busyRef.current = true;
    let quoteId: string | null = null;
    try {
      // Fetch the quote AND a signed-ready blockhash in parallel — the blockhash only
      // needs to be valid at sign time (~60s), so warming it now lets the Phantom popup
      // open the instant the quote resolves instead of waiting on a serialized
      // quote-RTT → getLatestBlockhash-RTT chain.
      const [q, blockhash] = await Promise.all([
        reqQuote(publicKey.toBase58(), x, y),
        warmBlockhash().catch(() => null), // best-effort — a failure falls back to adapter fetch
      ]);
      if (!q || "error" in q) {
        toast(("message" in (q ?? {}) ? (q as any).message : "Purchase error") || "Purchase error");
        return;
      }
      quoteId = q.quoteId;
      const escrowPk = new PublicKey(ESCROW);
      const ixs = buildPurchaseIxs(q, publicKey, escrowPk);
      const tx = new Transaction();
      ixs.forEach((ix) => tx.add(ix));
      // feePayer MUST be set. The wallet adapter's signTransaction does
      // transaction.partialSign(), which throws TransactionError when feePayer is null —
      // Phantom opens (or stays blank) and immediately rejects, so no approval screen ever
      // shows even though the preceding /quote + getLatestBlockhash RPC calls returned 200.
      tx.feePayer = publicKey;
      // Pin the blockhash so sendTransaction skips its own getLatestBlockhash RPC
      // round-trip (the slow link that delayed the popup). null → adapter fetches as before.
      if (blockhash) tx.recentBlockhash = blockhash;
      // The quote's expiresInSec is the backend intent TTL (QUEUE_TTL_SEC). We bound the
      // signature step to just under it: if the wallet popup hangs (user walks away
      // without approving/rejecting, or the wallet RPC stalls), `busy` must still clear —
      // otherwise every pixel's Buy button is stuck at "Processing…" (it's ONE account-wide
      // boolean fed to every panel button). A late approval after this window is stale:
      // the intent is cancelled and the tx dropped, so SOL can't land in escrow with no
      // claimable intent (para-mahsur).
      const budgetMs = Math.max(3000, Math.round((q.expiresInSec ?? 20) * 1000) - 500);
      // Popup serialization gate was already enforced at the top of doBuy (before we
      // spent a /quote). If we reach here, pendingSendRef is guaranteed to be clear.
      const signP = signTransaction(tx);
      pendingSendRef.current = signP;
      signP.then(
        () => { if (pendingSendRef.current === signP) pendingSendRef.current = null; },
        () => { if (pendingSendRef.current === signP) pendingSendRef.current = null; }
      );
      const signed = await Promise.race([
        signP,
        new Promise<'__timeout__'>((resolve) =>
          setTimeout(() => resolve("__timeout__"), budgetMs)
        ),
      ]);
      if (signed === "__timeout__") {
        // Popup is still open in the wallet. Keep pendingSendRef set so a subsequent
        // doBuy waits (bounded) for Phantom to free its channel before opening a new
        // popup — otherwise the new popup never appears.
        await cancelQuote(q.quoteId, publicKey.toBase58());
        toast(
          "Signature window expired. Open your wallet, dismiss/reject the pending request, then try again.",
          "warn"
        );
        setSelected(null);
        return;
      }
      // Submit the signed bytes ourselves through connection.sendRawTransaction (routes
      // via our backend RPC proxy). This surfaces the REAL RPC error if the broadcast
      // fails — Phantom's combined send-and-sign throws an opaque "unexpected error".
      let txSig: string;
      try {
        txSig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
          preflightCommitment: "processed",
        });
      } catch (e: any) {
        // A failed submit never claims the intent — it expires after QUEUE_TTL_SEC.
        toast("Transaction failed: " + (e?.message ?? e));
        await cancelQuote(q.quoteId, publicKey.toBase58());
        setSelected(null);
        return;
      }
      // No client-side confirmTransaction — the backend owns the wait (WebSocket
      // signatureSubscribe, which doesn't count against the RPC budget). `/confirm`
      // is replay-safe + forge-safe on its own (intent consumed atomically; payer must
      // equal the quote owner). Sending immediately after submit is fine: the backend
      // WS-waits until the tx is indexed. The pixel stays locked meanwhile (intent_locked).
      const res = await confirmQuote(q.quoteId, txSig);
      if (!res.ok) {
        toast(res.body?.message ?? res.body?.error ?? "Confirm error");
        return;
      }
      if (res.body?.nukeDropped) {
        setNukeFlash({ x, y, t: Date.now() });
      }
      // The panel update arrives via an SSE cell_patch (selectedInfo is a memo bound
      // to cells) — no REST refresh needed.
    } catch (e: any) {
      toast("Transaction failed: " + (e?.message ?? e));
      if (quoteId && publicKey) await cancelQuote(quoteId, publicKey.toBase58());
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }, [connected, publicKey, signTransaction, reqQuote, cancelQuote, confirmQuote, connection, cells, toast, setSelected, warmBlockhash]);

  const onClickCell = useCallback((x: number, y: number) => {
    // Opening the pixel sheet closes any other mobile sheet (only one at a time).
    setLbOpen(false);
    setFeedOpen(false);
    setSelected({ x, y });
    // Panel info is derived sync (selectedInfo is a memo bound to cells+board) —
    // auto-updates when the selection changes; `mine`/`gold` also come from that cached data.
    const mine = cellAt(x, y)?.owner === owner;
    const gold = cellAt(x, y)?.is_gold;
    if (autoApprove && !mine && !gold) {
      doBuy(x, y);
    }
  }, [autoApprove, doBuy, cellAt, owner, setLbOpen, setFeedOpen]);

  const onBuyClick = useCallback(() => {
    if (selected) doBuy(selected.x, selected.y);
  }, [selected, doBuy]);

  const onClaim = useCallback(async (poolId: "small" | "mid" | "big") => {
    if (!owner) { toast("Connect your wallet first", "warn"); return; }
    const p = pools.find((x) => x.id === poolId);
    if (!p) return;
    const cost = p.claimCost;
    const have = nukes.counts[p.claimSymbol]?.count ?? 0;
    if (have < cost) { toast(`This pool needs ${cost} × ${p.claimSymbol} (you have ${have}).`, "warn"); return; }
    const res = await doClaim(owner, poolId);
    if (!res.ok) {
      // code 0 → signMessage was rejected or a network error (the backend was never reached).
      const msg = res.code === 0 ? "Signature rejected or network error" : (res.body?.message ?? res.body?.error ?? "Claim error");
      toast(msg, "warn");
      return;
    }
    toast(`Claim successful! You won ${fmtSol(res.body.payoutSol)} SOL 🎉`, "ok");
    // Pools + nuke stock update via SSE (broadcastPools + nukes_changed).
  }, [owner, pools, nukes, doClaim, toast]);

  // Mobile sheets are mutually exclusive — opening one closes the others.
  const openLeaderboard = useCallback(() => {
    setSelected(null);
    setFeedOpen(false);
    setLbOpen(true);
  }, []);
  const openFeed = useCallback(() => {
    setSelected(null);
    setLbOpen(false);
    setFeedOpen(true);
  }, []);

  if (!board) {
    return (
      <div className="app">
        <div className="loading">Loading board…</div>
      </div>
    );
  }

  const myAddr = connected ? publicKey?.toBase58() ?? null : null;
  const selectedPending = selected ? Boolean(pendingIntents[`${selected.x},${selected.y}`]) : false;
  const pixelPanel = (
    <PixelPanel
      selected={selected}
      info={selectedInfo}
      isMine={selectedIsMine}
      autoApprove={autoApprove}
      onBuy={onBuyClick}
      busy={busy}
      connected={connected}
      isPending={selectedPending}
      onClose={() => setSelected(null)}
    />
  );

  return (
    <div className="app">
      {connErr && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999, background: "#b3261e", color: "#fff", padding: "10px 14px", font: "12px/1.4 system-ui" }}>
          <b>Connection error:</b> {connErr}
        </div>
      )}
      <div className="notif-stack">
        {notifOn && (
          <BubbleNotifications
            notifs={notifs}
            onDismiss={dismiss}
            myOwner={myAddr}
          />
        )}
        {toasts.length > 0 &&
          toasts.map((t) => (
            <div className={"bubble bubble-toast toast-" + (t.meta?.kind ?? "err")} key={t.uid}>
              <div className="bubble-body">{bubbleBody(t)}</div>
            </div>
          ))}
      </div>
      {(board.isMaintenance || sseStale) && (
        <div className="admin-overlay" style={{ zIndex: 2100 }} onClick={(e) => e.stopPropagation()}>
          <div className="admin-modal" style={{ padding: "40px 44px", textAlign: "center", maxWidth: 460 }}>
            {sseStale ? (
              <>
                <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>⚠️ Connection lost</div>
                <div style={{ opacity: 0.85, font: "14px/1.6 system-ui", whiteSpace: "pre-line", marginBottom: 20 }}>
                  {"Live updates stopped, this board may be out of date.\nPlease refresh the page before making a purchase."}
                </div>
                <button
                  className="btn-admin-mini"
                  style={{ padding: "12px 26px", fontSize: 15, fontWeight: 600 }}
                  onClick={() => window.location.reload()}
                >
                  Refresh page
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>🛠 Under maintenance</div>
                <div style={{ opacity: 0.85, font: "14px/1.6 system-ui", whiteSpace: "pre-line" }}>{"We'll be back shortly."}</div>
              </>
            )}
          </div>
        </div>
      )}
      <TopBar
        tokenMint={board.tokenMint}
        perPxSol={board.perPxSol}
        onConnectRequest={() => setPickerOpen(true)}
      />
      <WalletPicker open={pickerOpen} onClose={() => setPickerOpen(false)} />
      <JackpotBar pools={pools} onClaim={onClaim} counts={nukes.counts} />
      <div className="stage-wrap" data-sheet={isMobile && selected ? sheetSnap : undefined}>
        <CanvasStage
          board={board}
          cells={cells}
          kols={kols}
          myOwner={myAddr}
          onHover={onHover}
          onClick={onClickCell}
          highlightNukeDrop={nukeFlash}
          selected={selected}
          pendingIntents={pendingIntents}
        />
        <FillBar
          fillPercent={board.fillPercent}
          size={board.size}
          occupied={board.occupied}
          expanding={liveBoard?.expanding ?? board.expanding}
          expandDeadlineSec={liveBoard?.expandDeadlineSec ?? board.expandDeadlineSec}
          counts={nukes.counts}
          showSymbols={connected}
          onReferOpen={() => setReferOpen(true)}
          activeCount={activeCount}
        />
        {/* Control dock — bottom right: how to play / fit / notifications / quick buy / theme */}
        <div className="control-dock">
          <button
            className="dock-btn tip-left"
            onClick={() => setHtpOpen(true)}
            data-tip="How to Play — game guide"
            aria-label="How to play"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M9.1 9a3 3 0 1 1 4.7 2.5c-1.1.8-1.8 1.4-1.8 2.7" />
              <circle cx="12" cy="17.6" r="0.4" fill="currentColor" />
            </svg>
          </button>
          <button
            className="dock-btn tip-left"
            onClick={() => window.dispatchEvent(new Event("pw:fitview"))}
            data-tip="Fit the map to screen"
            aria-label="Fit to screen"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>
          <button
            className={"dock-btn tip-left" + (notifOn ? " on" : "")}
            onClick={() => (notifOn ? (setNotifOn(false), clear()) : setNotifOn(true))}
            data-tip={notifOn ? `Notifications: On (${notifs.length})` : "Notifications: Off"}
            aria-label="Toggle notifications"
          >
            🔔
          </button>
          <button
            className={"dock-btn dock-zap tip-left" + (autoApprove ? " on" : "")}
            onClick={() => setAutoApprove((v) => !v)}
            data-tip={autoApprove ? "Quick Buy: On — tapping buys automatically" : "Quick Buy: Off"}
            aria-label="Quick buy"
          >
            ⚡
          </button>
          <button
            className="dock-btn tip-left"
            onClick={toggleTheme}
            data-tip={theme === "dark" ? "Theme: Dark — switch to light" : "Theme: Light — switch to dark"}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
              </svg>
            )}
          </button>
        </div>

        {/* Left column — desktop: Leaderboard (collapsible) + Live Feed panels */}
        {!isMobile && (
          <div className="left-stack">
            <aside className={"lb-dock" + (lbCollapsed ? " collapsed" : "")}>
              <div className="dock-head">
                <span className="dock-title">🏆 Leaderboard</span>
                <button
                  className="lb-collapse"
                  onClick={() => setLbCollapsed((v) => !v)}
                  data-tip={lbCollapsed ? "Open leaderboard panel" : "Close leaderboard panel"}
                  aria-label="Toggle leaderboard panel"
                >
                  {lbCollapsed ? "▲" : "▼"}
                </button>
              </div>
              {!lbCollapsed && <Leaderboard />}
            </aside>
            <aside className="feed-dock">
              <div className="dock-head">
                <span className="dock-title">⚡ Live Feed</span>
                <span className="live-dot" aria-hidden="true" />
              </div>
              <LiveFeed recent={recent} />
            </aside>
          </div>
        )}
        {isMobile && (
          <>
            <LiveTicker recent={recent} onOpen={openFeed} />
            <button className="lb-fab tip-top" onClick={openLeaderboard} data-tip="Leaderboard" aria-label="Leaderboard">
              🏆
            </button>
          </>
        )}

        {/* Pixel details — desktop: floating card */}
        {!isMobile && selected && (
          <div className="pixel-dock">{pixelPanel}</div>
        )}
      </div>
      {/* Mobile bottom sheets + tooltip must all live OUTSIDE .stage-wrap: that wrapper has
          will-change:transform, which becomes any fixed descendant's containing block and
          misplaces it. They are position:fixed and need the true viewport. */}
      {isMobile && (
        <>
          <Sheet open={lbOpen} onClose={() => setLbOpen(false)} halfHeight={360} initialSnap="half" label="Leaderboard" title="🏆 Leaderboard">
            <Leaderboard />
          </Sheet>
          <Sheet open={feedOpen} onClose={() => setFeedOpen(false)} halfHeight={340} initialSnap="half" label="Live feed" title="⚡ Live Feed">
            <LiveFeed recent={recent} />
          </Sheet>
          <Sheet
            open={!!selected}
            onClose={() => setSelected(null)}
            peekHeight={238}
            halfHeight={520}
            initialSnap="half"
            fitContent
            onSnapChange={setSheetSnap}
            label="Pixel details"
          >
            {pixelPanel}
          </Sheet>
        </>
      )}
      <HoverTooltip info={hoverInfo} screen={hoverScreen} myOwner={myAddr} />
      {referOpen && owner && (
        <ReferralPanel
          state={refer}
          onClose={() => setReferOpen(false)}
          onClaim={async (symbol) => {
            const res = await refer.claim(owner, symbol);
            if (!res.ok) throw new Error(res.body?.error ?? "Claim error");
            refer.refresh();
            nukes.refresh();
          }}
        />
      )}
      {htpOpen && <HowToPlay onClose={() => setHtpOpen(false)} />}
    </div>
  );
}

// Main game vs secret admin page, chosen by path. No router — a small wrapper with
// popstate/hashchange listeners (handles cached SPAs / pushState full loads).
function Router() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  return path === ADMIN_PATH ? <AdminApp /> : <AppInner />;
}

export default function App() {
  const wallets = useMemo(
    () => [
      // PhantomWalletAdapter is deliberately PRESENT: on mobile Phantom the
      // standard-wallet bridge leaves connect pending; instead we rely on this adapter
      // that uses the legacy `window.phantom.solana` API (the Picker also opens a
      // legacy connect over this adapter and reloads the page).
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new LedgerWalletAdapter(),
      new CoinbaseWalletAdapter(),
      new TrustWalletAdapter(),
      new TorusWalletAdapter(),
    ],
    []
  );
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <Router />
      </WalletProvider>
    </ConnectionProvider>
  );
}
