import { readFile } from "fs/promises";
import fs from "fs";
import path from "path";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";

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

const LOG_FILE = path.join(resolveScraperDataDir(), "scraper.log");

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    let raw = "";
    try {
      raw = await readFile(LOG_FILE, "utf8");
    } catch {
      raw = "";
    }

    const lines = raw.split("\n");
    const tail = lines.slice(-250).join("\n");

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
