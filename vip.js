
  /* 2026-10-04 */
/* BiliBili Cloudflare 网关代理脚本 - Egern 适配版 */

'use strict';

/* ============================================================
 * 常量 / 配置
 * ============================================================ */
const CONFIG = {
  name: 'BiliBili',
  gateway: '', // 从 ctx.env 读取，见 parseScriptArgument()
};

const BILI_UA_REGEX = /(?:^|\s)bili-universal\//i;
const NOT_SUPPORTED_MSG = '脚本仅支持国内粉色哔哩哔哩';
const MIN_DEVICE_BIN_LEN = 0xc;
const MAX_DEVICE_BIN_LEN = 0x8000;

const SUPPORTED_ENDPOINTS = new Set([
  'app.bilibili.com/bilibili.app.playerunite.v1.Player/PlayViewUnite',
  'app.bilibili.com/bilibili.app.playurl.v1.PlayURL/PlayView',
]);

const HTTP_STATUS_TEXT = {
  200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 408: 'Request Timeout', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const BASE64_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* ============================================================
 * 基础工具函数
 * ============================================================ */
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const isPlainObject = v =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function safeParseJSON(value, fallback = null) {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
}

function safeStringify(value, fallback = '') {
  try { return JSON.stringify(value); } catch { return fallback; }
}

/* 解析 query string → 普通对象 */
function parseQuery(input) {
  if (isPlainObject(input)) return { ...input };
  if (typeof input !== 'string' || !input.trim()) return {};
  const out = {};
  for (const pair of input.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const rawKey = idx >= 0 ? pair.slice(0, idx) : pair;
    const rawVal = idx >= 0 ? pair.slice(idx + 1) : '';
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal.replace(/^"|"$/g, ''));
    } catch {
      out[rawKey] = rawVal.replace(/^"|"$/g, '');
    }
  }
  return out;
}

function parseStatusCode(value, fallback = 0) {
  if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  const m = String(value ?? '').match(/(?:^|\s)([1-5]\d{2})(?:\s|$)/);
  return m ? Number(m[1]) : fallback;
}

/* 从 Headers 对象或普通对象中取 header */
function getHeader(headers, name) {
  // Egern 的 Headers 对象
  if (headers && typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const needle = String(name).toLowerCase();
  if (Array.isArray(headers)) {
    const hit = headers.find(h => String(h?.name ?? h?.field ?? '').toLowerCase() === needle);
    return hit == null ? '' : String(hit.value ?? '');
  }
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (String(k).toLowerCase() === needle) {
      return Array.isArray(v) ? v.join(', ') : String(v ?? '');
    }
  }
  return '';
}

function sanitizeHeaders(headers) {
  const out = {};
  const DROP = new Set(['content-length', 'transfer-encoding', 'connection', 'content-encoding']);
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (DROP.has(String(k).toLowerCase())) continue;
    if (v != null) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  if (!Object.keys(out).some(k => k.toLowerCase() === 'content-type')) {
    out['content-type'] = 'application/json; charset=utf-8';
  }
  return out;
}

/* ============================================================
 * 二进制 / Base64 工具
 * ============================================================ */
function toUint8Array(data) {
  if (data instanceof Uint8Array) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function bytesToBase64(bytes) {
  const view = toUint8Array(bytes);
  if (!view) throw new Error('参数不是合法的字节序列');
  let out = '';
  for (let i = 0; i < view.length; i += 3) {
    const b0 = view[i];
    const b1 = i + 1 < view.length ? view[i + 1] : 0;
    const b2 = i + 2 < view.length ? view[i + 2] : 0;
    out += BASE64_TABLE[b0 >> 2];
    out += BASE64_TABLE[((b0 & 0x3) << 4) | (b1 >> 4)];
    out += i + 1 < view.length ? BASE64_TABLE[((b1 & 0xf) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < view.length ? BASE64_TABLE[b2 & 0x3f] : '=';
  }
  return out;
}

function base64ToBytes(input) {
  if (typeof input !== 'string') throw new Error('CF 响应缺少 Base64 字符串');
  let s = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!s) return new Uint8Array();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('CF 返回的 Base64 包含无效字符');
  const noPad = s.replace(/=+$/, '');
  if (noPad.length % 4 === 1) throw new Error(`CF 返回的 Base64 长度不合法：${s.length}`);
  s = noPad.padEnd(Math.ceil(noPad.length / 4) * 4, '=');
  const bytes = [];
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    const c0 = BASE64_TABLE.indexOf(chunk[0]);
    const c1 = BASE64_TABLE.indexOf(chunk[1]);
    const c2 = chunk[2] === '=' ? 0 : BASE64_TABLE.indexOf(chunk[2]);
    const c3 = chunk[3] === '=' ? 0 : BASE64_TABLE.indexOf(chunk[3]);
    if (c0 < 0 || c1 < 0 || (chunk[2] !== '=' && c2 < 0) || (chunk[3] !== '=' && c3 < 0))
      throw new Error('CF 返回的 Base64 包含无效字符');
    bytes.push((c0 << 2) | (c1 >> 4));
    if (chunk[2] !== '=') bytes.push(((c1 & 0xf) << 4) | (c2 >> 2));
    if (chunk[3] !== '=') bytes.push(((c2 & 0x3) << 6) | c3);
  }
  return new Uint8Array(bytes);
}

function bytesToText(bytes) {
  const view = toUint8Array(bytes);
  if (!view) return '';
  if (typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder('utf-8').decode(view); } catch {}
  }
  let encoded = '';
  for (let i = 0; i < view.length; i++) encoded += '%' + view[i].toString(16).padStart(2, '0');
  try { return decodeURIComponent(encoded); } catch { return ''; }
}

