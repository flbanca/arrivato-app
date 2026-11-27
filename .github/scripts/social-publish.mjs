// Pubblica su Instagram (+ Pagina Facebook) i post in coda in social/posts.json.
//
// Regole:
// - solo publish = "automatica", status "scheduled" (o "failed" con meno di 3 tentativi)
//   e publish_at già passato, ma non più di MAX_LATE_H ore fa (niente raffiche dopo un blocco);
// - se check_before non è vuoto serve approved = true;
// - una storia (id che finisce con "-storia") parte solo dopo che il suo post è pubblicato;
// - type "carousel" usa images: [...] (fino a 10) e alt_texts: [...]; su Facebook diventa un post con più foto;
// - type "reel" usa video: "video/x.mp4" (9:16, H.264) e facoltativi cover o thumb_offset (ms); su Facebook diventa un video;
// - Instagram e Facebook già riusciti non vengono ripetuti ai tentativi successivi.
//
// Le immagini sono servite da GitHub Pages: Meta le scarica da IMAGE_BASE.
// Env: META_SYSTEM_TOKEN, META_PAGE_ID, META_IG_USER_ID, IMAGE_BASE
// Uso: node .github/scripts/social-publish.mjs [--dry] [--check] [--now=ISO] [--only=<id>]
import fs from "node:fs";

const G = "https://graph.facebook.com/v27.0";
const FILE = "social/posts.json";
const MAX_ATTEMPTS = 3;
const MAX_LATE_H = 6;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || "").split("=").slice(1).join("=") || null;
const dry = flag("dry");
const only = opt("only");
const now = opt("now") ? new Date(opt("now")) : new Date();
const { META_SYSTEM_TOKEN: TOKEN, META_PAGE_ID: PAGE, META_IG_USER_ID: IG } = process.env;
const IMAGE_BASE = (process.env.IMAGE_BASE || "https://arrivato.flbanca.it/social/").replace(/\/?$/, "/");

async function graph(method, path, params = {}, token = TOKEN) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const res =
    method === "GET"
      ? await fetch(`${G}/${path}?${body}`)
      : await fetch(`${G}/${path}`, { method, body });
  const json = await res.json();
  if (json.error) throw new Error(`${path}: ${json.error.message}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Crea un container IG; se l'API rifiuta alt_text, riprova senza.
async function igContainer(params) {
  try {
    return await graph("POST", `${IG}/media`, params);
  } catch (e) {
    if (!params.alt_text || !/alt_text/i.test(e.message)) throw e;
    console.log("  alt_text non supportato, riprovo senza");
    const { alt_text, ...rest } = params;
    return await graph("POST", `${IG}/media`, rest);
  }
}

async function igWait(id, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const s = await graph("GET", id, { fields: "status_code" });
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`container IG: ${s.status_code}`);
    await sleep(2000);
  }
  throw new Error("container IG non pronto in tempo");
}

async function igPublish(post, imageUrls) {
  let c;
  if (post.type === "reel") {
    // Reel: il video viene scaricato ed elaborato da Meta, può volerci qualche minuto.
    const params = { media_type: "REELS", video_url: imageUrls[0], caption: post.caption.trim(), share_to_feed: "true" };
    if (post.cover) params.cover_url = IMAGE_BASE + post.cover;
    else if (post.thumb_offset != null) params.thumb_offset = String(post.thumb_offset);
    c = await graph("POST", `${IG}/media`, params);
    await igWait(c.id, 150);
  } else if (post.type === "carousel") {
    // Carosello: un container per immagine, poi il container padre con la didascalia.
    const children = [];
    for (const [i, url] of imageUrls.entries()) {
      const params = { image_url: url, is_carousel_item: "true" };
      if (post.alt_texts?.[i]) params.alt_text = post.alt_texts[i];
      const child = await igContainer(params);
      await igWait(child.id);
      children.push(child.id);
    }
    c = await graph("POST", `${IG}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: post.caption.trim() });
  } else {
    const params = { image_url: imageUrls[0] };
    if (post.type === "story") params.media_type = "STORIES";
    else {
      params.caption = post.caption.trim();
      if (post.alt_text) params.alt_text = post.alt_text;
    }
    c = await igContainer(params);
  }
  if (post.type !== "reel") await igWait(c.id);
  const m = await graph("POST", `${IG}/media_publish`, { creation_id: c.id });
  const info = await graph("GET", m.id, { fields: "permalink" }).catch(() => ({}));
  return { id: m.id, url: info.permalink ?? null };
}

async function fbPublish(post, imageUrls, pageToken) {
  let r;
  if (post.type === "reel") {
    r = await graph("POST", `${PAGE}/videos`, { file_url: imageUrls[0], description: post.caption.trim() }, pageToken);
    return { id: r.id, url: `https://www.facebook.com/${r.id}` };
  }
  if (imageUrls.length === 1) {
    r = await graph("POST", `${PAGE}/photos`, { url: imageUrls[0], message: post.caption.trim() }, pageToken);
  } else {
    // Post con più foto: carico le foto senza pubblicarle, poi un unico post che le allega.
    const media = {};
    for (const [i, url] of imageUrls.entries()) {
      const ph = await graph("POST", `${PAGE}/photos`, { url, published: "false" }, pageToken);
      media[`attached_media[${i}]`] = JSON.stringify({ media_fbid: ph.id });
    }
    r = await graph("POST", `${PAGE}/feed`, { message: post.caption.trim(), ...media }, pageToken);
  }
  const id = r.post_id || r.id;
  return { id, url: `https://www.facebook.com/${id}` };
}

