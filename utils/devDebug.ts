export interface DevDebugFlags {
    skipPromptBuild: boolean;
    skipEmotionEval: boolean;
    captureLlmLog: boolean;
}

export interface DevDebugLlmLogEntry {
    id: string;
    timestamp: string;
    url: string;
    method?: string;
    status?: number;
    request?: unknown;
    response?: unknown;
    error?: {
        name?: string;
        message: string;
    };
}

export interface DevDebugFloatingPosition {
    x: number;
    y: number;
}

export const DEV_DEBUG_STORAGE_KEY = 'sullyos.devDebug.flags.v1';
export const DEV_DEBUG_EVENT = 'sullyos-dev-debug-change';
export const DEV_DEBUG_LLM_LOG_STORAGE_KEY = 'sullyos.devDebug.llmLog.v1';
export const DEV_DEBUG_LLM_LOG_EVENT = 'sullyos-dev-debug-llm-log-change';
export const DEV_DEBUG_POSITION_STORAGE_KEY = 'sullyos.devDebug.position.v1';

export const DEFAULT_DEV_DEBUG_FLAGS: DevDebugFlags = {
    skipPromptBuild: false,
    skipEmotionEval: false,
    captureLlmLog: false,
};

const MAX_LLM_LOG_ENTRIES = 20;
const MAX_LLM_LOG_STORAGE_CHARS = 2_000_000;
const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|bearer|token|secret|endpoint|p256dh|auth)$/i;
let memoryLlmLog: DevDebugLlmLogEntry[] | null = null;

function normalizeStorageKeyPart(value: string): string {
    return value.trim().replace(/[^a-z0-9._-]+/gi, '_') || 'unknown';
}

function getBuildBranch(): string {
    return typeof __BUILD_BRANCH__ !== 'undefined' ? __BUILD_BRANCH__ : 'unknown';
}

function getScopedStorageKey(baseKey: string): string {
    return `${baseKey}.${normalizeStorageKeyPart(getBuildBranch())}`;
}

function canUseDevDebugStorage(): boolean {
    return isDevDebugAvailable() && typeof window !== 'undefined';
}

function normalizeFlags(value: unknown): DevDebugFlags {
    const source = (value && typeof value === 'object') ? value as Partial<DevDebugFlags> : {};
    return {
        skipPromptBuild: source.skipPromptBuild === true,
        skipEmotionEval: source.skipEmotionEval === true,
        captureLlmLog: source.captureLlmLog === true,
    };
}

function normalizePosition(value: unknown): DevDebugFloatingPosition | null {
    const source = (value && typeof value === 'object') ? value as Partial<DevDebugFloatingPosition> : null;
    if (!source || !Number.isFinite(source.x) || !Number.isFinite(source.y)) return null;
    return {
        x: Math.round(Number(source.x)),
        y: Math.round(Number(source.y)),
    };
}

export function isDevDebugAvailable(): boolean {
    return typeof __BUILD_BADGE_VISIBLE__ !== 'undefined' && __BUILD_BADGE_VISIBLE__;
}

export function readDevDebugFlags(): DevDebugFlags {
    if (!canUseDevDebugStorage()) return DEFAULT_DEV_DEBUG_FLAGS;

    try {
        const raw = window.localStorage.getItem(getScopedStorageKey(DEV_DEBUG_STORAGE_KEY));
        if (!raw) return DEFAULT_DEV_DEBUG_FLAGS;
        return normalizeFlags(JSON.parse(raw));
    } catch {
        return DEFAULT_DEV_DEBUG_FLAGS;
    }
}

export function writeDevDebugFlags(flags: DevDebugFlags): DevDebugFlags {
    const next = normalizeFlags(flags);
    if (!canUseDevDebugStorage()) return next;
    const prev = readDevDebugFlags();

    try {
        window.localStorage.setItem(getScopedStorageKey(DEV_DEBUG_STORAGE_KEY), JSON.stringify(next));
    } catch {
        // localStorage can be blocked in private / embedded contexts; the UI still keeps local state.
    }

    if (prev.captureLlmLog && !next.captureLlmLog) {
        clearDevDebugLlmLog();
    }

    window.dispatchEvent(new CustomEvent<DevDebugFlags>(DEV_DEBUG_EVENT, { detail: next }));
    return next;
}

