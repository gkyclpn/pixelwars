// pm2 ecosystem config — crash containment for the backend.
// The server calls process.exit(1) on unhandled rejections (see server.ts); pm2 is the
// orchestrator that restarts a clean process. env vars (RPC_URL, PG*, ...) are
// loaded from backend/.env by the app itself via dotenv, so none need to be repeated here.
//
// Usage:
//   npm run pm2:start   # build + start prod (dist/server.js)
//   npm run pm2:dev     # start dev (tsx — hot reload) under pm2
//   pm2 logs pixelwars  tail logs
//   pm2 monit          memory/heartbeat view
//   pm2 restart pixelwars
//   pm2 kill           stop all + wipe status
module.exports = {
  apps: [
    {
      name: "pixelwars",
      script: "dist/server.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      max_memory_restart: "1G",
      exp_backoff_restart_delay: 100,
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      time: true,
      env: { NODE_ENV: "production" },
    },
    {
      name: "pixelwars-dev",
      script: "src/server.ts",
      cwd: __dirname,
      interpreter: "node",
      interpreter_args: "--import tsx",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      max_memory_restart: "1G",
      out_file: "./logs/pm2-dev-out.log",
      error_file: "./logs/pm2-dev-error.log",
      merge_logs: true,
      time: true,
      env: { NODE_ENV: "development" },
    },
  ],
};