"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Modal } from "@/shared/components";

type ParsedProxyEntry = {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  type: string;
  region: string;
  status: string;
  notes: string;
};

type ParseError = {
  line: number;
  reason: string;
};

const BULK_IMPORT_TEMPLATE = `# Proxy Bulk Import
# Format: NAME|HOST|PORT|USERNAME|PASSWORD|TYPE|REGION|STATUS|NOTES
# Required: NAME, HOST, PORT
# Optional: USERNAME, PASSWORD, TYPE (http|https|socks5, default: socks5), REGION, STATUS (active|inactive, default: active), NOTES
# Lines starting with # are ignored. Existing proxies (same host+port) will be updated.
#
# SOCKS5 examples:
# proxy-us|138.99.147.218|50101|myuser|mypass|socks5|US-East|active|US production proxy
# proxy-eu|200.234.177.62|50101|myuser|mypass|socks5|EU-West
#
# HTTP/HTTPS examples:
# http-proxy|10.0.0.50|8080|||http||active|Internal HTTP proxy
# https-proxy|proxy.example.com|443|admin|secret123|https|US|active
`;

const VALID_TYPES = new Set(["http", "https", "socks5"]);
const VALID_STATUSES = new Set(["active", "inactive"]);

function parseBulkImportText(text: string): {
  entries: ParsedProxyEntry[];
  errors: ParseError[];
  skipped: number;
} {
  const lines = text.split("\n");
  const entries: ParsedProxyEntry[] = [];
  const errors: ParseError[] = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) {
      skipped++;
      continue;
    }

    const parts = raw.split("|").map((p) => p.trim());
    const [name, host, portStr, username, password, type, region, status, notes] = parts;
    const lineNum = i + 1;

    if (!name) {
      errors.push({ line: lineNum, reason: "bulkImportErrorMissingName" });
      continue;
    }
    if (!host) {
      errors.push({ line: lineNum, reason: "bulkImportErrorMissingHost" });
      continue;
    }
    const port = Number(portStr);
    if (!portStr || isNaN(port) || port < 1 || port > 65535) {
      errors.push({ line: lineNum, reason: "bulkImportErrorInvalidPort" });
      continue;
    }
    const normalizedType = (type || "socks5").toLowerCase();
    if (!VALID_TYPES.has(normalizedType)) {
      errors.push({ line: lineNum, reason: "bulkImportErrorInvalidType" });
      continue;
    }
    const normalizedStatus = (status || "active").toLowerCase();
    if (!VALID_STATUSES.has(normalizedStatus)) {
      errors.push({ line: lineNum, reason: "bulkImportErrorInvalidStatus" });
      continue;
    }

    entries.push({
      name,
      host,
      port,
      username: username || "",
      password: password || "",
      type: normalizedType,
      region: region || "",
      status: normalizedStatus,
      notes: notes || "",
    });
  }

  return { entries, errors, skipped };
}

interface BulkImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (msg: string | null) => void;
}

