// Pubblica su Instagram (+ Pagina Facebook) i post in coda in social/posts.json.
//
// Regole:
// - solo publish = "automatica", status "scheduled" (o "failed" con meno di 3 tentativi)
//   e publish_at già passato, ma non più di MAX_LATE_H ore fa (niente raffiche dopo un blocco);
// - se check_before non è vuoto serve approved = true;
// - una storia (id che finisce con "-storia") parte solo dopo che il suo post è pubblicato;
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
const IMAGE_BASE = (process.env.IMAGE_BASE || "https://flbanca.github.io/arrivato-app/social/").replace(/\/?$/, "/");

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

async function igPublish(post, imageUrl) {
  const params = { image_url: imageUrl };
  if (post.type === "story") params.media_type = "STORIES";
  else {
    params.caption = post.caption.trim();
    if (post.alt_text) params.alt_text = post.alt_text;
  }
  let c;
  try {
    c = await graph("POST", `${IG}/media`, params);
  } catch (e) {
    // alt_text non accettato da questa versione dell'API: riprova senza.
    if (!params.alt_text || !/alt_text/i.test(e.message)) throw e;
    console.log("  alt_text non supportato, riprovo senza");
    delete params.alt_text;
    c = await graph("POST", `${IG}/media`, params);
  }
  for (let i = 0; i < 30; i++) {
    const s = await graph("GET", c.id, { fields: "status_code" });
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`container IG: ${s.status_code}`);
    if (i === 29) throw new Error("container IG non pronto in tempo");
    await sleep(2000);
  }
  const m = await graph("POST", `${IG}/media_publish`, { creation_id: c.id });
  const info = await graph("GET", m.id, { fields: "permalink" }).catch(() => ({}));
  return { id: m.id, url: info.permalink ?? null };
}

async function fbPublish(post, imageUrl, pageToken) {
  const r = await graph("POST", `${PAGE}/photos`, { url: imageUrl, message: post.caption.trim() }, pageToken);
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
  const imageUrl = IMAGE_BASE + p.image;
  console.log(`→ ${p.id} (${p.type}) ${imageUrl}`);
  if (dry) continue;
  p.result ??= {};
  try {
    const head = await fetch(imageUrl, { method: "HEAD" });
    if (!head.ok) throw new Error(`immagine non raggiungibile (${head.status})`);
    if (!p.result.ig) {
      p.result.ig = await igPublish(p, imageUrl);
      changed = true;
      console.log("  Instagram:", p.result.ig.url ?? p.result.ig.id);
    }
    if (p.type === "feed" && p.facebook !== false && !p.result.fb) {
      const { access_token: pageToken } = await graph("GET", PAGE, { fields: "access_token" });
      p.result.fb = await fbPublish(p, imageUrl, pageToken);
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
