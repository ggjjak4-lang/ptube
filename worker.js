const API = "https://api.theporndb.net";
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce"
];
const RES = [["UHD", /\b(2160p|4k|uhd)\b/i, 900], ["FullHD", /\b1080p\b/i, 300], ["HD", /\b720p\b/i, 150], ["SD", /\b(sd|480p|540p)\b/i, 60]];
const DEFAULTS = { sites: [], performers: [], genres: [], resolutions: ["UHD", "FullHD", "HD"], minSeeders: 3, max: 10, hideTorrents: false };

const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const enc = (c) => btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dec = (seg) => {
  try {
    const o = JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(seg.length / 4) * 4, "=")));
    const r = (o.resolutions ?? DEFAULTS.resolutions).filter((x) => RES.some(([c]) => c === x));
    return {
      sites: (o.sites ?? []).slice(0, 300),
      performers: (o.performers ?? []).slice(0, 300),
      genres: (o.genres ?? []).slice(0, 60),
      resolutions: r.length ? r : DEFAULTS.resolutions,
      minSeeders: Math.min(Math.max(+o.minSeeders || 3, 0), 50),
      max: Math.min(Math.max(+o.max || 10, 1), 30),
      hideTorrents: !!o.hideTorrents
    };
  } catch { return DEFAULTS; }
};

const J = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const u = (v) => (typeof v === "string" && /^https?:/.test(v) ? v : "");

async function tp(env, path, ttl = 1800) {
  const k = "c:" + path;
  const hit = await env.CACHE.get(k, "json");
  if (hit) return hit;
  const r = await fetch(API + path, { headers: { Authorization: "Bearer " + env.TPDB_TOKEN, Accept: "application/json", "User-Agent": "pt/1" } });
  if (!r.ok) throw new Error("tpdb " + r.status);
  const d = await r.json();
  await env.CACHE.put(k, JSON.stringify(d), { expirationTtl: ttl });
  return d;
}

const mapScene = (s) => {
  const site = s.site?.name ?? s.site_name ?? "";
  const perf = (s.performers ?? []).map((p) => ({ id: p?.id, name: p?.name })).filter((p) => p.name);
  const tags = (s.tags ?? []).map((t) => t?.name ?? t).filter(Boolean);
  return {
    id: "porndb:" + s.id,
    name: (s.title ?? "").trim(),
    description: (s.description ?? "").trim(),
    poster: u(s.image?.url ?? s.image ?? s.poster),
    background: u(s.background?.url ?? s.background),
    logo: u(s.site?.logo),
    site, performers: perf.map((p) => p.name), perfIds: perf.map((p) => p.id),
    genres: tags,
    date: String(s.date ?? "").slice(0, 10),
    runtime: s.duration ? Math.round(s.duration / 60) + "m" : undefined,
    year: s.date ? +String(s.date).slice(0, 4) : undefined,
    website: s.url ?? undefined
  };
};

