import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { inflateRawSync } from "node:zlib";

const root = new URL(".", import.meta.url).pathname;
const port = Number(process.env.PORT || 8000);
const token = process.env.NAI_API_TOKEN || "";
const defaultModel = process.env.NAI_MODEL || "nai-diffusion-4-5-full";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let chunks = [], size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function firstZipFile(zip) {
  let central = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x02014b50) {
      central = i;
      break;
    }
  }
  if (central < 0) throw Error("NovelAI returned an invalid ZIP payload");
  const method = zip.readUInt16LE(central + 10);
  const compressedSize = zip.readUInt32LE(central + 20);
  const local = zip.readUInt32LE(central + 42);
  if (zip.readUInt32LE(local) !== 0x04034b50) throw Error("NovelAI ZIP is missing an image entry");
  const nameLength = zip.readUInt16LE(local + 26);
  const extraLength = zip.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const data = zip.subarray(start, start + compressedSize);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw Error(`Unsupported ZIP compression method: ${method}`);
}

async function generate(req, res) {
  if (!token) return json(res, 503, { error: "NAI_API_TOKEN is not configured on the server" });
  const input = await body(req);
  const width = Math.max(512, Math.min(1536, Math.round(Number(input.width) / 64) * 64 || 832));
  const height = Math.max(512, Math.min(1536, Math.round(Number(input.height) / 64) * 64 || 1216));
  const seed = Number.isInteger(input.seed) ? input.seed : Math.floor(Math.random() * 4_294_967_295);
  const prompt = String(input.prompt || "").slice(0, 8000);
  const negativePrompt = String(input.negativePrompt || "").slice(0, 4000);
  const payload = {
    input: prompt,
    model: String(input.model || defaultModel),
    action: "generate",
    parameters: {
      params_version: 3,
      width,
      height,
      scale: 5,
      sampler: "k_euler_ancestral",
      steps: 28,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: true,
      negative_prompt: negativePrompt,
      seed,
      noise_schedule: "karras",
      legacy: false,
      add_original_image: false,
      cfg_rescale: 0,
      characterPrompts: [],
      v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negativePrompt, char_captions: [] }, legacy_uc: false }
    }
  };
  const upstream = await fetch("https://image.novelai.net/ai/generate-image", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/zip,image/png" },
    body: JSON.stringify(payload)
  });
  const response = Buffer.from(await upstream.arrayBuffer());
  if (!upstream.ok) {
    const message = response.toString("utf8").slice(0, 1000);
    return json(res, upstream.status, { error: message || `NovelAI request failed (${upstream.status})` });
  }
  const image = upstream.headers.get("content-type")?.includes("image/") ? response : firstZipFile(response);
  res.writeHead(200, { "Content-Type": "image/png", "X-NAI-Seed": String(seed), "Cache-Control": "no-store" });
  res.end(image);
}

async function staticFile(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]/, "");
  const file = join(root, relative);
  try {
    if (!(await stat(file)).isFile()) throw Error("Not a file");
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/nai/status") return json(res, 200, { configured: Boolean(token), model: defaultModel });
    if (req.method === "POST" && req.url === "/api/nai/generate") return await generate(req, res);
    if (req.method === "GET" || req.method === "HEAD") return await staticFile(req, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { error: error.message || "Internal server error" });
  }
}).listen(port, () => console.log(`Toonit server listening on http://localhost:${port}`));
