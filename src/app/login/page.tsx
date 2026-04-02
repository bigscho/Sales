"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface MemberOption {
  id: string;
  name: string;
  role: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [allMembers, setAllMembers] = useState<MemberOption[]>([]);
  const [isSetup, setIsSetup] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);

  useEffect(() => {
    // Check if any members have PINs
    fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "members" }),
    })
      .then(r => r.json())
      .then(d => {
        const withPins = d.members || [];
        setMembers(withPins);
        if (withPins.length === 0) {
          // No PINs set — first-run setup mode
          // Fetch all members so admin can pick themselves
          setIsSetup(true);
          fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "setup_members" }),
          })
            .then(r => r.json())
            .then(d2 => { setAllMembers(d2.members || []); setPageLoading(false); })
            .catch(() => setPageLoading(false));
        } else {
          setPageLoading(false);
        }
      })
      .catch(() => setPageLoading(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId || !pin) return;
    setError("");
    setLoading(true);

    const action = isSetup ? "setup" : "login";
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, memberId: selectedId, pin }),
    });

    const data = await res.json();
    if (res.ok) {
      const params = new URLSearchParams(window.location.search);
      const from = params.get("from") || "/";
      router.push(from);
      router.refresh();
    } else {
      setError(data.error || "Login failed");
      setPin("");
    }
    setLoading(false);
  };

  if (pageLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="h-48 w-80 bg-white rounded-xl border animate-pulse" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-green-700">Grassfed</CardTitle>
          <p className="text-sm text-gray-500 mt-1">Sales Tracker</p>
          {isSetup && (
            <p className="text-xs text-blue-600 mt-2">First-time setup — choose your account and set a PIN</p>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isSetup ? "Your Name" : "Name"}
              </label>
              <select
                value={selectedId}
                onChange={e => setSelectedId(e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                required
              >
                <option value="">Select your name</option>
                {(isSetup ? allMembers : members).map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isSetup ? "Choose a PIN" : "PIN"}
              </label>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, ""))}
                placeholder={isSetup ? "Choose a 4-6 digit PIN" : "Enter your PIN"}
                className="w-full border rounded-lg px-3 py-2.5 text-sm text-center tracking-widest text-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                required
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 text-center">{error}</p>
            )}

            <Button type="submit" className="w-full py-2.5" disabled={loading || !selectedId || !pin}>
              {loading ? (isSetup ? "Setting up..." : "Logging in...") : (isSetup ? "Set Up & Log In" : "Log In")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