async function scenes(env, o) {
  const p = new URLSearchParams({ per_page: "30", page: String(Math.floor((o.skip ?? 0) / 30) + 1) });
  if (o.q) p.set("q", o.q);
  if (o.tag) p.set("tag", o.tag);
  if (o.site) p.set("site", o.site);
  if (o.performer) p.set("performer", o.performer);
  const d = await tp(env, "/scenes?" + p);
  const rows = (d.data ?? d.scenes ?? []).map(mapScene);
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

async function search(env, q) {
  const n = norm(q);
  const out = [];
  const pk = await env.CACHE.list({ prefix: "pn:" + n, limit: 5 });
  const sk = await env.CACHE.list({ prefix: "sn:" + n, limit: 5 });
  for (const k of pk.keys.slice(0, 2)) {
    const p = await env.CACHE.get(k.name, "json");
    if (p?.id) out.push(...await scenes(env, { performer: p.id }));
  }
  for (const k of sk.keys.slice(0, 2)) {
    const s = await env.CACHE.get(k.name, "json");
    if (s?.name) out.push(...await scenes(env, { site: s.name }));
  }
  out.push(...await scenes(env, { q }));
  return dedupe(out);
}

const dedupe = (rows) => {
  const seen = new Set();
  return rows.filter((s) => {
    const k = s.id ?? s.site + s.name + s.date;
    if (seen.has(k) || (s.poster && seen.has(s.poster))) return false;
    seen.add(k); if (s.poster) seen.add(s.poster);
    return true;
  });
};

const OK_IMG = /\.(jpe?g|png|webp)(\?|$)/i;
const passes = (s, cfg) => {
  if (!s.id || !s.site) return false;
  if (cfg.sites.length && !cfg.sites.includes(s.site)) return false;
  if (cfg.performers.length && !s.performers.some((p) => cfg.performers.includes(p))) return false;
  if (!s.poster || !OK_IMG.test(s.poster)) return false;
  const t = s.name;
  if (t.length < 12 || !s.performers.length) return false;
  if (t.toLowerCase() === s.site.toLowerCase()) return false;
  if (/^[A-Z]{2,6}-?\d{2,5}$/.test(t) || /^scene\s*\d+$/i.test(t)) return false;
  const d = Date.parse(s.date);
  return d && d < Date.now() + 864e5 && Date.now() - d < 400 * 864e5;
};

async function streams(scene, cfg) {
  if (cfg.hideTorrents) return [];
  const stamp = (() => { const [y, m, d] = scene.date.split("-"); return `${y.slice(2)}.${m}.${d}`; })();
  const q = [scene.site, stamp, scene.performers[0] ?? "", scene.name].join(" ").replace(/\s+/g, " ").trim();
  const tt = norm(scene.name).split(" ").filter((x) => x.length > 2);
  const site = norm(scene.site);
  const bag = new Map();

  const add = (rows) => rows.forEach((t) => {
    if (!t.infoHash || bag.has(t.infoHash)) return;
    bag.set(t.infoHash, t);
  });

  await Promise.all([
    fetch("https://apibay.org/q.php?q=" + encodeURIComponent(q) + "&cat=500", { headers: { "User-Agent": "pt/1" } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows) => Array.isArray(rows) && rows[0]?.id !== "0" && add(rows.map((t) => ({ name: t.name, infoHash: t.info_hash, size: +t.size, seeders: +t.seeders }))))
      .catch(() => {}),
    fetch("https://api.knaben.org/v1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, size: 30, hideUnsafe: false }) })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d?.hits && add(d.hits.map((h) => ({ name: h.title, infoHash: h.hash, size: h.bytes, seeders: h.seeders }))))
      .catch(() => {})
  ]);

  const out = [];
  for (const t of bag.values()) {
    const n = norm(t.name);
    if (!n.includes(site)) continue;
    const tier = RES.find(([, re]) => re.test(t.name));
    if (!tier) continue;
    const [label, , minMB] = tier;
    if (!cfg.resolutions.includes(label)) continue;
    const mb = t.size / 1048576;
    if (mb < minMB || t.seeders < cfg.minSeeders) continue;
    if (/sample|trailer|preview/i.test(t.name)) continue;
    let sc = RES.findIndex(([c]) => c === label);
    sc = (4 - sc) * 100;
    if (n.includes(stamp)) sc += 40;
    sc += scene.performers.filter((p) => n.includes(norm(p))).length * 20;
    sc += Math.round(60 * tt.filter((x) => n.includes(x)).length / Math.max(tt.length, 1));
    out.push({
      name: label,
      description: `${(mb / 1024).toFixed(2)} GB · ${t.seeders} seeder`,
      infoHash: t.infoHash,
      sources: TRACKERS.map((x) => "tracker:" + x),
      behaviorHints: { bingeGroup: "pt-" + label, filename: t.name, videoSize: t.size },
      sc
    });
  }
  return out.sort((a, b) => b.sc - a.sc).slice(0, cfg.max);
}

const shape = (s, o) => ({
  id: s.id, type: "movie", name: s.name,
  description: (s.description ?? "").slice(0, 900),
  poster: s.poster ? `${o}/img?u=${encodeURIComponent(s.poster)}&r=${encodeURIComponent(s.site)}` : undefined,
  background: s.background ? `${o}/img?u=${encodeURIComponent(s.background)}&r=${encodeURIComponent(s.site)}` : undefined,
  logo: s.logo || undefined, posterShape: "landscape",
  genres: s.genres, runtime: s.runtime, year: s.year, website: s.website,
  cast: s.performers,
  links: [
    ...(s.perfIds ?? []).map((id, i) => ({ name: s.performers[i], category: "Cast", url: `stremio:///detail/movie/porndb:performer:${id}` })),
    ...s.genres.slice(0, 12).map((g) => ({ name: g, category: "Genres", url: `stremio:///search?search=${encodeURIComponent(g)}` }))
  ],
  behaviorHints: { hasScheduledVideos: false }
});

async function manifest(env, required) {
  const tags = (await env.CACHE.get("tags", "json")) ?? [];
  return {
    id: env.ADDON_ID, version: "1.0.0", name: "PornTube Pro",
    description: "P2P adult catalog with studios, performers and full quality ladder.",
    logo: "https://placehold.co/256x256/111/fff?text=PT",
    resources: ["catalog", "meta", "stream"], types: ["movie"], idPrefixes: ["porndb"],
    behaviorHints: { adult: true, configurable: true, configurationRequired: required },
    catalogs: [
      { type: "movie", id: "new", name: "New", extra: [{ name: "skip" }, { name: "search", isRequired: false }, { name: "genre", isRequired: false, options: tags.slice(0, 120) }] },
      { type: "movie", id: "sites", name: "Studios", extra: [{ name: "skip" }, { name: "search", isRequired: false }] },
      { type: "movie", id: "performers", name: "Performers", extra: [{ name: "skip" }, { name: "search", isRequired: false }] },
      { type: "movie", id: "fav", name: "My List", extra: [{ name: "skip" }] }
    ]
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const o = url.origin;
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "manifest.json") return J(await manifest(env, true));
    if (parts[0] === "configure") return new Response(page(), { headers: { "content-type": "text/html;charset=utf-8" } });

    if (parts[0] === "admin") {
      if (url.searchParams.get("key") !== env.ADMIN_KEY) return J({ err: "key" }, 401);
      const what = url.searchParams.get("what");
      if (what === "sites" || what === "tags") {
        const d = await tp(env, what === "sites" ? "/sites" : "/tags?per_page=200", 60);
        const rows = d.data ?? d ?? [];
        const names = rows.map((x) => x.name ?? x).filter(Boolean);
        if (what === "tags") await env.CACHE.put("tags", JSON.stringify(names));
        else for (const r of rows) if (r.name) await env.CACHE.put("sn:" + norm(r.name), JSON.stringify({ name: r.name }));
        return J({ ok: rows.length });
      }
      if (what === "performers") {
        const page = +url.searchParams.get("page") || 1;
        const d = await tp(env, `/performers?per_page=100&page=${page}`, 60);
        const rows = d.data ?? [];
        for (const r of rows) if (r.name) await env.CACHE.put("pn:" + norm(r.name), JSON.stringify({ id: r.id, name: r.name }));
        return J({ ok: rows.length, page });
      }
      if (what === "search") return J({ q: url.searchParams.get("q"), n: (await search(env, url.searchParams.get("q"))).length });
    }

    if (parts[0] === "sites" || parts[0] === "performers") {
      const p = parts[0] === "sites" ? "sn:" : "pn:";
      const q = norm(url.searchParams.get("q") ?? "");
      const list = await env.CACHE.list({ prefix: p + q, limit: 40 });
      const rows = await Promise.all(list.keys.map((k) => env.CACHE.get(k.name, "json")));
      return J(rows.filter(Boolean).map((r) => r.name));
    }

    if (parts[0] === "img") {
      const src = url.searchParams.get("u"), ref = url.searchParams.get("r");
      if (!src) return new Response("", { status: 404 });
      const c = caches.default, ck = new Request(url.toString());
      const hit = await c.match(ck);
      if (hit) return hit;
      const r = await fetch(src, { headers: { Referer: ref ? "https://" + ref + "/" : src, "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) return new Response("", { status: 404 });
      const res = new Response(r.body, { headers: { "content-type": r.headers.get("content-type") ?? "image/jpeg", "cache-control": "public,max-age=604800,immutable" } });
      await c.put(ck, res.clone());
      return res;
    }

    let cfg = DEFAULTS;
    if (parts.length > 1) { cfg = dec(parts[0]); parts.shift(); }
    if (parts[0] === "manifest.json") return J(await manifest(env, false));

    if (parts[0] === "catalog" && parts[1] === "movie") {
      const id = parts[2];
      const ex = {};
      for (const kv of (parts[3] ?? "").replace(/\.json$/, "").split("&")) {
        const i = kv.indexOf("=");
        if (i > 0) ex[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
      }
      const skip = +ex.skip || 0;

      if (id === "sites" || id === "performers") {
        const p = id === "sites" ? "sn:" : "pn:";
        const list = await env.CACHE.list({ prefix: p + norm(ex.search ?? ""), limit: 60, cursor: skip ? String(skip) : undefined });
        const rows = await Promise.all(list.keys.map((k) => env.CACHE.get(k.name, "json")));
        return J({ metas: rows.filter(Boolean).map((r) => ({
          id: id === "sites" ? `porndb:site:${r.name}` : `porndb:performer:${r.id}`,
          type: "movie", name: r.name, posterShape: "square",
          poster: `${o}/img?u=${encodeURIComponent("https://placehold.co/300x300/1a1a1a/fff?text=" + encodeURIComponent(r.name.slice(0, 18)))}`
        })) });
      }

      if (id === "fav") {
        const rows = [];
        for (const p of cfg.performers.slice(0, 8)) {
          const k = await env.CACHE.list({ prefix: "pn:" + norm(p), limit: 1 });
          const v = k.keys[0] && await env.CACHE.get(k.keys[0].name, "json");
          if (v?.id) rows.push(...await scenes(env, { performer: v.id }));
        }
        return J({ metas: dedupe(rows).slice(0, 30).map((s) => shape(s, o)) });
      }

      let rows = ex.search ? await search(env, ex.search) : await scenes(env, { tag: ex.genre, skip });
      rows = dedupe(rows.filter((s) => passes(s, cfg)));
      return J({ metas: rows.slice(0, 30).map((s) => shape(s, o)) });
    }

    if (parts[0] === "meta" && parts[1] === "movie") {
      const raw = parts[2].replace(/\.json$/, "");

      if (raw.startsWith("porndb:performer:")) {
        const id = raw.split(":")[2];
        const rows = (await scenes(env, { performer: id })).filter((s) => passes(s, cfg));
        return J({ meta: {
          id: raw, type: "movie", name: "Performer", posterShape: "square",
          poster: `${o}/img?u=${encodeURIComponent("https://placehold.co/300x300/1a1a1a/fff?text=Performer")}`,
          videos: rows.slice(0, 60).map((s, i) => ({ id: s.id, title: s.name, released: new Date(s.date).toISOString(), episode: i + 1, season: 1 }))
        } });
      }
      if (raw.startsWith("porndb:site:")) {
        const name = raw.split(":").slice(2).join(":");
        const rows = (await scenes(env, { site: name })).filter((s) => passes(s, cfg));
        return J({ meta: { id: raw, type: "movie", name, videos: rows.slice(0, 60).map((s, i) => ({ id: s.id, title: s.name, episode: i + 1, season: 1 })) } });
      }

      const d = await tp(env, "/scenes/" + raw.replace(/^porndb:/, ""));
      const s = d.data ?? d;
      return s?.id ? J({ meta: shape(mapScene(s), o) }) : J({ meta: null }, 404);
    }

    if (parts[0] === "stream" && parts[1] === "movie") {
      const d = await tp(env, "/scenes/" + parts[2].replace(/\.json$/, "").replace(/^porndb:/, ""));
      const s = d.data ?? d;
      if (!s?.id) return J({ streams: [] });
      return J({ streams: await streams(mapScene(s), cfg) });
    }

    return new Response("not found", { status: 404 });
  }
};

function page() {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font:16px system-ui;background:#111;color:#eee;padding:20px;max-width:560px;margin:auto">
<h2>PornTube Pro</h2>
<p>Studios <input id=sq placeholder="search" oninput="find('sites','sl')"><div id=sl></div><textarea id=sites rows=2 style="width:100%"></textarea></p>
<p>Performers <input id=pq placeholder="search" oninput="find('performers','pl')"><div id=pl></div><textarea id=perf rows=2 style="width:100%"></textarea></p>
<p>Genres <textarea id=gen rows=2 style="width:100%"></textarea></p>
<p>Qualities ${RES.map(([c], i) => `<label><input type=checkbox class=r value=${c} ${i < 3 ? "checked" : ""}> ${c}</label>`).join(" ")}</p>
<p>Min seeders <input id=ms type=number value=3 min=0 max=50 style="width:60px"> Max results <input id=mx type=number value=10 min=1 max=30 style="width:60px"></p>
<button onclick="go()" style="padding:12px 20px;font-size:16px">Install</button><p id=out></p>
<script>
const base=location.origin;
async function find(k,t){const q=document.getElementById(k[0]==='s'?'sq':'pq').value;
 const r=await fetch(base+'/'+k+'?q='+encodeURIComponent(q));const a=await r.json();
 document.getElementById(t).innerHTML=a.map(n=>'<a style="color:#8af;margin-right:10px" href="#" onclick="document.getElementById(k[0]===\\'s\\'?\\'sites\\':\\'perf\\').value+= (document.getElementById(k[0]===\\'s\\'?\\'sites\\':\\'perf\\').value?\\', \\':\\'\\')+\\''+n.replace(/'/g,"\\\\'")+'\\';return false">'+n+'</a>').join('');}
function go(){const c={sites:document.getElementById('sites').value.split(',').map(s=>s.trim()).filter(Boolean),
 performers:document.getElementById('perf').value.split(',').map(s=>s.trim()).filter(Boolean),
 genres:document.getElementById('gen').value.split(',').map(s=>s.trim()).filter(Boolean),
 resolutions:[...document.querySelectorAll('.r:checked')].map(e=>e.value),
 minSeeders:+document.getElementById('ms').value,max:+document.getElementById('mx').value};
 const b=btoa(JSON.stringify(c)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
 const link=base+'/'+b+'/manifest.json';
 document.getElementById('out').innerHTML='<a style="color:#8af" href="'+link+'">'+link+'</a>';
 location.href=link.replace(/^https?:/,'stremio://');}
</script></body>`;
}
