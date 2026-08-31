import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { AdminPanel } from "./components/AdminPanel";
import { useAdminAuth } from "./hooks/useAdminAuth";
import { API_BASE } from "./api";

// The hidden admin route's page. Only mounted on this route — the main game never
// calls useAdminAuth (zero /admin/* requests on the network).
// Flow: is the connected wallet an admin (public whitelisted boolean) → JWT? show the
// panel, otherwise a one-time signature. Non-admin / no wallet → neutral "Page not found".

const API = API_BASE;

export function AdminApp() {
  const { publicKey, connected } = useWallet();
  const admin = useAdminAuth();
  const [whitelisted, setWhitelisted] = useState<null | boolean>(null);

  // Do the public check first so a non-admin never sees a signature prompt.
  useEffect(() => {
    if (!connected || !publicKey) { setWhitelisted(null); return; }
    const vault = publicKey.toBase58();
    fetch(`${API}/admin/whitelisted?vault=${vault}`)
      .then((r) => r.json())
      .then((d) => setWhitelisted(!!d.whitelisted))
      .catch(() => setWhitelisted(false));
  }, [connected, publicKey]);

  // Whitelisted but no valid JWT → one-time login (only the admin wallet signs).
  useEffect(() => {
    if (whitelisted && !admin.isAdmin && !admin.loading) {
      admin.login();
    }
  }, [whitelisted, admin.isAdmin, admin.loading, admin.login]);

  if (admin.loading || whitelisted === null) return null;
  if (!whitelisted || !admin.isAdmin) return <PageNotFound />;
  return <AdminPanel admin={admin} />;
}

export function PageNotFound() {
  return (
    <div className="app">
      <div className="nf">
        <h3>Page not found</h3>
      </div>
    </div>
  );
}
