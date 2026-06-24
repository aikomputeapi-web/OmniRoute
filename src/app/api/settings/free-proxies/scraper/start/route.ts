import { writeFile } from "fs/promises";
import path from "path";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";

// Shared volume path: omniroute mounts proxy_scraper_data at /app/proxy_scraper_data
const SCRAPER_DATA_DIR = path.resolve("/app/proxy_scraper_data");
const TRIGGER_FILE = path.join(SCRAPER_DATA_DIR, "trigger_scrape");

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    // Write a trigger file. The scraper's loop polls for this file and breaks
    // out of its sleep early to start a fresh scrape immediately.
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