function extractBodyText(res) {
  if (typeof res?.body === 'string') return res.body.replace(/^\uFEFF/, '');
  const bytes = toUint8Array(res?.bodyBytes) || toUint8Array(res?.body);
  return bytes ? bytesToText(bytes).replace(/^\uFEFF/, '') : '';
}

/* ============================================================
 * Egern 请求信息读取
 * ============================================================ */
async function readEgernRequestBody(ctx) {
  // Egern: ctx.request.body 是 ReadableStream，用 arrayBuffer() 读取
  if (!ctx?.request) return null;
  try {
    const buf = await ctx.request.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function buildEgernHeaders(headers) {
  // Egern Headers → 普通对象
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => { out[key] = value; });
  } else {
    for (const [k, v] of Object.entries(headers)) out[k] = v;
  }
  return out;
}

/* ============================================================
 * 脚本参数解析（从 ctx.env 读取）
 * ============================================================ */
function parseScriptArgument(ctx) {
  const env = ctx?.env ?? {};
  const policy = String(env.gateway || '').trim() || 'force-cache';
  const rawTimeout = Number(env.bl_timeout || 15000);
  const timeout = Number.isFinite(rawTimeout)
    ? Math.min(60000, Math.max(3000, Math.trunc(rawTimeout)))
    : 15000;
  const gateway = String(env.gateway_url || '').trim();
  return { policy, timeout, gateway };
}

/* ============================================================
 * CF 网关调用（使用 ctx.http）
 * ============================================================ */
async function callGateway(ctx, opts, uid, deviceBin, target, bodyBytes) {
  const res = await ctx.http.post(opts.gateway, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-bili-device-bin': deviceBin,
    },
    body: JSON.stringify({
      version: 1,
      uid,
      target,
      body: bytesToBase64(bodyBytes),
      bodyEncoding: 'base64',
    }),
    timeout: opts.timeout,
  });

  const resText = await res.text();
  const payload = safeParseJSON(resText, null);

  if (!isPlainObject(payload)) {
    throw new Error(`CF 响应不是有效的 JSON，HTTP ${res.status || 0}`);
  }

  if (!payload.ok || !isPlainObject(payload.body)) {
    const err = new Error(
      payload.message || payload.error || `CF 请求失败，HTTP ${res.status || 0}`
    );
    err.status = res.status;
    err.cfError = payload.error;
    err.retryAfter = payload.retryAfter;
    throw err;
  }

  const inner = payload.body;

  // 检查上游 gRPC 错误
  const grpcStatus = getHeader(inner.headers, 'grpc-status').trim();
  if (grpcStatus && grpcStatus !== '0') {
    const grpcMessage = getHeader(inner.headers, 'grpc-message').trim() || 'Unknown';
    throw new Error(`上游 gRPC 错误 ${grpcStatus}: ${grpcMessage}`);
  }

  if (inner.bodyEncoding !== 'base64') {
    throw new Error(`CF 返回了不支持的编码：${String(inner.bodyEncoding || '未知')}`);
  }

  const b64 = inner.body;
  const declaredLen = Number(res.responseBytes?.responseBytes ?? -1);

  if (declaredLen >= 0 && (!b64 || typeof b64 !== 'string')) {
    throw new Error(`CF 响应长度不一致：声明 ${declaredLen}，实际为空`);
  }

  const bytes = base64ToBytes(b64);
  if (declaredLen >= 0 && bytes.length !== declaredLen) {
    throw new Error(`CF 响应长度不一致：声明 ${declaredLen}，实际 ${bytes.length}`);
  }

  return {
    status: Number(inner.status || 200),
    headers: sanitizeHeaders(inner.headers),
    bodyBytes: bytes,
  };
}