export function readDevDebugPosition(): DevDebugFloatingPosition | null {
    if (!canUseDevDebugStorage()) return null;

    try {
        const raw = window.localStorage.getItem(getScopedStorageKey(DEV_DEBUG_POSITION_STORAGE_KEY));
        if (!raw) return null;
        return normalizePosition(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function writeDevDebugPosition(position: DevDebugFloatingPosition): void {
    if (!canUseDevDebugStorage()) return;

    const next = normalizePosition(position);
    if (!next) return;

    try {
        window.localStorage.setItem(getScopedStorageKey(DEV_DEBUG_POSITION_STORAGE_KEY), JSON.stringify(next));
    } catch {
        // localStorage can be blocked in private / embedded contexts; dragging still works in memory.
    }
}

export function updateDevDebugFlags(updater: (flags: DevDebugFlags) => DevDebugFlags): DevDebugFlags {
    return writeDevDebugFlags(updater(readDevDebugFlags()));
}

export function subscribeDevDebugFlags(listener: (flags: DevDebugFlags) => void): () => void {
    if (typeof window === 'undefined') return () => {};

    const storageKey = getScopedStorageKey(DEV_DEBUG_STORAGE_KEY);
    const onChange = (event: Event) => {
        const detail = (event as CustomEvent<DevDebugFlags>).detail;
        listener(detail ? normalizeFlags(detail) : readDevDebugFlags());
    };
    const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey) listener(readDevDebugFlags());
    };

    window.addEventListener(DEV_DEBUG_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(DEV_DEBUG_EVENT, onChange);
        window.removeEventListener('storage', onStorage);
    };
}

export function isPromptBuildSkipped(): boolean {
    return readDevDebugFlags().skipPromptBuild;
}

export function isEmotionEvalSkipped(): boolean {
    return readDevDebugFlags().skipEmotionEval;
}

export function isLlmLogCaptureEnabled(): boolean {
    return readDevDebugFlags().captureLlmLog;
}

function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (!value || typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(key)) {
            out[key] = '<redacted>';
        } else {
            out[key] = redactSecrets(item);
        }
    }
    return out;
}

function safeJsonValue(value: unknown): unknown {
    try {
        return redactSecrets(JSON.parse(JSON.stringify(value)));
    } catch {
        return String(value);
    }
}

function parseRequestBody(body: unknown): unknown {
    if (body === undefined || body === null) return undefined;
    if (typeof body !== 'string') return body;
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}

function readPersistedLlmLog(): DevDebugLlmLogEntry[] {
    if (memoryLlmLog) return memoryLlmLog;
    if (!canUseDevDebugStorage()) {
        memoryLlmLog = [];
        return memoryLlmLog;
    }
    try {
        const raw = window.localStorage.getItem(getScopedStorageKey(DEV_DEBUG_LLM_LOG_STORAGE_KEY));
        const parsed = raw ? JSON.parse(raw) : [];
        memoryLlmLog = Array.isArray(parsed) ? parsed : [];
    } catch {
        memoryLlmLog = [];
    }
    return memoryLlmLog;
}

function emitLlmLogChange(entries: DevDebugLlmLogEntry[]): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<DevDebugLlmLogEntry[]>(DEV_DEBUG_LLM_LOG_EVENT, { detail: entries }));
}

function persistLlmLog(entries: DevDebugLlmLogEntry[]): void {
    memoryLlmLog = entries;
    if (canUseDevDebugStorage()) {
        try {
            window.localStorage.setItem(getScopedStorageKey(DEV_DEBUG_LLM_LOG_STORAGE_KEY), JSON.stringify(entries));
        } catch {
            // Keep the in-memory log even when localStorage is full or blocked.
        }
    }
    emitLlmLogChange(entries);
}

export function readDevDebugLlmLog(): DevDebugLlmLogEntry[] {
    return [...readPersistedLlmLog()];
}

export function clearDevDebugLlmLog(): void {
    memoryLlmLog = [];
    if (canUseDevDebugStorage()) {
        try {
            window.localStorage.removeItem(getScopedStorageKey(DEV_DEBUG_LLM_LOG_STORAGE_KEY));
        } catch {
            // ignore
        }
    }
    emitLlmLogChange([]);
}

export function appendDevDebugLlmLog(input: {
    url: string;
    method?: string;
    status?: number;
    requestBody?: unknown;
    response?: unknown;
    error?: unknown;
}): void {
    if (!isLlmLogCaptureEnabled()) return;

    const entry: DevDebugLlmLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        url: input.url,
        method: input.method,
        status: input.status,
        request: safeJsonValue(parseRequestBody(input.requestBody)),
        response: input.response === undefined ? undefined : safeJsonValue(input.response),
        error: input.error
            ? {
                name: (input.error as any)?.name,
                message: (input.error as any)?.message || String(input.error),
            }
            : undefined,
    };

    const next = [...readPersistedLlmLog(), entry].slice(-MAX_LLM_LOG_ENTRIES);
    while (next.length > 1 && JSON.stringify(next).length > MAX_LLM_LOG_STORAGE_CHARS) {
        next.shift();
    }
    persistLlmLog(next);
}

export function formatDevDebugLlmLog(): string {
    const entries = readDevDebugLlmLog();
    if (entries.length === 0) return '';
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        build: {
            branch: typeof __BUILD_BRANCH__ !== 'undefined' ? __BUILD_BRANCH__ : 'unknown',
            commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'unknown',
        },
        entries,
    }, null, 2);
}

export function subscribeDevDebugLlmLog(listener: (entries: DevDebugLlmLogEntry[]) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const onChange = (event: Event) => {
        const detail = (event as CustomEvent<DevDebugLlmLogEntry[]>).detail;
        listener(Array.isArray(detail) ? [...detail] : readDevDebugLlmLog());
    };
    window.addEventListener(DEV_DEBUG_LLM_LOG_EVENT, onChange);
    return () => window.removeEventListener(DEV_DEBUG_LLM_LOG_EVENT, onChange);
}