export default function BulkImportModal({
  isOpen,
  onClose,
  onDone,
  onError,
}: BulkImportModalProps) {
  const t = useTranslations("proxyRegistry");
  const [bulkImportText, setBulkImportText] = useState(BULK_IMPORT_TEMPLATE);
  const [bulkImportParsed, setBulkImportParsed] = useState<ParsedProxyEntry[]>([]);
  const [bulkImportErrors, setBulkImportErrors] = useState<ParseError[]>([]);
  const [bulkImportSkipped, setBulkImportSkipped] = useState(0);
  const [bulkImportParsedOnce, setBulkImportParsedOnce] = useState(false);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkImportResult, setBulkImportResult] = useState<{
    created: number;
    updated: number;
    failed: number;
  } | null>(null);

  // Reset to a fresh template every time the modal opens (matches the
  // pre-extraction openBulkImport() behavior).
  useEffect(() => {
    if (!isOpen) return;
    setBulkImportText(BULK_IMPORT_TEMPLATE);
    setBulkImportParsed([]);
    setBulkImportErrors([]);
    setBulkImportSkipped(0);
    setBulkImportParsedOnce(false);
    setBulkImportResult(null);
  }, [isOpen]);

  const handleBulkImportParse = () => {
    const { entries, errors, skipped } = parseBulkImportText(bulkImportText);
    setBulkImportParsed(entries);
    setBulkImportErrors(errors);
    setBulkImportSkipped(skipped);
    setBulkImportParsedOnce(true);
    setBulkImportResult(null);
  };

  const handleBulkImportExecute = async () => {
    if (bulkImportParsed.length === 0) return;
    if (bulkImportParsed.length > 100) {
      onError(t("bulkImportMaxExceeded"));
      return;
    }

    setBulkImporting(true);
    onError(null);
    setBulkImportResult(null);

    try {
      const payload = {
        items: bulkImportParsed.map((entry) => ({
          name: entry.name,
          type: entry.type,
          host: entry.host,
          port: entry.port,
          username: entry.username || undefined,
          password: entry.password || undefined,
          region: entry.region || null,
          notes: entry.notes || null,
          status: entry.status as "active" | "inactive",
        })),
      };

      const res = await fetch("/api/settings/proxies/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        onError(data?.error?.message || t("errorSaveFailed"));
        return;
      }

      setBulkImportResult({
        created: data.created || 0,
        updated: data.updated || 0,
        failed: data.failed || 0,
      });

      await onDone();
    } catch (e: any) {
      onError(e?.message || t("errorSaveFailed"));
    } finally {
      setBulkImporting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!bulkImporting) onClose();
      }}
      title={t("bulkImportTitle")}
      maxWidth="xl"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">{t("bulkImportDescription")}</p>

        <div>
          <textarea
            data-testid="proxy-registry-bulk-import-textarea"
            className="w-full px-3 py-2 rounded bg-bg-subtle border border-border font-mono text-xs leading-relaxed"
            rows={14}
            value={bulkImportText}
            onChange={(e) => {
              setBulkImportText(e.target.value);
              setBulkImportParsedOnce(false);
              setBulkImportResult(null);
            }}
            spellCheck={false}
          />
        </div>

        {/* Parse button */}
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            icon="search"
            onClick={handleBulkImportParse}
            data-testid="proxy-registry-bulk-import-parse"
          >
            {t("bulkImportParse")}
          </Button>

          {bulkImportParsedOnce && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-emerald-400">
                {t("bulkImportParsed", { count: bulkImportParsed.length })}
              </span>
              <span className="text-text-muted">
                {t("bulkImportSkipped", { count: bulkImportSkipped })}
              </span>
              {bulkImportErrors.length > 0 && (
                <span className="text-red-400">
                  {t("bulkImportParseErrors", { count: bulkImportErrors.length })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Parse errors */}
        {bulkImportErrors.length > 0 && (
          <div className="max-h-28 overflow-y-auto rounded border border-red-500/30 bg-red-500/10 p-2">
            {bulkImportErrors.map((err, idx) => (
              <div key={idx} className="text-xs text-red-400">
                {t("bulkImportErrorLine", { line: err.line, reason: t(err.reason as any) })}
              </div>
            ))}
          </div>
        )}

        {/* Preview table */}
        {bulkImportParsedOnce && bulkImportParsed.length > 0 && (
          <div className="overflow-x-auto max-h-48 overflow-y-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-muted border-b border-border bg-bg-subtle sticky top-0">
                  <th className="py-1.5 px-2">{t("tableName")}</th>
                  <th className="py-1.5 px-2">{t("labelType")}</th>
                  <th className="py-1.5 px-2">{t("labelHost")}</th>
                  <th className="py-1.5 px-2">{t("labelPort")}</th>
                  <th className="py-1.5 px-2">{t("labelUsername")}</th>
                  <th className="py-1.5 px-2">{t("labelRegion")}</th>
                  <th className="py-1.5 px-2">{t("labelStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {bulkImportParsed.map((entry, idx) => (
                  <tr key={idx} className="border-b border-border/40">
                    <td className="py-1 px-2 font-medium text-text-main">{entry.name}</td>
                    <td className="py-1 px-2">
                      <span className="px-1.5 py-0.5 rounded bg-bg-subtle border border-border text-[10px]">
                        {entry.type}
                      </span>
                    </td>
                    <td className="py-1 px-2 font-mono text-text-muted">{entry.host}</td>
                    <td className="py-1 px-2 font-mono text-text-muted">{entry.port}</td>
                    <td className="py-1 px-2 text-text-muted">{entry.username || "—"}</td>
                    <td className="py-1 px-2 text-text-muted">{entry.region || "—"}</td>
                    <td className="py-1 px-2">
                      <span
                        className={
                          entry.status === "active" ? "text-emerald-400" : "text-text-muted"
                        }
                      >
                        {entry.status === "active" ? t("statusActive") : t("statusInactive")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* No valid entries warning */}
        {bulkImportParsedOnce &&
          bulkImportParsed.length === 0 &&
          bulkImportErrors.length === 0 && (
            <div className="text-sm text-amber-400">{t("bulkImportNoValidEntries")}</div>
          )}

        {/* Import result */}
        {bulkImportResult && (
          <div className="px-3 py-2 rounded border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-400">
            {t("bulkImportSuccess", {
              created: bulkImportResult.created,
              updated: bulkImportResult.updated,
              failed: bulkImportResult.failed,
            })}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            icon="upload"
            onClick={handleBulkImportExecute}
            loading={bulkImporting}
            disabled={!bulkImportParsedOnce || bulkImportParsed.length === 0}
            data-testid="proxy-registry-bulk-import-execute"
          >
            {bulkImporting
              ? t("bulkImportImporting")
              : bulkImportParsed.length > 0
                ? t("bulkImportImport", { count: bulkImportParsed.length })
                : t("bulkImport")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
