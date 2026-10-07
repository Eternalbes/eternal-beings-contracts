const http = require("node:http");
const https = require("node:https");
const { ensure, ProtocolError } = require("../lib/crypto");

const HEX32 = /^[0-9a-f]{64}$/;
const address = (value) => typeof value === "string" && /^[A-Za-z0-9]{1,512}$/.test(value);
const height = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const PARAMS = Object.freeze({
  getblockchaininfo: (p) => p.length === 0,
  getblockhash: (p) => p.length === 1 && height(p[0]),
  getblock: (p) => p.length === 2 && typeof p[0] === "string" && HEX32.test(p[0]) && p[1] === 1,
  getrawtransaction: (p) => p.length === 3 && typeof p[0] === "string" && HEX32.test(p[0]) && p[1] === 1 &&
    typeof p[2] === "string" && HEX32.test(p[2]),
  z_listunifiedreceivers: (p) => p.length === 1 && address(p[0]),
  z_listreceivedbyaddress: (p) => p.length === 3 && address(p[0]) && p[1] === 1 && height(p[2]),
});

class ReadonlyRpc {
  #url;
  #authorization;
  #sequence = 0;
  #timeout;
  #maximum;

  constructor({ url, username = "", password = "", timeoutMs = 10000, maxResponseBytes = 32 * 1024 * 1024 }) {
    try { this.#url = new URL(url); } catch { throw new ProtocolError("INVALID_RPC_URL"); }
    ensure(["http:", "https:"].includes(this.#url.protocol) &&
      ["127.0.0.1", "[::1]"].includes(this.#url.hostname) &&
      !this.#url.username && !this.#url.password && !this.#url.search && !this.#url.hash &&
      this.#url.pathname === "/", "LOCAL_RPC_ONLY");
    ensure(typeof username === "string" && typeof password === "string" &&
      username.length <= 256 && password.length <= 1024 && !/[:\r\n]/.test(username) &&
      !/[\r\n]/.test(password) && Boolean(username) === Boolean(password), "INVALID_RPC_AUTH");
    ensure(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 60000 &&
      Number.isInteger(maxResponseBytes) && maxResponseBytes >= 64 && maxResponseBytes <= 32 * 1024 * 1024,
    "INVALID_RPC_LIMIT");
    this.#authorization = username ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : null;
    this.#timeout = timeoutMs;
    this.#maximum = maxResponseBytes;
  }

  async call(method, params = []) {
    ensure(Object.hasOwn(PARAMS, method), "RPC_METHOD_FORBIDDEN");
    ensure(Array.isArray(params) && PARAMS[method](params), "INVALID_RPC_PARAMS");
    const id = ++this.#sequence;
    const body = JSON.stringify({ jsonrpc: "1.0", id, method, params });
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const transport = this.#url.protocol === "https:" ? https : http;
      const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
      if (this.#authorization) headers.Authorization = this.#authorization;
      const request = transport.request(this.#url, { method: "POST", headers, agent: false }, (response) => {
        // Never follow redirects or print a node-supplied error body containing credentials.
        if (response.statusCode !== 200) {
          finish(new ProtocolError("RPC_HTTP_ERROR"));
          response.destroy();
          return;
        }
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > this.#maximum) {
            finish(new ProtocolError("RPC_RESPONSE_TOO_LARGE"));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on("error", () => finish(new ProtocolError("RPC_CONNECTION_FAILED")));
        response.on("aborted", () => finish(new ProtocolError("RPC_CONNECTION_FAILED")));
        response.on("end", () => {
          if (done) return;
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
            const message = JSON.parse(text);
            ensure(message && !Array.isArray(message) && message.id === id &&
              Object.hasOwn(message, "result") && Object.hasOwn(message, "error"), "INVALID_RPC_RESPONSE");
            if (message.error !== null) {
              const error = new ProtocolError("RPC_REMOTE_ERROR");
              if (Number.isSafeInteger(message.error?.code)) error.rpcCode = message.error.code;
              throw error;
            }
            finish(null, message.result);
          } catch (error) {
            finish(error instanceof ProtocolError ? error : new ProtocolError("INVALID_RPC_RESPONSE"));
          }
        });
      });
      const timer = setTimeout(() => {
        finish(new ProtocolError("RPC_TIMEOUT"));
        request.destroy();
      }, this.#timeout);
      request.on("error", () => finish(new ProtocolError("RPC_CONNECTION_FAILED")));
      request.end(body);
    });
  }
}

module.exports = { ReadonlyRpc };
