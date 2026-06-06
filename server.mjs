import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);
const serverToken = process.env.NAI_API_TOKEN || "";
const defaultModel = process.env.NAI_MODEL || "nai-diffusion-4-5-full";
const vibeCache = new Map();
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let chunks = [], size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 30_000_000) throw Error("Request is too large");
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

const bounded = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const rawBase64 = value => String(value || "").replace(/^data:image\/[^;]+;base64,/, "");
const modelNames = {
  "NAID4.5F": "nai-diffusion-4-5-full",
  "NAID4.5C": "nai-diffusion-4-5-curated",
  "NAID4.0F": "nai-diffusion-4-full",
  "NAID4.0C": "nai-diffusion-4-curated-preview",
  NAID3: "nai-diffusion-3"
};
const samplers = new Set(["k_euler", "k_euler_ancestral", "k_dpmpp_2m", "k_dpmpp_2s_ancestral", "k_dpmpp_sde", "k_dpmpp_2m_sde", "ddim_v3"]);
const schedules = new Set(["native", "karras", "exponential", "polyexponential"]);

function cleanPromptAndOverrides(value, defaults) {
  const output = { ...defaults }, tags = [];
  for (const raw of String(value || "").split(",")) {
    const tag = raw.replace(/\r?\n/g, "").trim();
    if (!tag || tag.startsWith("#")) continue;
    let match;
    if ((match = tag.match(/^seed:\s*(\d+)$/i))) output.seed = Number(match[1]);
    else if ((match = tag.match(/^resolution:\s*(\d+)\s*x\s*(\d+)$/i))) [output.width, output.height] = [Number(match[1]), Number(match[2])];
    else if ((match = tag.match(/^cfg_scale:\s*([\d.]+)$/i))) output.scale = bounded(match[1], 1, 10, output.scale);
    else if ((match = tag.match(/^cfg_rescale:\s*(-?[\d.]+)$/i))) output.cfgRescale = bounded(match[1], -1, 1, output.cfgRescale);
    else if ((match = tag.match(/^steps:\s*(\d+)$/i))) output.steps = bounded(match[1], 1, 150, output.steps);
    else if ((match = tag.match(/^sampler:\s*(\S+)$/i)) && samplers.has(match[1])) output.sampler = match[1];
    else if ((match = tag.match(/^scheduler:\s*(\S+)$/i)) && schedules.has(match[1])) output.schedule = match[1];
    else tags.push(tag);
  }
  output.prompt = tags.join(", ");
  return output;
}

async function novelFetch(token, payload) {
  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch("https://image.novelai.net/ai/generate-image", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/zip,image/png" },
      body: JSON.stringify(payload)
    });
    if (![502, 503, 504, 520].includes(response.status) || attempt === 3) return response;
    await response.arrayBuffer();
    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
  }
  return response;
}

async function encodeVibes(token, images, model, informationExtracted) {
  return Promise.all(images.map(async image => {
    const key = createHash("sha256").update(`${model}:${informationExtracted}:${image}`).digest("hex");
    if (vibeCache.has(key)) return vibeCache.get(key);
    const upstream = await fetch("https://image.novelai.net/ai/encode-vibe", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image, information_extracted: informationExtracted, model })
    });
    const encoded = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) throw Error(encoded.toString("utf8").slice(0, 1000) || `NovelAI vibe encoding failed (${upstream.status})`);
    const value = encoded.toString("base64");
    vibeCache.set(key, value);
    if (vibeCache.size > 50) vibeCache.delete(vibeCache.keys().next().value);
    return value;
  }));
}

