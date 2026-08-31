import { useCallback, useEffect, useMemo, useState } from "react";
import type { UseAdminAuth } from "../hooks/useAdminAuth";

// Admin Config Panel. Only rendered when isAdmin === true (App.tsx).
// Secret keypairs are never returned by the backend — here only "configured"
// flags (hasSecret) are visible.

interface SymbolChanceCfg {
  baseProb: number;
  multStep: number;
  maxPerPerson: number;
  available: number;
}

interface ReferSymbolCfg {
  points: number;
  reward: number;
  emoji: string;
}

interface FullConfig {
  boardSizes: number[];
  econ: Record<string, number>;
  wallets: { BURN_WALLET: string; DEAD_WALLET: string; TREASURY_WALLET: string; POOL_WALLET: string };
  hasSecret: { escrow: boolean; burn: boolean; treasury: boolean; pool: boolean };
  splits: Record<string, number>;
  pools: Record<string, number>;
  chance: Record<"grenade" | "missile" | "nuke", SymbolChanceCfg>;
  chanceGlobal: { DROP_PRICE_STEP: number };
  CLAIM_COST: { small: number; mid: number; big: number };
  token: Record<string, number | string>;
  sla: Record<string, number>;
  refer: Record<string, number> & { symbols: Record<"grenade" | "missile" | "nuke", ReferSymbolCfg> };
  admins: string[];
  maintenance: { isMaintenance: boolean; maintenanceStartedAtMs: number | null };
  current: { level: number; size: number; perPxSol: number };
}

interface Props {
  admin: UseAdminAuth;
}

type Tab = "econ" | "wallets" | "splits" | "pools" | "nuke" | "token" | "sla" | "refer" | "admins" | "ops";

const TABS: { id: Tab; label: string }[] = [
  { id: "econ", label: "Economy" },
  { id: "wallets", label: "Wallets" },
  { id: "splits", label: "Splits" },
  { id: "pools", label: "Pools" },
  { id: "nuke", label: "Chance" },
  { id: "token", label: "Token" },
  { id: "sla", label: "SLA" },
  { id: "refer", label: "Refer" },
  { id: "admins", label: "Admins" },
  { id: "ops", label: "Ops" },
];

const NUMBER_DESC: Record<string, string> = {
  BASE_SOL: "Empty pixel base price (SOL)",
  PER_PX_MULT: "Board level price multiplier (×1.5 each expansion)",
  FILL_EXPAND_THRESHOLD: "Expansion start occupancy (0-1)",
  FILL_EXPAND_SECONDS: "Expansion countdown (sec)",
  COOLDOWN_SECONDS: "Multiplier ×2 window (sec)",
  MULT_DECAY_FACTOR: "Multiplier decay factor after cooldown (0-1)",
  MULT_CAP: "Max multiplier → golden pixel",
  EMPTY_SPLIT_BURN_PCT: "Empty pixel → burn (%)",
  EMPTY_SPLIT_POOL_PCT: "Empty pixel → pools (%)",
  EMPTY_SPLIT_TREASURY_PCT: "Empty pixel → treasury (%)",
  GASP_SPLIT_PRIOR_PCT: "Gasp → previous owner (%)",
  GASP_SPLIT_POOL_PCT: "Gasp → pools (%)",
  GASP_SPLIT_BURN_PCT: "Gasp → burn (%)",
  GASP_SPLIT_TREASURY_PCT: "Gasp → treasury (%)",
  POOL_WEIGHT_SMALL: "Small pool weight",
  POOL_WEIGHT_MID: "Mid pool weight",
  POOL_WEIGHT_BIG: "Big pool weight",
  GRENADE_BASE_PROB: "🧨 Grenade base chance (empty pixel, 0-1)",
  GRENADE_MULT_STEP: "+grenade chance per multiplier doubling (0-1)",
  MAX_GRENADE_PER_PERSON: "Max grenades per person",
  MISSILE_BASE_PROB: "🚀 Missile base chance (empty pixel, 0-1)",
  MISSILE_MULT_STEP: "+missile chance per multiplier doubling (0-1)",
  MAX_MISSILE_PER_PERSON: "Max missiles per person",
  NUKE_BASE_PROB: "☢️ Nuke base chance (empty pixel, 0-1)",
  NUKE_MULT_STEP: "+nuke chance per multiplier doubling (0-1)",
  MAX_NUKE_PER_PERSON: "Max nukes per person",
  DROP_PRICE_STEP: "+symbol chance per board level (0-1)",
  TOKEN_DECIMALS: "Token decimals",
  DEFAULT_TOKEN_USD: "Token USD when no oracle",
  DEFAULT_SOL_USD: "SOL USD when no oracle",
  QUEUE_TTL_SEC: "Intent/quote TTL (sec)",
  SOL_TOLERANCE: "SOL price tolerance (0-1)",
  REFER_VOLUME_THRESHOLD_SOL: "Volume needed per referral point (SOL)",
  REFER_POINTS_FOR_GRENADE: "🧨 Points needed for 1 grenade",
  REFER_GRENADE_REWARD: "🧨 Claim reward",
  REFER_POINTS_FOR_MISSILE: "🚀 Points needed for 1 missile",
  REFER_MISSILE_REWARD: "🚀 Claim reward",
  REFER_POINTS_FOR_NUKE: "☢️ Points needed for 1 nuke",
  REFER_NUKE_REWARD: "☢️ Claim reward",
};

