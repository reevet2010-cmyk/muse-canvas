#!/usr/bin/env node
import express from "express";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodexClient } from "./codex.mjs";

const entry = fileURLToPath(import.meta.url);
const configPath = resolve(homedir(), ".infinite-canvas", "codex-agent.json");
const readConfig = () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null;
const savedConfig = readConfig();
const serviceId = savedConfig?.serviceId || randomUUID();
const mode = process.argv[2];
if (!savedConfig && ["config", "open"].includes(mode)) throw new Error("请先启动本地 Canvas Agent 服务");
const token = process.env.CANVAS_AGENT_TOKEN || savedConfig?.token || (mode === "mcp" ? "" : randomBytes(32).toString("hex"));
if (mode !== "mcp" && (typeof token !== "string" || token.length < 32)) throw new Error("本地连接 Token 至少需要 32 位字符");
const port = Number(process.env.CANVAS_AGENT_PORT || savedConfig?.port || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("本地服务端口无效");
const endpoint = "http://127.0.0.1:" + port;
const workspace = dirname(entry);
const origins = new Set(process.env.CANVAS_AGENT_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) || savedConfig?.origins || []);
const sessions = new Map();
const methods = new Set(["model/list", "thread/start", "thread/resume", "thread/archive", "turn/start", "turn/interrupt", "bridge/stop"]);

async function openCanvas(address, browser, pairingToken, browserArgs = []) {
    const target = URL.canParse(address || "") ? new URL(address) : null;
    if (!target || !["http:", "https:"].includes(target.protocol) || target.username || target.password || !/^\/canvas\/[^/]+\/?$/.test(target.pathname)) throw new Error("请提供实际画布的 HTTP(S) 地址");
    if (!["chrome", "edge", "firefox", "brave", "default"].includes(browser)) throw new Error("请指定原画布浏览器：chrome、edge、firefox、brave 或 default");
    const params = new URLSearchParams(target.hash.slice(1));
    params.set("agentUrl", endpoint);
    params.set("agentToken", pairingToken);
    target.hash = params.toString();
    const { default: open, apps } = await import("open");
    try {
        await open(target.href, browser === "default" ? {} : { app: { name: apps[browser], arguments: browserArgs } });
    } catch (error) {
        throw new Error("打开浏览器失败，请检查原浏览器、配置和启动权限" + (error.code ? "：" + error.code : ""));
    }
}

async function pairTrustedCanvas(address) {
    const target = new URL(address);
    if (target.protocol !== "https:" || target.origin !== process.env.CANVAS_AGENT_SITE || target.username || target.password || target.search || target.hash || !/^\/canvas\/[\w-]+\/?$/.test(target.pathname)) {
        throw new Error("请从已配置的 HTTPS 画布站点复制 /canvas/项目ID 地址");
    }
    const check = async () => {
        const response = await fetch(endpoint + "/config", { signal: AbortSignal.timeout(1500), redirect: "error" });
        const info = await response.json();
        const local = readConfig();
        if (!response.ok || !local?.token || !local.serviceId || info.serviceId !== local.serviceId) throw new Error("本机端口已被其他服务使用");
        return local.token;
    };
    let pairingToken;
    try { pairingToken = await check(); }
    catch (error) {
        if (error.cause?.code !== "ECONNREFUSED") throw error;
        const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            try { pairingToken = await check(); break; }
            catch (e) { if (e.cause?.code !== "ECONNREFUSED") throw e; }
        }
        if (!pairingToken) throw new Error("本地 Canvas Agent 未能启动");
    }
    await openCanvas(target.href, process.env.CANVAS_AGENT_BROWSER || "default", pairingToken);
    return target.pathname.split("/")[2];
}

function saveConfig() {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ url: endpoint, port, token, serviceId, origins: [...origins] }, null, 2) + "\n", { mode: 0o600 });
}

function findSession(clientId, canvasId) {
    if (!clientId) {
        const connected = [...sessions.values()].filter((session) => session.events && session.canvasId && (!canvasId || session.canvasId === canvasId));
        if (connected.length !== 1) throw new Error("请只连接一个画布，或为 MCP 设置 CANVAS_AGENT_CLIENT_ID");
        return connected[0];
    }
    const session = sessions.get(clientId);
    if (!session) throw new Error("画布尚未连接");
    return session;
}

function emit(session, event, data) {
    session.events?.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

function closeSession(session) {
    if (sessions.get(session.clientId) === session) sessions.delete(session.clientId);
    for (const pending of session.toolsPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("画布已断开，工具未完成"));
    }
    session.toolsPending.clear();
    const events = session.events;
    session.events = undefined;
    session.codex?.close();
    events?.end();
}