async function generate(req, res) {
  const input = await body(req);
  const token = String(input.apiKey || serverToken).trim();
  if (!token) return json(res, 503, { error: "NovelAI API key is not configured" });
  const initialSeed = Number.isInteger(input.seed) && input.seed >= 0 ? input.seed : Math.floor(Math.random() * 4_294_967_295);
  const settings = cleanPromptAndOverrides(input.prompt, {
    width: Number(input.width) || 832,
    height: Number(input.height) || 1216,
    seed: initialSeed,
    scale: bounded(input.scale, 1, 10, 5),
    cfgRescale: bounded(input.cfgRescale, -1, 1, .4),
    steps: bounded(input.steps, 1, 150, 28),
    sampler: samplers.has(input.sampler) ? input.sampler : "k_euler_ancestral",
    schedule: schedules.has(input.schedule) ? input.schedule : "native"
  });
  const width = Math.max(512, Math.min(1536, Math.round(settings.width / 64) * 64 || 832));
  const height = Math.max(512, Math.min(1536, Math.round(settings.height / 64) * 64 || 1216));
  const seed = settings.seed;
  const prompt = settings.prompt.slice(0, 8000);
  const negativePrompt = String(input.negativePrompt || "").slice(0, 4000);
  const characters = Array.isArray(input.characters) ? input.characters.slice(0, 5) : [];
  const vibeImages = Array.isArray(input.vibes) ? input.vibes.slice(0, 5).map(rawBase64).filter(Boolean) : [];
  const vibeInformation = bounded(input.vibeInformation, 0, 1, 1);
  const model = modelNames[input.model] || String(input.model || defaultModel);
  const vibes = await encodeVibes(token, vibeImages, model, vibeInformation);
  let vibeStrengths = vibes.map(() => bounded(input.vibeStrength, -1, 1, .6));
  const vibeNormalize = input.vibeNormalize !== false;
  const vibeTotal = vibeStrengths.reduce((sum, value) => sum + value, 0);
  if (vibeNormalize && vibeTotal > 1) vibeStrengths = vibeStrengths.map(value => Number((value / vibeTotal).toFixed(15)));
  const characterRecords = characters.map(character => ({
    prompt: String(character.prompt || "").slice(0, 2000),
    negative: String(character.negative || "").slice(0, 1000),
    centers: [{ x: bounded(character.x, 0, 1, .5), y: bounded(character.y, 0, 1, .5) }]
  })).filter(character => character.prompt);
  const charCaptions = characterRecords.map(character => ({ char_caption: character.prompt, centers: character.centers }));
  const charNegativeCaptions = characterRecords.map(character => ({ char_caption: character.negative, centers: character.centers }));
  const initImage = rawBase64(input.initImage);
  const preciseReferences = Array.isArray(input.preciseReferences) ? input.preciseReferences.slice(0, 5).map(reference => ({
    image: rawBase64(reference.image),
    description: String(reference.description || "").slice(0, 2000),
    strength: bounded(reference.strength, 0, 1, .6),
    fidelity: bounded(reference.fidelity, 0, 1, .5),
    information: bounded(reference.information, 0, 1, 1)
  })).filter(reference => reference.image) : [];
  const action = initImage ? "img2img" : "generate";
  const payload = {
    input: prompt,
    model,
    action,
    parameters: {
      params_version: 3,
      width,
      height,
      scale: settings.scale,
      sampler: settings.sampler,
      steps: settings.steps,
      n_samples: 1,
      extra_noise_seed: seed,
      ucPreset: 0,
      qualityToggle: true,
      negative_prompt: negativePrompt,
      seed,
      noise_schedule: settings.schedule,
      legacy: false,
      legacy_uc: false,
      legacy_v3_extend: false,
      add_original_image: true,
      autoSmea: true,
      prefer_brownian: true,
      cfg_rescale: settings.cfgRescale,
      v4_prompt: { caption: { base_caption: prompt, char_captions: charCaptions }, use_coords: false, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negativePrompt, char_captions: charNegativeCaptions }, legacy_uc: false }
    }
  };
  if (input.varPlus === true) payload.parameters.skip_cfg_above_sigma = model.includes("4-5") ? 58 : 19;
  if (initImage) {
    payload.parameters.image = initImage;
    payload.parameters.strength = bounded(input.img2imgStrength, 0, 1, .5);
    payload.parameters.noise = bounded(input.img2imgNoise, 0, 1, .05);
  }
  if (vibes.length) {
    payload.parameters.normalize_reference_strength_multiple = vibeNormalize;
    payload.parameters.reference_image_multiple = vibes;
    payload.parameters.reference_strength_multiple = vibeStrengths;
    if (model === "nai-diffusion-3") payload.parameters.reference_information_extracted_multiple = vibes.map(() => vibeInformation);
  }
  if (preciseReferences.length && model.includes("4-5")) {
    delete payload.parameters.skip_cfg_above_sigma;
    payload.parameters.director_reference_descriptions = preciseReferences.map(reference => reference.description);
    payload.parameters.director_reference_images = preciseReferences.map(reference => reference.image);
    payload.parameters.director_reference_information_extracted = preciseReferences.map(reference => reference.information);
    payload.parameters.director_reference_secondary_strength_values = preciseReferences.map(reference => reference.fidelity);
    payload.parameters.director_reference_strength_values = preciseReferences.map(reference => reference.strength);
    payload.parameters.controlnet_strength = 1;
    payload.parameters.inpaintImg2ImgStrength = 1;
    payload.parameters.normalize_reference_strength_multiple = true;
  }
  const upstream = await novelFetch(token, payload);
  const response = Buffer.from(await upstream.arrayBuffer());
  if (!upstream.ok) {
    const message = response.toString("utf8").slice(0, 1000);
    return json(res, upstream.status, { error: message || `NovelAI request failed (${upstream.status})` });
  }
  const image = upstream.headers.get("content-type")?.includes("image/") ? response : firstZipFile(response);
  res.writeHead(200, { "Content-Type": "image/png", "X-NAI-Seed": String(seed), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(image);
}

async function testNovelAI(req, res) {
  const input = await body(req);
  const token = String(input.apiKey || serverToken).trim();
  if (!token) return json(res, 400, { error: "NovelAI API key is not configured" });
  const upstream = await fetch("https://api.novelai.net/user/subscription", {
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" }
  });
  const response = await upstream.text();
  if (!upstream.ok) return json(res, upstream.status, { error: response.slice(0, 1000) || `NovelAI authentication failed (${upstream.status})` });
  const subscription = JSON.parse(response);
  json(res, 200, { ok: true, tier: subscription.tier ?? null, active: subscription.active ?? true });
}

async function staticFile(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "");
  const file = resolve(root, requested);
  try {
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw Error("Path escapes static root");
    if (!(await stat(file)).isFile()) throw Error("Not a file");
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
      return res.end();
    }
    if (req.method === "GET" && req.url === "/api/nai/status") return json(res, 200, { configured: Boolean(serverToken), model: defaultModel });
    if (req.method === "POST" && req.url === "/api/nai/test") return await testNovelAI(req, res);
    if (req.method === "POST" && req.url === "/api/nai/generate") return await generate(req, res);
    if (req.method === "GET" || req.method === "HEAD") return await staticFile(req, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { error: error.message || "Internal server error" });
  }
}).listen(port, () => console.log(`Toonit server listening on http://localhost:${port}`));
