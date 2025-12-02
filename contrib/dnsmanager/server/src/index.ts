import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import soaRoutes from "./routes/soa.js";
import rrRoutes from "./routes/rr.js";
import cloudflareRoutes from "./routes/cloudflare.js";
import usersRoutes from "./routes/users.js";
import settingsRoutes from "./routes/settings.js";
import tokensRoutes from "./routes/tokens.js";
import ticketsRoutes from "./routes/tickets.js";
import logsRoutes from "./routes/logs.js";
import publicApiRoutes from "./routes/publicApi.js";
import permissionsRoutes from "./routes/permissions.js";
import geosensorsRoutes from "./routes/geosensors.js";
import dnssecRoutes from "./routes/dnssec.js";
import aclRoutes from "./routes/acl.js";
import userCloudflareRoutes from "./routes/userCloudflare.js";
import zoneAclsRoutes from "./routes/zoneAcls.js";
import { getActiveHost } from "./db.js";
import { startWorker, stopWorker } from "./dnssec-worker.js";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const ORIGIN = process.env.DNSMANAGER_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    activeHost: getActiveHost(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/soa", soaRoutes);
app.use("/api/rr", rrRoutes);
app.use("/api/cloudflare", cloudflareRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/tokens", tokensRoutes);
app.use("/api/tickets", ticketsRoutes);
app.use("/api/logs", logsRoutes);
app.use("/api/v1", publicApiRoutes);
app.use("/api/permissions", permissionsRoutes);
app.use("/api/sensors", geosensorsRoutes);
app.use("/api/dnssec", dnssecRoutes);
app.use("/api/acl", aclRoutes);
app.use("/api/user-cloudflare", userCloudflareRoutes);
app.use("/api/zone-acls", zoneAclsRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ message: "Unexpected server error" });
});

app.listen(PORT, () => {
  console.log(`DNS Manager API listening on http://localhost:${PORT}`);

  // Start DNSSEC signing worker
  console.log("Starting DNSSEC signing worker...");
  startWorker(30000); // Check queue every 30 seconds
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  stopWorker();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  stopWorker();
  process.exit(0);
});
