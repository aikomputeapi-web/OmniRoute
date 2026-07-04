import { writeFile } from "fs/promises";
import fs from "fs";
import path from "path";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";

const TRIGGER_FILE = path.join(resolveScraperDataDir(), "trigger_scrape");

function resolveScraperDataDir(): string {
  if (process.env.SCRAPER_DATA_DIR) {
    return path.resolve(process.env.SCRAPER_DATA_DIR);
  }
  const dockerPath = "/app/proxy_scraper_data";
  try {
    if (fs.existsSync(dockerPath)) return dockerPath;
  } catch {}
  return path.join(process.cwd(), "proxy_scraper_data");
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    // Write a trigger file. The scraper's loop polls for this file and breaks
    // out of its sleep early to start a fresh scrape immediately.
    fs.mkdirSync(path.dirname(TRIGGER_FILE), { recursive: true });
    await writeFile(TRIGGER_FILE, new Date().toISOString(), "utf8");
    return Response.json({ success: true, message: "Scrape triggered successfully" });
  } catch (error: any) {
    console.error("[Scraper] Failed to write trigger file:", error);
    return createErrorResponse({
      status: 500,
      message: `Failed to trigger scraper: ${error.message || error}`,
      type: "server_error",
    });
  }
}
