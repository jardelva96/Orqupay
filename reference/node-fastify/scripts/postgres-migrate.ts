import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

async function main(): Promise<void> {
  const connectionString = process.env.PMC_POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error("PMC_POSTGRES_URL is required.");
  }

  const migrationPath = resolve(process.cwd(), "sql", "001_durable_runtime.sql");
  const sql = await readFile(migrationPath, "utf8");
  const pool = new Pool({ connectionString });

  try {
    await pool.query(sql);
    console.log(`db:migrate OK (${migrationPath})`);
  } finally {
    await pool.end();
  }
}

await main();
