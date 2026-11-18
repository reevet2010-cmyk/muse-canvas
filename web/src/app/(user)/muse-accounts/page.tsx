"use client";

import { Alert, Button, Input, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import { importMuseAccount, listMuseAccounts, type MuseAccountSummary } from "@/services/api/muse-accounts";
import { useUserStore } from "@/stores/use-user-store";

export default function MuseAccountsPage() {
    const { user, token, isReady } = useUserStore();
    const [secure, setSecure] = useState(false);
    const [accounts, setAccounts] = useState<MuseAccountSummary[]>();
    const [allowed, setAllowed] = useState(false);
    const [label, setLabel] = useState("");
    const [session, setSession] = useState("");
    const [busy, setBusy] = useState(false);
    const [revision, refresh] = useState(0);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const posting = useRef<AbortController | null>(null);
    useEffect(() => { setSecure(window.isSecureContext); return () => posting.current?.abort(); }, []);
    useEffect(() => {
        setAllowed(false);
        setAccounts(undefined);
        if (!secure || !token) return;
        const controller = new AbortController();
        setError("");
        listMuseAccounts(token, controller.signal).then(data => {
            if (controller.signal.aborted) return;
            setAllowed(data.importOnly === true || Array.isArray(data.accounts));
            setAccounts(data.accounts);
        }).catch(cause => {
            if (!controller.signal.aborted) setError(cause.message || "账号列表读取失败");
        });
        return () => controller.abort();
    }, [token, secure, revision]);

    async function submit() {
        if (!secure || !allowed || posting.current || !session.trim()) return;
        const controller = new AbortController();
        posting.current = controller;
        setBusy(true); setNotice(""); setError("");
        try {
            const result = await importMuseAccount(token, controller.signal, label, session);
            setSession(""); setLabel("");
            setNotice(result.complete ? "账号已导入。" : "账号已保存，但会话信息不完整，可能无法生成。");
            if (accounts) refresh(n => n + 1);
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "导入失败");
        } finally { posting.current = null; setBusy(false); }
    }
    return <main className="h-full overflow-y-auto px-5 py-8"><div className="mx-auto max-w-xl space-y-5">
        <h1 className="text-2xl font-semibold">导入 Muse 账号</h1>
        {!isReady ? <p>正在检查登录状态…</p> : !secure ? <Alert type="info" title="请通过 HTTPS 打开此页再登录和导入账号。" /> :
            !user ? <Button type="primary" href="/login?redirect=%2Fmuse-accounts">登录画布账号</Button> :
            !allowed ? (error ? <Alert type="warning" title={error} action={<Button size="small" onClick={() => refresh(n => n + 1)}>重试</Button>} /> : <p>正在加载…</p>) : <>
                <p>在 <a className="underline" href="https://muse.ai/" target="_blank" rel="noreferrer">Muse 官网</a> 登录自己的账号，再导入该账号已导出的单行 Cookie。</p>
                <form className="space-y-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
                    <label className="block">账号备注（选填）<Input value={label} maxLength={100} disabled={busy} onChange={e => setLabel(e.target.value)} /></label>
                    <label className="block">Muse Cookie<Input.Password value={session} maxLength={32000} autoComplete="off" spellCheck={false}
                        placeholder="name=value; name2=value2" disabled={busy} onChange={e => setSession(e.target.value)} /></label>
                    <Button type="primary" htmlType="submit" loading={busy} disabled={!session.trim()}>导入账号</Button>
                </form>
                {notice && <p role="status">{notice}</p>}
                {error && <Alert type="error" title={error} />}
                {accounts && <><Space><h2 className="font-semibold">已导入账号</h2><Button size="small" onClick={() => refresh(n => n + 1)}>刷新</Button></Space>
                    {accounts.length ? <ul>{accounts.map((a, i) => <li key={i}>{a.label} · {a.enabled ? "已启用" : "已停用"} · {a.complete ? "会话字段齐全" : "会话字段不完整"}</li>)}</ul> : <p>还没有导入 Muse 账号。</p>}</>}
            </>}
    </div></main>;
}