export function AdminPanel({ admin }: Props) {
  const [tab, setTab] = useState<Tab>("econ");
  const [cfg, setCfg] = useState<FullConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Ops tab: BOARD_SIZES is entered comma-separated; initialized with cfg.load.
  const [boardSizesStr, setBoardSizesStr] = useState("");

  const load = useCallback(async () => {
    setCfg(null);
    setDraft({});
    const res = await admin.authFetch("/admin/config");
    if (!res.ok) {
      setNotice({ kind: "err", text: "Failed to load config (" + res.status + ")" });
      return;
    }
    const data = await res.json();
    setCfg(data);
    setBoardSizesStr((data.boardSizes ?? []).join(","));
  }, [admin]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // For numeric fields the draft keeps the raw string (only converted to a number at commit).
  // This preserves the period/comma while typing "0." / "0,03". Must be defined BEFORE the
  // useMemo that consumes draftNum (TDZ/init error during render).
  const numValue = (key: string): string => {
    if (key in draft) return String(draft[key]);
    if (!cfg) return "";
    const v = nestedGet(cfg, key);
    return v == null ? "" : String(v);
  };

  // Convert the raw draft string to a number (empty/invalid → NaN).
  const draftNum = (key: string): number => {
    const raw = String(draft[key] ?? numValue(key)).replace(",", ".");
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  };

  const dirtyKeys = useMemo(() => {
    if (!cfg) return [];
    return Object.keys(draft).filter((k) => {
      const cur = nestedGet(cfg, k);
      if (cur == null) return true;
      // Numeric key: normalize the draft string to a number before comparing,
      // so the "0.03" string vs 0.03 number compare as equal (not dirty).
      if (typeof cur === "number") return !(Number.isFinite(draftNum(k)) && draftNum(k) === cur);
      return JSON.stringify(cur) !== JSON.stringify(draft[k]);
    });
  }, [cfg, draft]);

  const fieldChanged = (key: string, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const commit = async (changes: Record<string, unknown>) => {
    setSaving(true);
    setNotice(null);
    try {
      const res = await admin.authFetch("/admin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.errors?.map((e: any) => `${e.key}: ${e.message}`).join("\n") ?? data?.error ?? "Save error (" + res.status + ")";
        setNotice({ kind: "err", text: msg });
        return;
      }
      setCfg(data);
      setDraft({});
      setNotice({ kind: "ok", text: "Saved ✔" });
      setTimeout(() => setNotice(null), 2500);
    } catch (e: any) {
      setNotice({ kind: "err", text: "Save failed: " + (e?.message ?? "network error") });
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (dirtyKeys.length === 0) {
      setNotice({ kind: "err", text: "No fields changed" });
      return;
    }
    if (!cfg) return;
    const changes: Record<string, unknown> = {};
    for (const k of dirtyKeys) {
      const cur = nestedGet(cfg, k);
      // For numeric keys convert the draft (possibly a string) to a number — backend expects number.
      if (typeof cur === "number") changes[k] = draftNum(k);
      // Array key (e.g. BOARD_SIZES): the draft is a comma-separated string → convert to number[].
      // Must run before the object branch (an array is also an "object").
      else if (Array.isArray(cur)) {
        changes[k] = String(draft[k] ?? "")
          .split(",")
          .map((s) => Number(s.trim().replace(",", ".")))
          .filter((n) => Number.isFinite(n));
      }
      // Object key (e.g. CLAIM_COST): sub-fields may be entered as strings;
      // backend validates each sub-value as a number → normalize numeric strings in the
      // draft to numbers. Non-numeric values (e.g. emoji) must stay unchanged.
      else if (typeof cur === "object" && cur !== null) {
        const src = draft[k];
        if (src && typeof src === "object") {
          const norm: Record<string, unknown> = {};
          for (const [sub, v] of Object.entries(src)) {
            norm[sub] = typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : v;
          }
          changes[k] = norm;
        } else {
          changes[k] = src;
        }
      }
      else changes[k] = draft[k];
    }
    commit(changes);
  };

  if (!cfg) {
    return (
      <div className="admin-page">
        <div className="admin-loading">Loading config…</div>
      </div>
    );
  }

  const splitSum = (prefix: "EMPTY" | "GASP") => {
    const keys =
      prefix === "EMPTY"
        ? ["EMPTY_SPLIT_BURN_PCT", "EMPTY_SPLIT_POOL_PCT", "EMPTY_SPLIT_TREASURY_PCT"]
        : ["GASP_SPLIT_PRIOR_PCT", "GASP_SPLIT_POOL_PCT", "GASP_SPLIT_BURN_PCT", "GASP_SPLIT_TREASURY_PCT"];
    return keys.reduce((acc, k) => acc + (Number.isFinite(numFromString(numValue(k))) ? numFromString(numValue(k)) : 0), 0);
  };

  return (
    <div className="admin-page">
      <div className="admin-head">
        <span className="admin-title">⚙ Admin Panel</span>
        <span className="admin-sub">Board: Lv {cfg.current.level} · {cfg.current.size}×{cfg.current.size} · {cfg.current.perPxSol} SOL/px</span>
        <a className="admin-back" href="/">← Back to Game</a>
      </div>
        <div className="admin-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={"admin-tab" + (tab === t.id ? " active" : "")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="admin-body">
          {tab === "econ" && (
            <Section title="Economy" desc="Pixel pricing, multiplier and expansion rules">
              {numFields(cfg, draft, fieldChanged, numValue, [
                "BASE_SOL", "PER_PX_MULT", "FILL_EXPAND_THRESHOLD", "FILL_EXPAND_SECONDS",
                "COOLDOWN_SECONDS", "MULT_DECAY_FACTOR", "MULT_CAP",
              ])}
            </Section>
          )}

          {tab === "wallets" && (
            <Section title="Wallets" desc="Public addresses are managed from the UI. Secret keypairs live ONLY in env — never shown.">
              <WalletField label="Burn accumulation wallet" keyName="BURN_WALLET" value={numValue("BURN_WALLET")} onChange={(v) => fieldChanged("BURN_WALLET", v)} />
              <WalletField label="Treasury wallet" keyName="TREASURY_WALLET" value={numValue("TREASURY_WALLET")} onChange={(v) => fieldChanged("TREASURY_WALLET", v)} />
              <WalletField label="Reward pool wallet" keyName="POOL_WALLET" locked hint="from env (POOL_WALLET)" value={numValue("POOL_WALLET")} onChange={(v) => fieldChanged("POOL_WALLET", v)} />
              <WalletField label="Dead (Incinerator) wallet" keyName="DEAD_WALLET" locked hint="fixed (Incinerator)" value={numValue("DEAD_WALLET")} onChange={(v) => fieldChanged("DEAD_WALLET", v)} />
              <div className="admin-info-grid">
                <KeypairStatus name="Escrow" configured={cfg.hasSecret.escrow} />
                <KeypairStatus name="Burn wallet" configured={cfg.hasSecret.burn} />
                <KeypairStatus name="Treasury" configured={cfg.hasSecret.treasury} />
                <KeypairStatus name="Reward pool" configured={cfg.hasSecret.pool} />
              </div>
            </Section>
          )}

          {tab === "splits" && (
            <Section title="Splits" desc="Each split must sum to 100 — otherwise it cannot be saved.">
              <SplitGroup
                title="Empty pixel purchase"
                keys={["EMPTY_SPLIT_BURN_PCT", "EMPTY_SPLIT_POOL_PCT", "EMPTY_SPLIT_TREASURY_PCT"]}
                sum={splitSum("EMPTY")}
                onField={fieldChanged}
                numValue={numValue}
              />
              <SplitGroup
                title="Gasp (owned purchase)"
                keys={["GASP_SPLIT_PRIOR_PCT", "GASP_SPLIT_POOL_PCT", "GASP_SPLIT_BURN_PCT", "GASP_SPLIT_TREASURY_PCT"]}
                sum={splitSum("GASP")}
                onField={fieldChanged}
                numValue={numValue}
              />
            </Section>
          )}

          {tab === "pools" && (
            <PoolsTab onField={fieldChanged} numValue={numValue} />
          )}

          {tab === "nuke" && (
            <ChanceTab cfg={cfg} draft={draft} fieldChanged={fieldChanged} numValue={numValue} />
          )}

          {tab === "token" && (
            <Section title="Token" desc="Dead-wallet swap target and price defaults">
              <WalletField label="Token mint" keyName="TOKEN_MINT" value={numValue("TOKEN_MINT")} onChange={(v) => fieldChanged("TOKEN_MINT", v)} />
              {numFields(cfg, draft, fieldChanged, numValue, ["TOKEN_DECIMALS", "DEFAULT_TOKEN_USD", "DEFAULT_SOL_USD"])}
            </Section>
          )}

          {tab === "sla" && (
            <Section title="SLA" desc="Request lifetime and price tolerance">
              {numFields(cfg, draft, fieldChanged, numValue, ["QUEUE_TTL_SEC", "SOL_TOLERANCE"])}
            </Section>
          )}

          {tab === "refer" && (
            <Section title="Referral System" desc="Each referral reaching the goal = 1 point. When points reach a symbol's threshold, that symbol can be claimed (independent of the stock / per-person limit).">
              {numFields(cfg, draft, fieldChanged, numValue, [
                "REFER_VOLUME_THRESHOLD_SOL",
                "REFER_POINTS_FOR_GRENADE", "REFER_GRENADE_REWARD",
                "REFER_POINTS_FOR_MISSILE", "REFER_MISSILE_REWARD",
                "REFER_POINTS_FOR_NUKE", "REFER_NUKE_REWARD",
              ])}
            </Section>
          )}

          {tab === "admins" && <AdminsTab admin={admin} admins={cfg.admins} onChanged={load} />}

          {tab === "ops" && (
            <OpsTab
              admin={admin}
              onNotice={setNotice}
              currentLevel={cfg.current.level}
              currentSize={cfg.current.size}
              chance={cfg.chance}
              onChanged={load}
              boardSizesStr={boardSizesStr}
              setBoardSizesStr={setBoardSizesStr}
              boardSizes={cfg.boardSizes ?? []}
              maintenance={cfg.maintenance}
              onField={fieldChanged}
              onSave={save}
            />
          )}
        </div>

        <div className="admin-foot">
          <div className="admin-notice">
            {notice && <span className={"notice-" + notice.kind}>{notice.text}</span>}
            {dirtyKeys.length > 0 && !notice && <span className="notice-dirty">{dirtyKeys.length} unsaved change{dirtyKeys.length === 1 ? "" : "s"}</span>}
          </div>
          <button className="btn-admin-save" onClick={save} disabled={dirtyKeys.length === 0 || saving || hasInvalidSplit()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );

  function hasInvalidSplit() {
    return splitSum("EMPTY") !== 100 || splitSum("GASP") !== 100;
  }
}

function nestedGet(cfg: FullConfig, key: string): unknown {
  if (key in cfg.econ) return cfg.econ[key];
  if (key in cfg.wallets) return (cfg.wallets as any)[key];
  if (key in cfg.splits) return cfg.splits[key];
  if (key in cfg.pools) return cfg.pools[key];
  if (key === "CLAIM_COST") return cfg.CLAIM_COST;
  // A symbol name can begin either way: "NUKE_BASE_PROB" or "MAX_NUKE_PER_PERSON".
  // In the second form the symbol comes AFTER the "MAX_" prefix — the regex must match that.
  const symMatch =
    key.match(/^(GRENADE|MISSILE|NUKE)_(BASE_PROB|MULT_STEP)$/) ||
    key.match(/^MAX_(GRENADE|MISSILE|NUKE)_PER_PERSON$/);
  if (symMatch) {
    const sym = symMatch[1].toLowerCase();
    if (key.includes("PER_PERSON")) return (cfg.chance as any)[sym]?.maxPerPerson;
    if (key.endsWith("BASE_PROB")) return (cfg.chance as any)[sym]?.baseProb;
    if (key.endsWith("MULT_STEP")) return (cfg.chance as any)[sym]?.multStep;
  }
  switch (key) {
    case "DROP_PRICE_STEP": return cfg.chanceGlobal?.DROP_PRICE_STEP;
    case "BOARD_SIZES": return cfg.boardSizes;
    case "TOKEN_MINT": case "TOKEN_DECIMALS": case "DEFAULT_TOKEN_USD": case "DEFAULT_SOL_USD": return cfg.token[key];
    case "QUEUE_TTL_SEC": case "SOL_TOLERANCE": return cfg.sla[key];
    case "REFER_VOLUME_THRESHOLD_SOL": case "REFER_POINTS_FOR_GRENADE": case "REFER_GRENADE_REWARD":
    case "REFER_POINTS_FOR_MISSILE": case "REFER_MISSILE_REWARD":
    case "REFER_POINTS_FOR_NUKE": case "REFER_NUKE_REWARD":
      return cfg.refer[key];
    default: return undefined;
  }
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="admin-section">
      <div className="admin-section-head">
        <span className="admin-section-title">{title}</span>
        <span className="admin-section-desc">{desc}</span>
      </div>
      <div className="admin-fields">{children}</div>
    </div>
  );
}

// Main numeric input generator. The raw string is preserved (so the user can type a
// period/comma); number conversion happens at commit time.
function numFields(_cfg: FullConfig, _draft: Record<string, unknown>, onChange: (k: string, v: unknown) => void, getVal: (k: string) => string, keys: string[]) {
  return keys.map((k) => (
    <label className="admin-field" key={k}>
      <span className="admin-label">{NUMBER_DESC[k] ?? k}</span>
      <input
        type="text"
        inputMode="decimal"
        value={getVal(k)}
        onChange={(e) => onChange(k, e.target.value)}
      />
    </label>
  ));
}

// Reads a number with "," → "." conversion (empty/invalid → NaN).
function numFromString(v: string): number {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function WalletField({ label, keyName, value, onChange, locked, hint }: { label: string; keyName: string; value: string; onChange: (v: string) => void; locked?: boolean; hint?: string }) {
  if (locked) {
    // Locked: the address cannot be managed from the UI. POOL_WALLET comes from env and must
    // match POOL_KEYPAIR (old 47-byte keypairs could trigger the claim escape bypass once
    // POOL_WALLET changes). DEAD_WALLET is the fixed Incinerator constant — never changes.
    return (
      <label className="admin-field">
        <span className="admin-label">{label} ({keyName}) <span className="admin-lock-hint">🔒 {hint ?? `env'den (${keyName})`}</span></span>
        <input type="text" value={value} readOnly onFocus={(e) => (e.target as HTMLInputElement).select()} placeholder="Base58 address" />
      </label>
    );
  }
  return (
    <label className="admin-field">
      <span className="admin-label">{label} ({keyName})</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Base58 address or empty" />
    </label>
  );
}

function KeypairStatus({ name, configured }: { name: string; configured: boolean }) {
  return (
    <div className="admin-keypair-stat">
      <span className="kp-name">{name}</span>
      <span className={"kp-dot " + (configured ? "on" : "off")}></span>
      <span className="kp-txt">{configured ? "keypair configured (env)" : "no keypair"}</span>
    </div>
  );
}

function SplitGroup({ title, keys, sum, onField, numValue }: any) {
  return (
    <div className="admin-split-group">
      <div className="admin-subhead">
        {title}
        <span className={"admin-sum" + (sum !== 100 ? " bad" : "")}>total: {sum}{sum !== 100 ? " ⚠ must be 100" : ""}</span>
      </div>
      <div className="admin-fields">
        {keys.map((k: string) => (
          <label className="admin-field" key={k}>
            <span className="admin-label">{NUMBER_DESC[k] ?? k}</span>
            <input type="text" inputMode="decimal" value={numValue(k)} onChange={(e) => onField(k, e.target.value)} />
          </label>
        ))}
      </div>
    </div>
  );
}

function claimCostValue(cfg: FullConfig, draft: Record<string, unknown>, pool: "small" | "mid" | "big"): string {
  const obj = (draft.CLAIM_COST ?? cfg.CLAIM_COST) as Record<string, number | string>;
  return String(obj?.[pool] ?? 1);
}

function ChanceTab({ cfg, draft, fieldChanged, numValue }: any) {
  const syms = ["grenade", "missile", "nuke"] as const;
  const emoji: Record<string, string> = { grenade: "🧨", missile: "🚀", nuke: "☢️" };
  return (
    <div className="admin-section">
      <div className="admin-section-head">
        <span className="admin-section-title">Chance Settings</span>
        <span className="admin-section-desc">Symbol drop chances and claim costs. p = base + step·log2(mult) + dropPriceStep·level</span>
      </div>
      {syms.map((s) => {
        const K = s.toUpperCase();
        return (
          <div className="admin-symbol-group" key={s}>
            <div className="admin-subhead">{emoji[s]} {K} <span className="admin-ops-note">stock: <strong>{cfg?.chance?.[s]?.available ?? 0}</strong></span></div>
            <div className="admin-fields">
              {numFields(cfg, draft, fieldChanged, numValue, [`${K}_BASE_PROB`, `${K}_MULT_STEP`, `MAX_${K}_PER_PERSON`])}
            </div>
          </div>
        );
      })}
      <div className="admin-subhead">Global (all symbols) — added to chance per board level</div>
      <div className="admin-fields">
        {numFields(cfg, draft, fieldChanged, numValue, ["DROP_PRICE_STEP"])}
      </div>
      <div className="admin-subhead">Claim cost (symbols per pool)</div>
      <div className="admin-row3">
        {(["small", "mid", "big"] as const).map((p) => (
          <label className="admin-field" key={p}>
            <span className="admin-label">{p} pool ({p === "small" ? "🧨 grenade" : p === "mid" ? "🚀 missile" : "☢️ nuke"})</span>
            <input
              type="text"
              inputMode="decimal"
              value={claimCostValue(cfg, draft, p)}
              onChange={(e) => {
                const c = { ...(draft.CLAIM_COST ?? cfg.CLAIM_COST) } as Record<string, string | number>;
                c[p] = e.target.value;
                fieldChanged("CLAIM_COST", c);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function PoolsTab({ onField, numValue }: any) {
  const w = (k: string) => (Number.isFinite(numFromString(numValue(k))) ? numFromString(numValue(k)) : 0);
  const total = w("POOL_WEIGHT_SMALL") + w("POOL_WEIGHT_MID") + w("POOL_WEIGHT_BIG");
  const pct = (k: string) => (total ? Math.round((w(k) / total) * 100) : 0);
  return (
    <Section title="Prize Pools" desc="The 20% pool share is distributed across three pools by weight — percentages are computed from the weight ratio.">
      <div className="admin-fields">
        {["POOL_WEIGHT_SMALL", "POOL_WEIGHT_MID", "POOL_WEIGHT_BIG"].map((k) => (
          <label className="admin-field" key={k}>
            <span className="admin-label">{NUMBER_DESC[k] ?? k} · ~{pct(k)}%</span>
            <input type="text" inputMode="decimal" value={numValue(k)} onChange={(e) => onField(k, e.target.value)} />
          </label>
        ))}
      </div>
    </Section>
  );
}

function AdminsTab({ admin, admins, onChanged }: { admin: UseAdminAuth; admins: string[]; onChanged: () => void }) {
  const [newAddr, setNewAddr] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const flash = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 2500);
  };

  const add = async () => {
    if (!newAddr.trim()) return;
    const res = await admin.authFetch("/admin/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: newAddr.trim(), label: newLabel.trim() || undefined }),
    });
    const data = await res.json();
    if (res.ok) { setNewAddr(""); setNewLabel(""); onChanged(); flash("ok", "Admin added ✔"); }
    else flash("err", data?.error ?? "Add error");
  };

  const remove = async (wallet: string) => {
    const res = await admin.authFetch("/admin/admins/" + wallet, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) { onChanged(); flash("ok", "Admin removed ✔"); }
    else flash("err", data?.error ?? "Remove error");
  };

  return (
    <Section title="Admins" desc="Multiple admins are kept. You cannot remove yourself or the last admin.">
      <div className="admin-add-row">
        <input className="admin-add-addr" placeholder="Wallet (base58)" value={newAddr} onChange={(e) => setNewAddr(e.target.value)} />
        <input className="admin-add-label" placeholder="Label (optional)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        <button className="btn-admin-mini" onClick={add}>Add</button>
      </div>
      <div className="admin-list">
        {admins.map((w) => (
          <div className="admin-list-row" key={w}>
            <code className="admin-addr">{w}</code>
            {w === admin.wallet && <span className="admin-you">you</span>}
            <button className="btn-admin-mini danger" onClick={() => remove(w)}>Remove</button>
          </div>
        ))}
      </div>
      {notice && <div className={"admin-notice notice-" + notice.kind}>{notice.text}</div>}
    </Section>
  );
}

function OpsTab({
  admin, onNotice, chance, onChanged,
  boardSizesStr, setBoardSizesStr, onField, onSave, currentSize, boardSizes = [],
  maintenance,
}: any) {
  const curIndex = boardSizes.indexOf(currentSize);
  const [targetSize, setTargetSize] = useState(String(boardSizes[curIndex + 1] ?? currentSize));
  // local = a separate state object. Each input updates its own field via setLocal (triggers re-render).
  const [local, setLocal] = useState<{
    poolSet: Record<string, string>;
    poolDelta: Record<string, string>;
    poolTop: Record<string, string>;
    kolAddr: string; kolName: string; kolAvatar: string; kolX: string;
  }>({
    poolSet: { grenade: "", missile: "", nuke: "" },
    poolDelta: { grenade: "", missile: "", nuke: "" },
    poolTop: { small: "", mid: "", big: "" },
    kolAddr: "", kolName: "", kolAvatar: "", kolX: "",
  });
  const setField = (k: string, v: string) => setLocal((s) => ({ ...s, [k]: v }));
  const setPoolStock = (sym: string, field: "poolSet" | "poolDelta", v: string) =>
    setLocal((s) => ({ ...s, [field]: { ...s[field], [sym]: v } }));
  const setPool = (k: "small" | "mid" | "big", v: string) =>
    setLocal((s) => ({ ...s, poolTop: { ...s.poolTop, [k]: v } }));

  const act = async (path: string, body: Record<string, unknown>, okMsg: string) => {
    const res = await admin.authFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok) { onNotice({ kind: "ok", text: okMsg + " ✔" }); onChanged(); }
    else onNotice({ kind: "err", text: data?.error ?? "Operation error" });
  };

  return (
    <div className="admin-section">
      <div className="admin-section-head">
        <span className="admin-section-title">Ops</span>
        <span className="admin-section-desc">Manual board/nuke/pool/KOL management (also done automatically by expansion ticks)</span>
      </div>

      <div className="admin-ops-block">
        <span className="admin-ops-title">Maintenance mode</span>
        <div className="admin-add-row">
          <span className={"admin-ops-note maintenance-pill " + (maintenance?.isMaintenance ? "on" : "off")}>
            {maintenance?.isMaintenance ? "● UNDER MAINTENANCE" : "○ LIVE"}
          </span>
          <button
            className="btn-admin-mini"
            disabled={!maintenance}
            onClick={() => act(
              "/admin/maintenance",
              { on: !maintenance?.isMaintenance, kickoff: true },
              maintenance?.isMaintenance ? "Maintenance off — cooldowns reset" : "Maintenance on"
            )}
          >
            {maintenance?.isMaintenance ? "End maintenance" : "Start maintenance"}
          </button>
        </div>
        <span className="admin-ops-note">
          {maintenance?.isMaintenance
            ? "Purchases are paused; the heatmap freezes. Ending maintenance resets every pixel's cooldown (last_buy_ts = now)."
            : "While ON: /quote returns 503, decay pauses, all clients see an overlay. Exit = full cooldown reset."}
        </span>
        {maintenance?.isMaintenance && maintenance?.maintenanceStartedAtMs != null && (
          <span className="admin-ops-note">
            Since {new Date(maintenance.maintenanceStartedAtMs).toLocaleString()}
          </span>
        )}
      </div>

      <div className="admin-ops-block danger">
        <span className="admin-ops-title">Danger zone</span>
        <div className="admin-add-row">
          <button
            className="btn-admin-mini danger"
            onClick={() => {
              if (!window.confirm(
                "Reset the game? This DELETES every pixel, purchase log, live-feed event, user-held symbols and referral data.\n" +
                "Keeps config: board size/prices, symbol stock, prize pools, KOL list and admins. This cannot be undone."
              )) return;
              if (!window.confirm("Are you SURE? There is no undo.")) return;
              act("/admin/reset", {}, "Canvas reset — clean board live");
            }}
          >
            Reset canvas
          </button>
          <span className="admin-ops-note">
            Wipes the whole game (cells, purchases, events, locks, symbols, referral data). Keeps config: board size/prices, symbol stock, prize pools, KOL list, admins.
          </span>
        </div>
      </div>

      <div className="admin-ops-block">
        <span className="admin-ops-title">Board size (index-authoritative)</span>
        <div className="admin-add-row">
          <input className="admin-add-addr" type="number" value={targetSize} onChange={(e) => setTargetSize(e.target.value)} placeholder="Target size" />
          {boardSizes.length > 0 && (() => {
              const t = Number(targetSize);
              const ti = boardSizes.indexOf(t);
              const opIdx = ti >= 0 ? ti : (t >= 0 && t > currentSize ? curIndex + 1 : curIndex - 1);
              return (
                <span className="admin-ops-note">
                  {ti >= 0
                    ? "index " + ti + " in list"
                    : "index " + (t > currentSize ? "after" : "before") + " → " + boardSizes[opIdx]}.
                </span>
              );
            })()}
        </div>
        <div className="admin-add-row">
          <button className="btn-admin-mini" onClick={() => act("/admin/expand", { toSize: Number(targetSize) }, "Resize applied")}>Apply board</button>
        </div>
        <div className="admin-add-row">
          <input
            className="admin-add-addr admin-board-sizes-input"
            type="text"
            value={boardSizesStr}
            onChange={(e) => {
              setBoardSizesStr(e.target.value);
              onField("BOARD_SIZES", e.target.value);
            }}
            placeholder="5,6,10,20"
          />
          <button className="btn-admin-mini" onClick={onSave}>Save sizes</button>
        </div>
        <span className="admin-ops-note">Current {currentSize}×{currentSize}{curIndex >= 0 ? ` (index ${curIndex})` : ""}. BOARD_SIZES list is index-based: this value can be grown and shrunk. Healthy target: any value in the list.</span>
      </div>

      <div className="admin-ops-block">
        <span className="admin-ops-title">Symbol drop stock</span>
        {Object.keys(chance ?? {}).map((sym) => {
          const cur = chance?.[sym]?.available ?? 0;
          return (
            <div className="admin-ops-sym" key={sym}>
              <span className="admin-ops-note">{sym} · stock: <strong>{cur}</strong></span>
              <div className="admin-add-row">
                <input className="admin-add-addr" type="number" value={local.poolSet[sym]} onChange={(e) => setPoolStock(sym, "poolSet", e.target.value)} placeholder="Set (absolute)" />
                <input className="admin-add-addr" type="number" value={local.poolDelta[sym]} onChange={(e) => setPoolStock(sym, "poolDelta", e.target.value)} placeholder="Delta (±)" />
                <button className="btn-admin-mini" onClick={() => act("/admin/nuke-pool", { symbol: sym, set: Number(local.poolSet[sym]) } as any, sym + " set")}>Set</button>
                <button className="btn-admin-mini" onClick={() => act("/admin/nuke-pool", { symbol: sym, delta: Number(local.poolDelta[sym]) } as any, sym + " Δ")}>Δ</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="admin-ops-block">
        <span className="admin-ops-title">Prize pool top-up (SOL)</span>
        <div className="admin-add-row">
          {(["small", "mid", "big"] as const).map((p) => (
            <input key={p} className="admin-add-addr" type="number" placeholder={p} value={local.poolTop[p]} onChange={(e) => setPool(p, e.target.value)} />
          ))}
          <button className="btn-admin-mini" onClick={() => {
            (["small", "mid", "big"] as const).forEach((p) => {
              const v = Number(local.poolTop[p]);
              if (v > 0) act("/admin/pool-topup", { id: p, sol: v }, p + " +" + v + " SOL");
            });
          }}>Top-up</button>
        </div>
      </div>

      <div className="admin-ops-block">
        <span className="admin-ops-title">KOL list</span>
        <div className="admin-add-row">
          <input className="admin-add-addr" placeholder="Wallet" value={local.kolAddr} onChange={(e) => setField("kolAddr", e.target.value)} />
          <input className="admin-add-addr" placeholder="Name" value={local.kolName} onChange={(e) => setField("kolName", e.target.value)} />
        </div>
        <div className="admin-add-row">
          <input className="admin-add-addr" placeholder="Avatar URL" value={local.kolAvatar} onChange={(e) => setField("kolAvatar", e.target.value)} />
          <input className="admin-add-addr" placeholder="X handle" value={local.kolX} onChange={(e) => setField("kolX", e.target.value)} />
          <button className="btn-admin-mini" onClick={() => act("/admin/kol", { addr: local.kolAddr, name: local.kolName, avatar: local.kolAvatar, x: local.kolX } as any, "KOL added")}>Add</button>
        </div>
      </div>
    </div>
  );
}