function callTool(session, name, args, source, generation, res) {
    if (!session.events || !session.tools.some((tool) => tool.name === name)) throw new Error("画布未连接或工具不存在");
    if (source === "codex" && (generation !== session.codexGeneration || !session.codex || session.codex.stopped)) throw new Error("Codex 请求已停止");
    if (res.destroyed) throw new Error("画布工具请求已取消");
    const requestId = randomUUID();
    const cancel = (message) => {
        const pending = session.toolsPending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        session.toolsPending.delete(requestId);
        emit(session, "tool-cancel", { requestId });
        pending.reject(new Error(message));
    };
    const onClose = () => { if (!res.writableEnded) cancel("画布工具请求已取消"); };
    res.once("close", onClose);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => cancel("画布工具执行超时"), 90000);
        session.toolsPending.set(requestId, { resolve, reject, timer, source, cancel });
        emit(session, "tool", { requestId, name, arguments: args, source, generation });
    }).finally(() => res.off("close", onClose));
}

async function runRpc(session, method, params = {}, generation) {
    if (!methods.has(method)) throw new Error("不支持的 Codex 方法");
    if (!session.events || !session.canvasId) throw new Error("请先连接画布并注册工具");
    if (!Number.isSafeInteger(generation) || generation < session.codexGeneration) throw new Error("Codex 请求已停止");
    if (generation > session.codexGeneration) {
        session.codexGeneration = generation;
        session.codex?.close();
    }
    if (method === "bridge/stop") return { ok: true };
    if (!session.codex || session.codex.stopped) session.codex = new CodexClient((event, data) => {
        if (data.method === "bridge/disconnected") {
            if (generation === session.codexGeneration) session.codexGeneration += 1;
            for (const pending of session.toolsPending.values()) if (pending.source === "codex") pending.cancel("Codex 请求已停止");
        }
        emit(session, event, { ...data, generation });
    });
    const codex = session.codex;
    await codex.ready;
    if (method === "thread/start" || method === "thread/resume") {
        params = {
            ...params,
            cwd: workspace,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            config: { mcp_servers: { "infinite-canvas": {
                command: process.execPath,
                args: [entry, "mcp"],
                default_tools_approval_mode: "approve",
                env: { CANVAS_AGENT_TOKEN: token, CANVAS_AGENT_PORT: String(port), CANVAS_AGENT_CLIENT_ID: session.clientId, CANVAS_AGENT_SOURCE: "codex", CANVAS_AGENT_CODEX_GENERATION: String(generation) },
                startup_timeout_sec: 20,
                tool_timeout_sec: 90,
            } } },
        };
    }
    if (method === "turn/start") {
        params = { ...params, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } };
    }
    return codex.request(method, params);
}

async function startMcp() {
    const clientId = process.env.CANVAS_AGENT_CLIENT_ID || "";
    let targetCanvasId = "";
    const source = process.env.CANVAS_AGENT_SOURCE === "codex" ? "codex" : "external";
    const generation = Number(process.env.CANVAS_AGENT_CODEX_GENERATION || 0);
    async function request(path, body, signal) {
        const config = readConfig();
        const requestToken = process.env.CANVAS_AGENT_TOKEN || config?.token;
        if (!requestToken) throw new Error("请先启动本地 Canvas Agent 服务");
        const url = "http://127.0.0.1:" + (process.env.CANVAS_AGENT_PORT || config?.port || 3210);
        const response = await fetch(url + path, {
            method: body ? "POST" : "GET",
            headers: { "Content-Type": "application/json", "x-canvas-agent-token": requestToken },
            body: body ? JSON.stringify({ ...body, clientId, canvasId: targetCanvasId, source, generation }) : undefined,
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(95000)]) : AbortSignal.timeout(95000),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "画布连接失败");
        return value;
    }
    const server = new Server({ name: "infinite-canvas", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });
    const toolsPath = () => "/tools?" + new URLSearchParams({ clientId, canvasId: targetCanvasId });
    const pairingTools = source === "external" && process.env.CANVAS_AGENT_SITE ? [{
        name: "open_canvas", description: "在本机浏览器打开用户指定的画布并配对。使用已配置站点的 HTTPS /canvas/项目ID 链接。",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    }] : [];
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        try {
            const tools = await request(toolsPath());
            return { tools: [...pairingTools, ...(source === "codex" ? tools : tools.filter(({ name }) => !["open_canvas", "set_agent_state", "read_skill_file"].includes(name)))] };
        } catch { return { tools: pairingTools }; }
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
        try {
            if (params.name === "open_canvas" && pairingTools.length) {
                targetCanvasId = await pairTrustedCanvas(params.arguments?.url);
                clearTimeout(retry);
                void announceTools();
                return { content: [{ type: "text", text: "已打开画布。若浏览器询问，允许访问本地网络；画布工具将在连接成功后可用。" }] };
            }
            const result = await request("/tools/call", { name: params.name, arguments: params.arguments || {} }, signal);
            return { isError: result?.ok === false, content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
            return { isError: true, content: [{ type: "text", text: error.message }] };
        }
    });
    let retry;
    let closed = false;
    async function announceTools() {
        try {
            const tools = await request(toolsPath());
            if (!tools.length) throw new Error("等待画布连接");
            if (!closed) await server.notification({ method: "notifications/tools/list_changed" });
        } catch {
            if (!closed) retry = setTimeout(announceTools, 2000);
        }
    }
    server.oninitialized = () => { void announceTools(); };
    server.onclose = () => { closed = true; clearTimeout(retry); };
    await server.connect(new StdioServerTransport());
}

