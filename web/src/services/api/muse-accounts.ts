export type MuseAccountSummary = { label: string; enabled: boolean; complete: boolean };

async function request(token: string, signal: AbortSignal, input?: { label: string; session: string }) {
    const response = await fetch("/api/muse-studio/accounts", {
        method: input ? "POST" : "GET", headers: { Authorization: "Bearer " + token, ...(input ? { "Content-Type": "application/json" } : {}) },
        body: input ? JSON.stringify(input) : undefined, signal, cache: "no-store", redirect: "error",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Muse 账号请求失败");
    return data;
}

export async function listMuseAccounts(token: string, signal: AbortSignal): Promise<{ importOnly?: boolean; accounts?: MuseAccountSummary[] }> {
    return request(token, signal);
}

export function importMuseAccount(token: string, signal: AbortSignal, label: string, session: string): Promise<{ complete: boolean }> {
    return request(token, signal, { label, session });
}
