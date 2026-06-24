import { readFile } from "fs/promises";
import path from "path";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";

// Shared volume path: omniroute mounts proxy_scraper_data at /app/proxy_scraper_data
const SCRAPER_DATA_DIR = path.resolve("/app/proxy_scraper_data");
const LOG_FILE = path.join(SCRAPER_DATA_DIR, "scraper.log");

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    let raw = "";
    try {
      raw = await readFile(LOG_FILE, "utf8");
    } catch {
      // Log file doesn't exist yet — scraper hasn't run or log not written
      raw = "";
    }

    // Return only the last 250 lines so the UI console stays manageable
    const lines = raw.split("\n");
    const tail = lines.slice(-250).join("\n");

    // Strip ANSI escape codes
    const cleaned = tail.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      ""
    );

    return Response.json({ success: true, logs: cleaned });
  } catch (error: any) {
    console.error("[Scraper] Failed to read scraper log file:", error);
    return createErrorResponse({
      status: 500,
      message: `Failed to read scraper logs: ${error.message || error}`,
      type: "server_error",
    });
  }
}
