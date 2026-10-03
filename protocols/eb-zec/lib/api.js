const http = require("node:http");
const { ensure, ProtocolError, canonical, b64, hash, bytes } = require("./crypto");
const { decodeMemo } = require("./memo");
const { renderSvg, metadata, rendererId } = require("./renderer");
const { signingMaterial } = require("./client");
const { roundWindow } = require("./profile");

function createApi(indexer) {
  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'none'; frame-ancestors 'none'");
    function send(status, value, type = "application/json; charset=utf-8") {
      response.writeHead(status, { "Content-Type": type });
      response.end(type.startsWith("application/json") ? canonical(value) : value);
    }
    try {
      const host = request.headers.host || "";
      ensure(/^(?:127\.0\.0\.1|localhost):\d+$/.test(host), "INVALID_LOCAL_HOST");
      if (request.headers.origin) ensure(new URL(request.headers.origin).host === host, "CROSS_ORIGIN_FORBIDDEN");
      ensure(request.url.length <= 512, "URL_TOO_LONG");
      const url = new URL(request.url, `http://${host}`);
      ensure(!url.search, "UNSUPPORTED_QUERY");
      const route = url.pathname;
      if (request.method === "POST") {
        ensure(["/v1/validate/memo", "/v1/prepare/message", "/v1/render/verify"].includes(route), "NOT_FOUND");
        ensure(request.headers["content-type"]?.split(";")[0] === "application/json", "JSON_REQUIRED");
        if (request.headers["content-length"]) {
          ensure(/^\d+$/.test(request.headers["content-length"]) && Number(request.headers["content-length"]) <= 16384,
            "BODY_TOO_LARGE");
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          ensure(size <= 16384, "BODY_TOO_LARGE");
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new ProtocolError("INVALID_JSON"); }
        if (route === "/v1/validate/memo") {
          ensure(body && Object.keys(body).length === 1 && typeof body.memo_hex === "string", "INVALID_BODY");
          const message = decodeMemo(body.memo_hex);
          return send(200, { envelope_valid: true, signature_valid: true, message,
            state_authorized: false, broadcast_supported: false });
        }
        if (route === "/v1/prepare/message") {
          ensure(body && Object.keys(body).length === 1 && Object.hasOwn(body, "message"), "INVALID_BODY");
          ensure(body.message.world === indexer.manifest.world_id, "WRONG_WORLD");
          return send(200, signingMaterial(body.message));
        }
        ensure(body && Object.keys(body).sort().join(",") === "being_id,svg_hash", "INVALID_BODY");
        const being = indexer.state.beings[body.being_id];
        ensure(being, "NOT_FOUND"); bytes(body.svg_hash, 32);
        const svgHash = b64(hash(renderSvg(being)));
        return send(200, { matches: svgHash === body.svg_hash, svg_hash: svgHash, renderer_id: rendererId() });
      }
      ensure(request.method === "GET", "METHOD_NOT_ALLOWED");
      if (route === "/" || route === "/v1/network") {
        const snapshot = indexer.snapshot();
        return send(200, { protocol: snapshot.protocol, version: snapshot.version, network: snapshot.network,
          observed_height: snapshot.observed_height, finalized_height: snapshot.finalized_height,
          confirmation_depth: snapshot.confirmation_depth, root: snapshot.root,
          live_zcash_scanner: false, broadcast_supported: false, native_asset: false,
          world_url: `/v1/worlds/${indexer.manifest.world_id}`, beings_url: "/v1/beings" });
      }
      if (route === `/v1/worlds/${indexer.manifest.world_id}`) {
        return send(200, { manifest: indexer.manifest, minted_total: indexer.state.minted_total,
          live_supply: indexer.state.live_supply, consumed_total: indexer.state.consumed_total,
          issued_resource_units: indexer.state.issued_resource_units, resource_kind: "application-ledger-only" });
      }
      if (route === "/v1/beings") {
        return send(200, Object.values(indexer.state.beings).sort((a, b) => Buffer.compare(bytes(a.being_id, 32), bytes(b.being_id, 32)))
          .map((being) => ({ ...being, render_url: `/v1/beings/${being.being_id}/render.svg`,
            metadata_url: `/v1/beings/${being.being_id}/metadata.json` })));
      }
      const beingRoute = route.match(/^\/v1\/beings\/([A-Za-z0-9_-]{43})(?:\/(render\.svg|metadata\.json|history))?$/);
      if (beingRoute) {
        const being = indexer.state.beings[beingRoute[1]];
        ensure(being, "NOT_FOUND");
        if (beingRoute[2] === "render.svg") return send(200, renderSvg(being), "image/svg+xml; charset=utf-8");
        if (beingRoute[2] === "metadata.json") return send(200, metadata(being));
        if (beingRoute[2] === "history") return send(200, indexer.state.histories[being.being_id]);
        return send(200, { being, observed_height: indexer.observedHeight, finalized_height: indexer.finalizedHeight,
          finality_status: "application-confirmed" });
      }
      const roundRoute = route.match(/^\/v1\/mint\/rounds\/(current|\d{1,10})$/);
      if (roundRoute) {
        const length = indexer.manifest.commit_blocks + indexer.manifest.beacon_delay_blocks + indexer.manifest.reveal_blocks;
        const current = Math.max(0, Math.floor((indexer.observedHeight - indexer.manifest.genesis_height - 1) / length));
        const id = roundRoute[1] === "current" ? current : Number(roundRoute[1]);
        roundWindow(indexer.manifest, id);
        return send(200, indexer.round(id));
      }
      const eventRoute = route.match(/^\/v1\/events\/([0-9a-f]{64})\/(\d{1,10})$/);
      if (eventRoute) {
        const key = `${eventRoute[1]}/${Number(eventRoute[2])}`;
        const record = indexer.state.journal[key];
        if (record) return send(200, { ...record, confirmations: indexer.observedHeight - record.height + 1,
          finality_status: "application-confirmed" });
        for (const block of indexer.chain.filter((item) => item.height > indexer.finalizedHeight)) {
          const tx = block.transactions.find((item) => item.txid === eventRoute[1]);
          if (tx?.outputs.some((item) => item.index === Number(eventRoute[2]) && item.recipient === indexer.manifest.protocol_ua)) {
            return send(200, { status: "provisional", confirmations: indexer.observedHeight - block.height + 1,
              finality_status: "not-applied" });
          }
        }
      }
      const checkpoint = route.match(/^\/v1\/checkpoints\/(\d{1,10})$/);
      if (checkpoint && indexer.checkpoints[Number(checkpoint[1])]) return send(200, indexer.checkpoints[Number(checkpoint[1])]);
      if (route === `/v1/renderers/${rendererId()}`) return send(200, { renderer_id: rendererId(), version: "0.1.0",
        source: "protocols/eb-zec/lib/renderer.js", format: "canonical-static-svg" });
      throw new ProtocolError("NOT_FOUND");
    } catch (error) {
      const code = error.code || "INVALID_REQUEST";
      const status = code === "NOT_FOUND" ? 404 : code === "METHOD_NOT_ALLOWED" ? 405 : code === "BODY_TOO_LARGE" ? 413 : 400;
      if (!response.headersSent) send(status, { error: code });
      else response.destroy();
    }
  });
}

module.exports = { createApi };
