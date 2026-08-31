// Backend API base. In every environment the frontend reaches the backend through
// its own origin under the `/api` prefix; Vite proxies that to localhost:8787
// (vite.config.ts). That way every origin — mobile/safari/Phantom included — is
// served from a single trusted host, with no separate self-signed backend host.
// If `VITE_API_URL` is set it's used directly (prod: the real API domain).
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export { API_BASE };