async function check() {
  const me = await graph("GET", "me", { fields: "id,name" });
  console.log("Utente di sistema:", me.name, me.id);
  const page = await graph("GET", PAGE, { fields: "name,access_token,instagram_business_account{id,username}" });
  console.log("Pagina:", page.name, PAGE, page.access_token ? "(token pagina ok)" : "(NESSUN token pagina)");
  const linked = page.instagram_business_account;
  console.log("Instagram collegato alla pagina:", linked ? `@${linked.username} ${linked.id}` : "NESSUNO");
  if (linked && linked.id !== IG) console.log(`! META_IG_USER_ID (${IG}) diverso da quello collegato (${linked.id})`);
  const ig = await graph("GET", IG, { fields: "username,media_count" });
  console.log("Account IG:", `@${ig.username}`, "post:", ig.media_count);
  const lim = await graph("GET", `${IG}/content_publishing_limit`, { fields: "quota_usage,config" }).catch((e) => ({ error: e.message }));
  console.log("Limite pubblicazioni:", JSON.stringify(lim.data?.[0] ?? lim));
}

if (!TOKEN || !PAGE || !IG) {
  console.error("Mancano META_SYSTEM_TOKEN, META_PAGE_ID o META_IG_USER_ID");
  if (!dry) process.exit(1);
}
if (flag("check")) {
  await check();
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
const posts = data.posts;
const byId = new Map(posts.map((p) => [p.id, p]));

function why(p) {
  if (only) return p.id === only && p.status !== "published" ? null : "non richiesto";
  if (p.publish !== "automatica") return "manuale";
  if (p.status === "published" || p.status === "skipped") return p.status;
  if (p.status === "failed" && (p.attempts ?? 0) >= MAX_ATTEMPTS) return "troppi tentativi";
  const at = new Date(p.publish_at);
  if (at > now) return "non ancora";
  if (now - at > MAX_LATE_H * 3600e3) return "late";
  if (p.check_before?.length && p.approved !== true) return "da approvare";
  if (/\{\{[^}]*\}\}/.test(p.caption ?? "")) return "segnaposto {{…}} nella didascalia";
  const parent = p.id.endsWith("-storia") && byId.get(p.id.replace(/-storia$/, ""));
  if (parent && parent.status !== "published") return "attende il post";
  return null;
}

let changed = false;
const due = [];
for (const p of posts) {
  const r = why(p);
  if (r === null) due.push(p);
  else if (r === "late") {
    console.log(`− salto (in ritardo di oltre ${MAX_LATE_H}h): ${p.id}`);
    if (!dry) { p.status = "skipped"; p.error = "in ritardo, non pubblicato"; changed = true; }
  } else if (r === "da approvare" && new Date(p.publish_at) - now < 48 * 3600e3) {
    console.log(`! da approvare entro ${p.publish_at}: ${p.id} -> ${p.check_before.join(" ")}`);
  }
}
due.sort((a, b) => a.publish_at.localeCompare(b.publish_at));
console.log(`${now.toISOString()} · da pubblicare: ${due.map((p) => p.id).join(", ") || "nessuno"}`);

let failed = false;
for (const p of due.slice(0, 3)) {
  const imageUrls = (p.type === "reel" ? [p.video] : p.images ?? [p.image]).map((f) => IMAGE_BASE + f);
  console.log(`→ ${p.id} (${p.type}) ${imageUrls.join(" ")}`);
  if (dry) continue;
  p.result ??= {};
  try {
    for (const url of imageUrls) {
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) throw new Error(`immagine non raggiungibile (${head.status}): ${url}`);
    }
    if (!p.result.ig) {
      p.result.ig = await igPublish(p, imageUrls);
      changed = true;
      console.log("  Instagram:", p.result.ig.url ?? p.result.ig.id);
    }
    if (p.type !== "story" && p.facebook !== false && !p.result.fb) {
      const { access_token: pageToken } = await graph("GET", PAGE, { fields: "access_token" });
      p.result.fb = await fbPublish(p, imageUrls, pageToken);
      changed = true;
      console.log("  Facebook:", p.result.fb.url);
    }
    p.status = "published";
    p.published_at = new Date().toISOString();
    delete p.error;
    changed = true;
  } catch (e) {
    failed = true;
    p.status = "failed";
    p.attempts = (p.attempts ?? 0) + 1;
    p.error = String(e.message).slice(0, 500);
    changed = true;
    console.error(`  ERRORE (tentativo ${p.attempts}): ${p.error}`);
  }
}

if (changed) fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
if (failed) process.exitCode = 1;