function startHttp() {
    const app = express();
    app.use((req, res, next) => {
        if (!["127.0.0.1:" + port, "localhost:" + port].includes(req.headers.host)) return res.status(403).json({ error: "无效的本地地址" });
        const origin = req.headers.origin;
        if (origin && process.env.CANVAS_AGENT_SITE && origin !== process.env.CANVAS_AGENT_SITE) return res.sendStatus(403);
        if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-canvas-agent-token");
            res.setHeader("Access-Control-Expose-Headers", "x-canvas-agent-generation");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Private-Network", "true");
        }
        if (req.method === "OPTIONS") return res.sendStatus(204);
        if (req.method === "GET" && req.path === "/config") return res.json({ url: endpoint, hasToken: Boolean(token), serviceId });
        const credential = req.path === "/events" ? req.query.token : req.headers["x-canvas-agent-token"];
        if (credential !== token) return res.status(401).json({ error: "Token 不正确" });
        if (origin && !origins.has(origin)) {
            origins.add(origin);
            saveConfig();
        }
        next();
    });
    app.use(express.json({ limit: "20mb" }));
    app.post("/connect", (req, res) => {
        const { clientId, canvasId, tools } = req.body;
        if (typeof clientId !== "string" || !clientId || typeof canvasId !== "string" || !canvasId || !Array.isArray(tools)) {
            return res.status(400).json({ error: "连接参数不完整" });
        }
        const session = findSession(clientId);
        if ((session.canvasId && session.canvasId !== canvasId) || session.origin !== req.headers.origin) {
            return res.status(409).json({ error: "连接标识已被其他画布使用" });
        }
        session.canvasId = canvasId;
        session.tools = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
        res.json({ serviceId });
    });
    app.get("/events", (req, res) => {
        const clientId = req.query.clientId;
        if (typeof clientId !== "string" || !clientId) return res.status(400).json({ error: "缺少连接标识" });
        let session = sessions.get(clientId);
        if (!session) {
            session = { clientId, origin: req.headers.origin, tools: [], toolsPending: new Map(), codexGeneration: 0 };
            sessions.set(clientId, session);
        }
        if (session.origin !== req.headers.origin) return res.status(403).json({ error: "连接来源不匹配" });
        const previous = session.events;
        session.events = res;
        previous?.end();
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        res.write(": connected\n\n");
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
        res.on("close", () => {
            clearInterval(heartbeat);
            if (session.events === res) closeSession(session);
        });
    });
    app.post("/rpc", async (req, res) => {
        const { clientId, method, params, generation } = req.body;
        const session = findSession(clientId);
        res.json(await runRpc(session, method, params, generation).finally(() => res.setHeader("x-canvas-agent-generation", String(session.codexGeneration))));
    });
    app.post("/reply", (req, res) => {
        const { clientId, id, result, error, generation } = req.body;
        const session = findSession(clientId);
        if (generation === session.codexGeneration) session.codex?.reply(id, result, error);
        res.json({ ok: true });
    });
    app.post("/result", (req, res) => {
        const { clientId, requestId, result, error } = req.body;
        const session = findSession(clientId);
        const pending = session.toolsPending.get(requestId);
        if (!pending) return res.status(409).json({ error: "工具请求已结束" });
        clearTimeout(pending.timer);
        session.toolsPending.delete(requestId);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
        res.json({ ok: true });
    });
    app.get("/tools", (req, res) => {
        const session = findSession(req.query.clientId, req.query.canvasId);
        if (!session.canvasId) throw new Error("请先在网页连接画布");
        res.json(session.tools);
    });
    app.post("/tools/call", async (req, res) => {
        const { clientId, name, arguments: args, source, generation } = req.body;
        res.json(await callTool(findSession(clientId, req.body.canvasId), name, args, source === "codex" ? "codex" : "external", generation, res));
    });
    app.use((error, req, res, next) => {
        if (res.destroyed) return;
        if (res.headersSent) return next(error);
        res.status(400).json({ error: error.message });
    });
    const server = app.listen(port, "127.0.0.1", () => {
        saveConfig();
        console.log("Local URL: " + endpoint);
        console.log("Connect token: " + token);
    });
    server.on("error", (error) => {
        console.error("Canvas Agent 启动失败：" + error.message);
        process.exitCode = 1;
    });
    function shutdown() {
        for (const session of sessions.values()) closeSession(session);
        server.close();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

if (mode === "config") console.log(JSON.stringify({ url: endpoint, token, origins: [...origins] }));
else if (mode === "open") { await openCanvas(process.argv[3], process.argv[4], token, process.argv.slice(5)); console.log("已请求浏览器打开画布"); }
else if (mode === "mcp") await startMcp();
else startHttp();
