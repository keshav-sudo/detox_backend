import http from "http";
import { MongoClient } from "mongodb";
import express from "express";
import cors from "cors";
import { CORS_ORIGINS, DB_NAME, MONGO_URL, PORT } from "./config.js";
import { createSocketServer } from "./socket.js";
import { seedCatalog } from "./seed.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerCatalogRoutes } from "./routes/catalog.routes.js";
import { registerActivityRoutes } from "./routes/activity.routes.js";
import { registerPodRoutes } from "./routes/pod.routes.js";
import { registerIndexRoutes } from "./routes/index.routes.js";
import { hashPassword, newId } from "./auth.js";
import { nowIso } from "./lib/http.js";

if (!MONGO_URL) {
  throw new Error("MONGO_URL is required");
}

const app = express();
const server = http.createServer(app);
const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db(DB_NAME);
const io = createSocketServer(server);

app.use(cors({
  origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "healthy", timestamp: nowIso() });
});

registerAuthRoutes(app, db);
registerCatalogRoutes(app, db);
registerActivityRoutes(app, db, io);
registerPodRoutes(app, db, io);
registerIndexRoutes(app, db);

await seedCatalog(db);


server.listen(PORT, () => {
  console.log(`DetoxOS Node backend listening on http://localhost:${PORT}`);
});

process.on("SIGINT", async () => {
  try {
    await client.close();
  } finally {
    process.exit(0);
  }
});
