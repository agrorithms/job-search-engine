import "dotenv/config";
import { Pool } from "pg";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set; copy .env.example to .env.local.");
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on("error", (err) => console.error("PostgreSQL pool error", err));
