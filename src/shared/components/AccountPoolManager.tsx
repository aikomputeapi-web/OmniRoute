"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components/Card";
import { Button } from "@/shared/components/Button";
import { Input } from "@/shared/components/Input";

interface AccountMetrics {
  accountId: string;
  providerId: string;
  tokensUsedHour: number;
  requestsUsedMinute: number;
  errorCount: number;
  lastUsed: number;
  maxTokensPerHour: number;
  maxRequestsPerMinute: number;
  inCooldown: boolean;
}

export function AccountPoolManager() {
  const [accounts, setAccounts] = useState<AccountMetrics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAccounts();
    const interval = setInterval(fetchAccounts, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchAccounts() {
    try {
      const res = await fetch("/api/account-pool/metrics");
      const data = await res.json();
      setAccounts(data.accounts || []);
    } catch (err) {
      console.error("Failed to fetch account metrics:", err);
    } finally {
      setLoading(false);
    }
  }

  async function cooldownAccount(accountId: string) {
    await fetch("/api/account-pool/cooldown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, seconds: 300 }),
    });
    fetchAccounts();
  }

  async function resetErrors(accountId: string) {
    await fetch("/api/account-pool/reset-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    fetchAccounts();
  }

  if (loading) return <div>Loading account pool...</div>;

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Account Pool Manager</h2>
      
      <div className="grid gap-4">
        {accounts.map((account) => (
          <Card key={account.accountId} className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">
                    {account.accountId.slice(0, 12)}...
                  </span>
                  <span className="text-xs text-gray-500">
                    {account.providerId}
                  </span>
                  {account.inCooldown && (
                    <span className="px-2 py-1 text-xs bg-yellow-100 text-yellow-800 rounded">
                      Cooldown
                    </span>
                  )}
                  {account.errorCount >= 5 && (
                    <span className="px-2 py-1 text-xs bg-red-100 text-red-800 rounded">
                      Quarantined
                    </span>
                  )}
                </div>
                
                <div className="mt-2 grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <div className="text-gray-500">Tokens/Hour</div>
                    <div className="font-semibold">
                      {account.tokensUsedHour.toLocaleString()} / {account.maxTokensPerHour.toLocaleString()}
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
                      <div
                        className="bg-blue-600 h-2 rounded-full"
                        style={{
                          width: `${Math.min(100, (account.tokensUsedHour / account.maxTokensPerHour) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  
                  <div>
                    <div className="text-gray-500">Requests/Min</div>
                    <div className="font-semibold">
                      {account.requestsUsedMinute} / {account.maxRequestsPerMinute}
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
                      <div
                        className="bg-green-600 h-2 rounded-full"
                        style={{
                          width: `${Math.min(100, (account.requestsUsedMinute / account.maxRequestsPerMinute) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  
                  <div>
                    <div className="text-gray-500">Errors</div>
                    <div className="font-semibold">{account.errorCount}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      Last used: {new Date(account.lastUsed).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="flex gap-2 ml-4">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => cooldownAccount(account.accountId)}
                  disabled={account.inCooldown}
                >
                  Cooldown
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => resetErrors(account.accountId)}
                  disabled={account.errorCount === 0}
                >
                  Reset Errors
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      
      {accounts.length === 0 && (
        <div className="text-center text-gray-500 py-8">
          No accounts in pool. Add accounts via the Providers page.
        </div>
      )}
    </div>
  );
}
