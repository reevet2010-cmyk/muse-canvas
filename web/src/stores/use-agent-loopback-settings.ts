"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { normalizeAgentLoopbackUrl, type AgentLoopbackSettings } from "@/services/api/agent-loopback";
import { useUserStore } from "@/stores/use-user-store";

const storageKey = (owner: string) => "muse-canvas:agent-loopback:" + owner;
const useLoopbackState = create<{ owner?: string; settings?: AgentLoopbackSettings }>(() => ({}));

export function getAgentLoopbackSettings() {
    const { user, isReady } = useUserStore.getState();
    const state = useLoopbackState.getState();
    return isReady && state.owner === (user?.id || "guest") ? state.settings : undefined;
}

export function saveAgentLoopbackSettings(owner: string, settings?: AgentLoopbackSettings) {
    if (settings) localStorage.setItem(storageKey(owner), JSON.stringify(settings));
    else localStorage.removeItem(storageKey(owner));
    useLoopbackState.setState({ owner, settings });
}

export function useAgentLoopbackSettings() {
    const owner = useUserStore(state => state.isReady ? (state.user?.id || "guest") : undefined);
    const state = useLoopbackState();
    useEffect(() => {
        if (!owner || !window.isSecureContext || useLoopbackState.getState().owner === owner) return;
        let settings: AgentLoopbackSettings | undefined;
        try {
            const draft = JSON.parse(localStorage.getItem(storageKey(owner)) || "null");
            if (typeof draft?.baseUrl === "string" && typeof draft.apiKey === "string" && typeof draft.model === "string" &&
                (draft.protocol === "responses" || draft.protocol === "chat")) {
                settings = {
                    baseUrl: normalizeAgentLoopbackUrl(draft.baseUrl),
                    apiKey: draft.apiKey,
                    model: draft.model,
                    protocol: draft.protocol,
                    imageModel: typeof draft.imageModel === "string" ? draft.imageModel : undefined,
                    useImageByDefault: draft.useImageByDefault !== false,
                };
            }
        } catch { /* Use global configuration if this browser's settings could not be read. */ }
        useLoopbackState.setState({ owner, settings });
    }, [owner]);
    return { owner, settings: state.owner === owner ? state.settings : undefined };
}
