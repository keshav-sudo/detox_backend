import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
];

for (const envPath of candidates) {
  dotenv.config({ path: envPath, override: false });
}

export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_FILE = path.resolve(__dirname, "..", "..", "..", "data", "full_detox_data.json");
export const PORT = Number(process.env.PORT || 8000);
export const MONGO_URL = process.env.MONGO_URL || "";
export const DB_NAME = process.env.DB_NAME || "test_database";
export const JWT_SECRET = process.env.JWT_SECRET || "change_me";
export const JWT_ALG = "HS256";
export const JWT_EXP_DAYS = 30;
export const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
