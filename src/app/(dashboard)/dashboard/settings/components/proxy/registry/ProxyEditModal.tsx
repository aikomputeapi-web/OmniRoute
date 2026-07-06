"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Modal } from "@/shared/components";

export type ProxyItem = {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  region?: string | null;
  notes?: string | null;
  status?: string;
  family?: string;
};

const EMPTY_FORM = {
  id: "",
  name: "",
  type: "http",
  host: "",
  port: "8080",
  username: "",
  password: "",
  region: "",
  notes: "",
  status: "active",
  family: "auto",
};

interface ProxyEditModalProps {
  isOpen: boolean;
  initial: ProxyItem | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (msg: string | null) => void;
}

export default function ProxyEditModal({
  isOpen,
  initial,
  onClose,
  onSaved,
  onError,
}: ProxyEditModalProps) {
  const t = useTranslations("proxyRegistry");
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    if (initial) {
      setForm({
        id: initial.id,
        name: initial.name || "",
        type: initial.type || "http",
        host: initial.host || "",
        port: String(initial.port || 8080),
        username: "",
        password: "",
        region: initial.region || "",
        notes: initial.notes || "",
        status: initial.status || "active",
        family: initial.family || "auto",
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [isOpen, initial]);

  const editingId = form.id || "";

  const handleSave = async () => {
    if (!(form.name || "").trim() || !(form.host || "").trim()) {
      onError(t("errorNameHostRequired"));
      return;
    }

    setSaving(true);
    onError(null);

    const normalizedUsername = (form.username || "").trim();
    const normalizedPassword = (form.password || "").trim();

    const payload: Record<string, unknown> = {
      ...(editingId ? { id: editingId } : {}),
      name: (form.name || "").trim(),
      type: form.type,
      host: (form.host || "").trim(),
      port: Number(form.port || 8080),
      region: (form.region || "").trim() || null,
      notes: (form.notes || "").trim() || null,
      status: form.status,
      family: form.family || "auto",
    };
    if (!editingId || normalizedUsername.length > 0) {
      payload.username = normalizedUsername;
    }
    if (!editingId || normalizedPassword.length > 0) {
      payload.password = normalizedPassword;
    }

    try {
      const res = await fetch("/api/settings/proxies", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(data?.error?.message || t("errorSaveFailed"));
        return;
      }

      onClose();
      await onSaved();
    } catch (e: any) {
      onError(e?.message || t("errorSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={editingId ? t("modalEditTitle") : t("modalCreateTitle")}
      maxWidth="lg"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
        autoComplete="off"
        data-1p-ignore="true"
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelName")}</label>
            <input
              data-testid="proxy-registry-name-input"
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelType")}</label>
            <select
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.type}
              onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
            >
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelFamily")}</label>
            <select
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.family}
              onChange={(e) => setForm((prev) => ({ ...prev, family: e.target.value }))}
            >
              <option value="auto">{t("familyAuto")}</option>
              <option value="ipv4">{t("familyIpv4")}</option>
              <option value="ipv6">{t("familyIpv6")}</option>
            </select>
            <p className="text-[11px] text-text-muted mt-1">{t("familyHint")}</p>
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelHost")}</label>
            <input
              data-testid="proxy-registry-host-input"
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.host}
              onChange={(e) => setForm((prev) => ({ ...prev, host: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelPort")}</label>
            <input
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.port}
              onChange={(e) => setForm((prev) => ({ ...prev, port: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelUsername")}</label>
            <input
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.username}
              placeholder={editingId ? t("usernamePlaceholderEdit") : ""}
              onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelPassword")}</label>
            <input
              type="password"
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.password}
              placeholder={editingId ? t("passwordPlaceholderEdit") : ""}
              onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelRegion")}</label>
            <input
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.region}
              onChange={(e) => setForm((prev) => ({ ...prev, region: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted mb-1 block">{t("labelStatus")}</label>
            <select
              className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
              value={form.status}
              onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))}
            >
              <option value="active">{t("statusActive")}</option>
              <option value="inactive">{t("statusInactive")}</option>
            </select>
          </div>
        </div>

        <div>
          <label className="text-xs text-text-muted mb-1 block">{t("labelNotes")}</label>
          <textarea
            className="w-full px-3 py-2 rounded bg-bg-subtle border border-border"
            value={form.notes}
            onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
            rows={3}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button size="sm" icon="save" onClick={handleSave} loading={saving}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
