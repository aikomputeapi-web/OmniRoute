import { generateVirtualCatalog, getVirtualCatalogEntries } from "@/lib/catalog/generateVirtualCatalog";
import { getSettings, updateSettings } from "@/lib/db/settings";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_STARTUP_DELAY_MS = 60_000;
const LAST_RUN_SETTING_KEY = "virtual_catalog_last_regenerated_at";

let schedulerTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let isRunning = false;

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getIntervalMs(intervalMs = DEFAULT_INTERVAL_MS): number {
  const envHours = parsePositiveInteger(process.env.VIRTUAL_CATALOG_REGEN_INTERVAL_HOURS);
  return envHours ? envHours * 60 * 60 * 1000 : intervalMs;
}

function getStartupDelayMs(): number {
  return parsePositiveInteger(process.env.VIRTUAL_CATALOG_REGEN_STARTUP_DELAY_MS) ?? DEFAULT_STARTUP_DELAY_MS;
}

async function shouldRegenerate(): Promise<boolean> {
  const settings = await getSettings();
  if (settings.virtualCatalogEnabled !== true) {
    return false;
  }

  const existingEntries = await getVirtualCatalogEntries();
  if (existingEntries.length === 0) {
    return true;
  }

  return true;
}

async function runVirtualCatalogRegenerationCycle(): Promise<void> {
  if (isRunning) {
    console.log("[VirtualCatalog] Skipping regeneration — previous run still in progress");
    return;
  }

  isRunning = true;
  const start = Date.now();

  try {
    if (!(await shouldRegenerate())) {
      console.log("[VirtualCatalog] Scheduler active but catalog disabled — skipping regeneration");
      return;
    }

    const result = await generateVirtualCatalog();
    await updateSettings({ [LAST_RUN_SETTING_KEY]: new Date().toISOString() });

    console.log(
      `[VirtualCatalog] Regeneration complete: created=${result.created}, deleted=${result.deleted}, warnings=${result.warnings.length}, errors=${result.errors.length} in ${Date.now() - start}ms`
    );

    for (const warning of result.warnings) {
      console.warn(`[VirtualCatalog] Warning: ${warning}`);
    }
    for (const error of result.errors) {
      console.warn(`[VirtualCatalog] Error: ${error}`);
    }
  } catch (error) {
    console.warn("[VirtualCatalog] Regeneration failed:", error instanceof Error ? error.message : String(error));
  } finally {
    isRunning = false;
  }
}

export function startVirtualCatalogRegenerationScheduler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (schedulerTimer || startupTimer) {
    console.log("[VirtualCatalog] Scheduler already running — skipping start");
    return;
  }

  const effectiveIntervalMs = getIntervalMs(intervalMs);
  console.log(`[VirtualCatalog] Scheduler started — interval: ${effectiveIntervalMs / 3_600_000}h`);

  void (async () => {
    let initialDelayMs = getStartupDelayMs();

    try {
      const settings = await getSettings();
      const lastRunAt = typeof settings[LAST_RUN_SETTING_KEY] === "string" ? settings[LAST_RUN_SETTING_KEY] : null;
      if (lastRunAt) {
        const lastRunMs = Date.parse(lastRunAt);
        if (Number.isFinite(lastRunMs)) {
          const elapsedMs = Date.now() - lastRunMs;
          if (elapsedMs < effectiveIntervalMs) {
            initialDelayMs = Math.max(effectiveIntervalMs - elapsedMs, initialDelayMs);
          }
        }
      }
    } catch {
      // If settings are unavailable, keep the default startup delay and let the cycle report details.
    }

    startupTimer = setTimeout(() => {
      startupTimer = null;
      void runVirtualCatalogRegenerationCycle();

      schedulerTimer = setInterval(() => {
        void runVirtualCatalogRegenerationCycle();
      }, effectiveIntervalMs);
      schedulerTimer.unref?.();
    }, initialDelayMs);

    startupTimer.unref?.();
  })();
}

export function stopVirtualCatalogRegenerationScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[VirtualCatalog] Scheduler stopped");
  }
}