/* ============================================================
 * 响应构造（Egern 风格：return 对象，body 直接放 Uint8Array）
 * ============================================================ */
function buildEgernResponse(result) {
  const bodyBytes = toUint8Array(result.bodyBytes);
  return {
    status: result.status,
    headers: result.headers,
    body: bodyBytes || '', // Egern 直接接受 Uint8Array 作为二进制 body
  };
}

function buildEgernError(err) {
  const message = String(err?.message || err);
  const code = parseStatusCode(err?.status, 502);
  const status = code >= 429 ? 429 : 502;
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: safeStringify({
      ok: false,
      error: err?.cfError || 'cf_gateway_failed',
      message,
      ...(Number.isFinite(Number(err?.retryAfter)) ? { retryAfter: Number(err.retryAfter) } : {}),
    }),
  };
}

/* ============================================================
 * 主流程（Egern 入口）
 * ============================================================ */
export default async function(ctx) {
  const envName = ctx?.app?.version ? 'Egern' : 'Unknown';

  try {
    if (envName === 'Unknown') throw new Error('不支持的运行环境');

    // 1. 读取请求信息
    const reqHeaders = ctx?.request?.headers;
    const reqUrl = ctx?.request?.url;
    const reqMethod = ctx?.request?.method || 'GET';

    // 2. UA 校验
    const ua = getHeader(reqHeaders, 'user-agent').trim();
    if (!BILI_UA_REGEX.test(ua)) {
      ctx?.log?.(`[BiliBili] ignored unsupported user-agent=${ua}`);
      return { status: 200, headers: {}, body: '' }; // 放行，不修改
    }

    // 3. 解析参数 & 网关配置
    const opts = parseScriptArgument(ctx);
    if (!opts.gateway) {
      throw new Error('请先在环境变量中配置 gateway_url');
    }
    if (!/^https:\/\//i.test(opts.gateway)) {
      throw new Error('gateway_url 必须以 https:// 开头');
    }

    // 4. 读取请求体（二进制）
    const bodyBytes = await readEgernRequestBody(ctx);
    if (!bodyBytes) throw new Error('无法读取请求体');

    // 5. 校验目标 URL
    const target = validateTargetUrl(reqUrl);

    // 6. 校验 UID / device-bin
    const uid = getHeader(reqHeaders, 'x-bili-uid').trim();
    if (!/^\d{1,20}$/.test(uid) || /^0+$/.test(uid)) {
      throw new Error('原请求缺少有效的 x-bili-uid');
    }

    const deviceBin = getHeader(reqHeaders, 'x-bili-device-bin').trim();
    if (deviceBin.length < MIN_DEVICE_BIN_LEN
      || deviceBin.length > MAX_DEVICE_BIN_LEN
      || /[\r\n]/.test(deviceBin)) {
      throw new Error('原请求缺少有效的 x-bili-device-bin');
    }

    ctx?.log?.(`[BiliBili] uid=${uid}, target=${target}, body=${bodyBytes.byteLength}`);

    // 7. 转发到 CF 网关
    const result = await callGateway(ctx, opts, uid, deviceBin, target, bodyBytes);

    ctx?.log?.(`[BiliBili] CF 返回 status=${result.status}, bytes=${result.bodyBytes.length}`);

    // 8. 返回响应（Egern 直接 return，二进制 body 放 body 字段）
    return buildEgernResponse(result);

  } catch (err) {
    return buildEgernError(err);
  }
}

/* 校验 URL 是否属于受支持的接口 */
function validateTargetUrl(url) {
  const m = String(url ?? '').match(/^https:\/\/([^/?#]+)(\/[^?#]*)/i);
  if (!m) throw new Error('无效的请求 URL');
  const key = `${m[1].toLowerCase()}${m[2]}`;
  if (!SUPPORTED_ENDPOINTS.has(key)) throw new Error('不支持的 B 站接口');
  return key;
}