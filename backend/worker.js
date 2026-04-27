/**
 * UAS Response Latency Index — Autonomous Backend Agent
 *
 * Runs on Cloudflare Workers with a cron trigger. Every N hours it:
 *   1. Fetches all configured RSS feeds
 *   2. Classifies items via Claude API
 *   3. Stores results in Workers KV under the key `latest`
 *
 * The HTML front-end (or anyone) can GET /api/items to retrieve the latest
 * classified set without needing an Anthropic key.
 *
 * Required bindings (configure in wrangler.toml):
 *   - KV namespace `STORE`
 *   - Secret `ANTHROPIC_API_KEY`
 *   - Optional vars `MODEL` (default claude-haiku-4-5-20251001), `ITEMS_PER_FEED` (default 5)
 */

const FEEDS = [
  { name: "Defense News",                     url: "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml", category: "defense" },
  { name: "USNI News",                        url: "https://news.usni.org/feed",                                        category: "defense" },
  { name: "Breaking Defense",                 url: "https://breakingdefense.com/feed/",                                 category: "defense" },
  { name: "War on the Rocks",                 url: "https://warontherocks.com/feed/",                                   category: "defense" },
  { name: "ISW",                              url: "https://www.understandingwar.org/rss.xml",                          category: "osint" },
  { name: "Bellingcat",                       url: "https://www.bellingcat.com/feed/",                                  category: "osint" },
  { name: "sUAS News",                        url: "https://www.suasnews.com/feed/",                                    category: "trade" },
  { name: "Google News: drone military",      url: "https://news.google.com/rss/search?q=drone+military+OR+UAS+OR+UAV+attack&hl=en-US&gl=US&ceid=US:en", category: "wire" },
  { name: "Google News: counter-UAS",         url: "https://news.google.com/rss/search?q=counter-UAS+OR+%22counter+drone%22+OR+%22shot+down+drone%22&hl=en-US&gl=US&ceid=US:en", category: "wire" },
];

const stripHtml = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Mapping ACLED event_type → our response_type vocabulary
const ACLED_RESPONSE_MAP = {
  "Explosions/Remote violence": "kinetic",
  "Battles": "kinetic",
  "Violence against civilians": "kinetic",
  "Strategic developments": "passive",
  "Riots": "passive",
  "Protests": "passive",
};

// Tiny country-centroid lookup for GDELT articles (sourcecountry → [lat, lon]).
// Not exhaustive — items whose sourcecountry isn't here get skipped.
const COUNTRY_CENTROIDS = {
  "United States": [38.9, -77.0], "United Kingdom": [54.0, -2.0], "Russia": [55.7, 37.6],
  "Ukraine": [49.0, 31.0], "Israel": [31.5, 34.8], "Iran": [32.4, 53.7], "Iraq": [33.2, 43.7],
  "Syria": [34.8, 38.9], "Lebanon": [33.9, 35.5], "Yemen": [15.5, 48.5], "Saudi Arabia": [23.9, 45.1],
  "Turkey": [38.9, 35.2], "China": [35.8, 104.2], "India": [20.6, 78.9], "Pakistan": [30.4, 69.3],
  "Afghanistan": [33.9, 67.7], "Egypt": [26.8, 30.8], "Libya": [26.3, 17.2], "Sudan": [12.9, 30.2],
  "Mali": [17.6, -3.9], "Burkina Faso": [12.2, -1.5], "Nigeria": [9.0, 8.7], "Somalia": [5.2, 46.2],
  "Ethiopia": [9.1, 40.5], "Myanmar": [21.9, 95.9], "Taiwan": [23.7, 121.0], "Japan": [36.2, 138.3],
  "South Korea": [35.9, 127.8], "North Korea": [40.3, 127.5], "Philippines": [13.0, 122.0],
  "Germany": [51.2, 10.5], "France": [46.2, 2.2], "Poland": [51.9, 19.1], "Romania": [45.9, 24.9],
  "Australia": [-25.3, 133.8], "Canada": [56.1, -106.3], "Mexico": [23.6, -102.6], "Brazil": [-14.2, -51.9],
};

// ---------- U.S. Programs scanner ----------
const US_PROGRAM_FEEDS = [
  { name: "GN: drone as first responder",   url: "https://news.google.com/rss/search?q=%22drone+as+first+responder%22+police&hl=en-US&gl=US&ceid=US:en" },
  { name: "GN: DFR program launch",         url: "https://news.google.com/rss/search?q=%22DFR+program%22+launch&hl=en-US&gl=US&ceid=US:en" },
  { name: "GN: police drone announcement",  url: "https://news.google.com/rss/search?q=%22police+drone%22+program+announcement&hl=en-US&gl=US&ceid=US:en" },
  { name: "GN: fire department drone",      url: "https://news.google.com/rss/search?q=%22fire+department%22+drone+program&hl=en-US&gl=US&ceid=US:en" },
  { name: "GN: vendor police announcement", url: "https://news.google.com/rss/search?q=Skydio+OR+BRINC+police+announcement&hl=en-US&gl=US&ceid=US:en" },
  { name: "GN: counter-UAS municipal",      url: "https://news.google.com/rss/search?q=%22counter-UAS%22+municipal&hl=en-US&gl=US&ceid=US:en" },
  { name: "PR Newswire: public safety",     url: "https://www.prnewswire.com/rss/policy-public-interest/public-safety-news.rss" },
  { name: "sUAS News (US scan)",            url: "https://www.suasnews.com/feed/" },
  { name: "DroneLife (US scan)",            url: "https://dronelife.com/feed/" },
  { name: "Unmanned Airspace (US scan)",    url: "https://www.unmannedairspace.info/feed/" },
];

async function classifyUSPrograms(env, items) {
  const list = items.map((it, i) => `[${i}] SOURCE: ${it.source} | TITLE: ${it.title} | DESC: ${it.description}`).join("\n");
  const sys = "You are an OSINT analyst extracting U.S. municipal drone-program records from news/press-release headlines. Return only a JSON array, no prose, no markdown fences. Filter strictly: only items announcing or describing a U.S. city/county drone program (police, fire, public safety) qualify.";
  const user = `For each item, return a JSON object with these fields:

- index (integer matching the input index)
- is_us_program (boolean: true ONLY if the item is about a U.S. municipal drone program)
- city (string, the U.S. city the program is in, e.g. "Chula Vista")
- state (2-letter U.S. state code, e.g. "CA")
- agency (one of "Police Department", "Fire Department", "Public Safety", "Other")
- program_type (one of "DFR", "Municipal UAS", "Counter-UAS", "Other")
- launch_date_iso (YYYY-MM-DD if announced/known, else null)
- vendor (one of "Skydio", "BRINC", "Axon", "DJI", "other", null)
- avg_response_min (number or null — only if explicitly stated)
- summary (one sentence, <=200 chars)

Rules:
- Set is_us_program=false for non-U.S. items, vendor product launches without a city, opinion pieces, or international coverage.
- For DFR programs (drone responds before patrol arrives), the typical avg_response_min is 2.5 — only include if the article explicitly states a number; otherwise null.
- Use null (not "Unknown") for unknown fields.

Return ONLY a JSON array. No prose. No code fences.

Items:
${list}`;

  const model = env.MODEL || "claude-haiku-4-5-20251001";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Claude (US programs) ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  let text = (data.content?.[0]?.text || "[]").trim();
  text = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end !== -1) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

// Approximate centroid lookup for U.S. cities the model identifies. We don't
// keep a 30k-row geocoder in the worker — instead we fall back to a small
// state-centroid table when city geocoding isn't worth shipping.
const US_STATE_CENTROIDS = {
  AL:[32.806,-86.791], AK:[61.370,-152.404], AZ:[33.729,-111.431], AR:[34.969,-92.373],
  CA:[36.116,-119.681], CO:[39.059,-105.311], CT:[41.597,-72.755], DE:[39.318,-75.507],
  FL:[27.766,-81.686], GA:[33.040,-83.643], HI:[21.094,-157.498], ID:[44.240,-114.479],
  IL:[40.349,-88.986], IN:[39.849,-86.258], IA:[42.011,-93.210], KS:[38.526,-96.726],
  KY:[37.668,-84.670], LA:[31.169,-91.867], ME:[44.693,-69.381], MD:[39.063,-76.802],
  MA:[42.230,-71.530], MI:[43.327,-84.536], MN:[45.694,-93.900], MS:[32.741,-89.678],
  MO:[38.456,-92.288], MT:[46.921,-110.454], NE:[41.125,-98.268], NV:[38.313,-117.055],
  NH:[43.452,-71.564], NJ:[40.298,-74.521], NM:[34.840,-106.248], NY:[42.165,-74.948],
  NC:[35.630,-79.806], ND:[47.528,-99.784], OH:[40.388,-82.764], OK:[35.565,-96.928],
  OR:[44.572,-122.070], PA:[40.590,-77.209], RI:[41.680,-71.511], SC:[33.857,-80.945],
  SD:[44.299,-99.439], TN:[35.747,-86.692], TX:[31.054,-97.563], UT:[40.150,-111.862],
  VT:[44.045,-72.710], VA:[37.769,-78.170], WA:[47.400,-121.490], WV:[38.491,-80.954],
  WI:[44.268,-89.616], WY:[42.756,-107.302], DC:[38.897,-77.026],
};

async function fetchUSProgramsLive(env, log, dedupeAgainst) {
  const fetched = [];
  await Promise.all(US_PROGRAM_FEEDS.map(async (feed) => {
    try {
      const got = await fetchAndParseFeed({ ...feed, category: "us_programs" }, 6);
      fetched.push(...got);
      log.push({ ts: new Date().toISOString(), kind: "us_feed_ok", feed: feed.name, count: got.length });
    } catch (e) {
      log.push({ ts: new Date().toISOString(), kind: "us_feed_err", feed: feed.name, error: String(e.message || e) });
    }
  }));

  if (fetched.length === 0) return { items: [], error: "No US-program feeds returned items" };

  // Chunk and classify
  const CHUNK = 18;
  const chunks = [];
  for (let i = 0; i < fetched.length; i += CHUNK) chunks.push(fetched.slice(i, i + CHUNK));

  const recordsByKey = new Map();
  // Pre-load existing keys so we don't duplicate
  for (const k of (dedupeAgainst || [])) recordsByKey.set(k, true);

  const newRecords = [];
  for (const chunk of chunks) {
    try {
      const results = await classifyUSPrograms(env, chunk);
      log.push({ ts: new Date().toISOString(), kind: "us_claude_ok", chunk_size: chunk.length, returned: results.length });
      for (const r of results) {
        if (!r || typeof r !== "object" || !r.is_us_program) continue;
        if (!r.city || !r.state) continue;
        const key = `${r.city.trim().toLowerCase()}|${(r.state || "").toUpperCase()}|${(r.agency || "Other").toLowerCase()}`;
        if (recordsByKey.has(key)) continue;
        recordsByKey.set(key, true);
        const item = chunk[Number(r.index)];
        const centroid = US_STATE_CENTROIDS[(r.state || "").toUpperCase()];
        newRecords.push({
          city: r.city,
          state: (r.state || "").toUpperCase(),
          agency: r.agency || "Other",
          program_type: r.program_type || "Other",
          launch_date_iso: r.launch_date_iso || null,
          vendor: r.vendor || null,
          avg_response_min: typeof r.avg_response_min === "number" ? r.avg_response_min : null,
          summary: r.summary || (item?.title || ""),
          source_name: item?.source || "Live agent",
          source_url: item?.link || null,
          extracted_at: new Date().toISOString(),
          lat: centroid ? centroid[0] : null,
          lon: centroid ? centroid[1] : null,
          live: true,
        });
      }
    } catch (e) {
      log.push({ ts: new Date().toISOString(), kind: "us_claude_err", error: String(e.message || e) });
    }
  }

  return { items: newRecords, error: null };
}
// ---------- ACLED fetcher ----------
async function fetchAcledEvents(env, log) {
  if (!env.ACLED_API_KEY || !env.ACLED_EMAIL) {
    return { items: [], error: "ACLED credentials not set (ACLED_API_KEY + ACLED_EMAIL)" };
  }
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    key: env.ACLED_API_KEY,
    email: env.ACLED_EMAIL,
    event_date: `${fmt(weekAgo)}|${fmt(today)}`,
    event_date_where: "BETWEEN",
    notes: "drone",
    notes_where: "LIKE",
    limit: "200",
    format: "json",
  });
  const url = `https://api.acleddata.com/acled/read?${params.toString()}`;
  const res = await fetch(url, { headers: { "user-agent": "UAS-Latency-Index-Bot/1.0" } });
  if (!res.ok) return { items: [], error: `ACLED HTTP ${res.status}` };
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { return { items: [], error: "ACLED returned non-JSON: " + body.slice(0, 200) }; }
  if (!Array.isArray(data.data)) {
    return { items: [], error: data.error?.message || data.message || "ACLED returned no data array" };
  }
  const events = data.data.map(e => {
    const lat = parseFloat(e.latitude);
    const lon = parseFloat(e.longitude);
    const zone = [e.location, e.admin1, e.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
    return {
      id: `ACLED-${e.data_id}`,
      source: `ACLED · ${e.source || "unknown source"}`,
      origin: "acled",
      category: "structured",
      title: `${e.event_type || "event"}${e.sub_event_type ? " — " + e.sub_event_type : ""}`,
      link: e.source_link || `https://acleddata.com/data-export-tool/`,
      pubDate: e.event_date ? `${e.event_date}T00:00:00Z` : "",
      description: (e.notes || "").slice(0, 500),
      // Pre-classified — bypass Claude:
      is_drone_related: true,
      conflict_zone: zone || e.country || null,
      country: e.country || null,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      drone_class: "unknown",
      response_type: ACLED_RESPONSE_MAP[e.event_type] || "unknown",
      reported_latency_seconds: null,
      triad_lens: "accelerationist",
      summary: (e.notes || "").slice(0, 200),
      fatalities: parseInt(e.fatalities) || 0,
      extracted_at: new Date().toISOString(),
    };
  });
  return { items: events, error: null, raw_count: data.count };
}

// ---------- GDELT fetcher (no auth required) ----------
async function fetchGdeltArticles() {
  const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=drone%20attack%20OR%20%22counter-UAS%22%20OR%20loitering%20munition&mode=artlist&format=json&maxrecords=75&timespan=24h";
  const res = await fetch(url, { headers: { "user-agent": "UAS-Latency-Index-Bot/1.0" } });
  if (!res.ok) return { items: [], error: `GDELT HTTP ${res.status}` };
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { return { items: [], error: "GDELT returned non-JSON: " + body.slice(0, 200) }; }
  const articles = Array.isArray(data.articles) ? data.articles : [];
  let counter = 0;
  const items = articles.map(a => {
    const country = a.sourcecountry;
    const centroid = COUNTRY_CENTROIDS[country];
    if (!centroid) return null; // skip un-geocodable items
    counter += 1;
    const seenDate = a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}T${a.seendate.slice(9, 11)}:${a.seendate.slice(11, 13)}:${a.seendate.slice(13, 15)}Z` : "";
    return {
      id: `GDELT-${counter.toString().padStart(4, "0")}`,
      source: `GDELT · ${a.domain || "unknown domain"}`,
      origin: "gdelt",
      category: "wire",
      title: a.title || "",
      link: a.url || "",
      pubDate: seenDate,
      description: (a.title || "").slice(0, 500),
      is_drone_related: true,
      conflict_zone: country,
      country,
      lat: centroid[0],
      lon: centroid[1],
      drone_class: "unknown",
      response_type: "unknown",
      reported_latency_seconds: null,
      triad_lens: "accelerationist",
      summary: (a.title || "").slice(0, 200),
      extracted_at: new Date().toISOString(),
    };
  }).filter(Boolean);
  return { items, error: null, raw_count: articles.length, geocoded_count: items.length };
}

/* ---------- RSS fetching ---------- */

async function fetchAndParseFeed(feed, count) {
  // Workers can fetch RSS directly — no CORS proxy needed server-side.
  const res = await fetch(feed.url, {
    headers: { "user-agent": "UAS-Latency-Index-Bot/1.0 (+https://github.com)" },
  });
  if (!res.ok) throw new Error(`${feed.name}: HTTP ${res.status}`);
  const xml = await res.text();
  return parseRssXml(xml, feed, count);
}

function parseRssXml(xml, feed, count) {
  // Lightweight regex parser — works for both RSS 2.0 (<item>) and Atom (<entry>).
  const itemRegex = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const items = [];
  let match;
  while ((match = itemRegex.exec(xml)) && items.length < count) {
    const block = match[2];
    const get = (tag) => {
      const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
      return m ? m[1].trim() : "";
    };
    const cdata = (s) => s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
    let link = cdata(get("link"));
    if (!link) {
      const m = /<link\b[^>]*href="([^"]+)"/i.exec(block);
      link = m ? m[1] : "";
    }
    items.push({
      source: feed.name,
      category: feed.category,
      title: cdata(get("title")),
      link,
      pubDate: cdata(get("pubDate") || get("published") || get("updated")),
      description: stripHtml(cdata(get("description") || get("summary") || get("content"))).slice(0, 500),
    });
  }
  return items;
}

/* ---------- Claude classification ---------- */

async function classifyChunk(env, items) {
  const list = items.map((it, i) => `[${i}] SOURCE: ${it.source} | TITLE: ${it.title} | DESC: ${it.description}`).join("\n");
  const sys = "You are a defense OSINT analyst classifying news items. Return only a JSON array, no prose, no markdown fences. Make confident geographic inferences from context — do not return null for conflict_zone, country, lat, or lon unless the item provides truly zero geographic signal.";
  const user = `Below are RSS items. For each, return one JSON object with these fields:

- index (integer matching the input index)
- is_drone_related (boolean: true only if substantively about uncrewed aerial systems / drones / UAS / UAV / loitering munitions / counter-drone)
- conflict_zone (string)
- country (full country name)
- lat (number)
- lon (number)
- drone_class (one of "one-way attack", "ISR", "loitering munition", "quadcopter", "fixed-wing", "swarm", "unknown")
- response_type (one of "kinetic", "EW/jamming", "passive", "none", "unknown")
- reported_latency_seconds (number or null — only if the item explicitly states a response time)
- triad_lens (one of "accelerationist", "safetyist", "skeptic")
- summary (one sentence, <=200 chars)

INFERENCE RULES — apply aggressively:
- "Ukraine" / "Donetsk" / "Kharkiv" → Eastern Ukraine, ~48.5, 37.8
- "Red Sea" / "Houthi" → Red Sea Shipping Lane, Yemen, 13.5, 43.0
- "Israel" / "IDF" / "Hezbollah" → Israeli Northern Border, Israel, 33.1, 35.6
- "Iran" / "IRGC" → Persian Gulf, Iran, 26.5, 51.5
- ISW with no other signal → default Eastern Ukraine
- Pentagon / DoD policy → United States, 38.9, -77.0
- Only return null when truly geographically silent.

Return ONLY a JSON array. No prose. No code fences.

Items:
${list}`;

  const model = env.MODEL || "claude-haiku-4-5-20251001";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Claude ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  let text = (data.content?.[0]?.text || "[]").trim();
  text = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end !== -1) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

/* ---------- Sweep orchestrator ---------- */

async function runSweep(env, log) {
  const itemsPerFeed = Number(env.ITEMS_PER_FEED || 5);
  const fetched = [];
  const fetchErrors = [];

  await Promise.all(FEEDS.map(async (feed) => {
    try {
      const got = await fetchAndParseFeed(feed, itemsPerFeed);
      fetched.push(...got);
      log.push({ ts: new Date().toISOString(), kind: "feed_ok", feed: feed.name, count: got.length });
    } catch (e) {
      fetchErrors.push({ feed: feed.name, error: String(e.message || e) });
      log.push({ ts: new Date().toISOString(), kind: "feed_err", feed: feed.name, error: String(e.message || e) });
    }
  }));

  // Chunk to keep prompts under ~30k chars
  const CHUNK = 18;
  const chunks = [];
  for (let i = 0; i < fetched.length; i += CHUNK) chunks.push(fetched.slice(i, i + CHUNK));

  const rssClassified = [];
  let counter = 0;
  for (const chunk of chunks) {
    try {
      const results = await classifyChunk(env, chunk);
      log.push({ ts: new Date().toISOString(), kind: "claude_ok", chunk_size: chunk.length, returned: results.length });
      for (const r of results) {
        if (!r || typeof r !== "object" || !r.is_drone_related) continue;
        const item = chunk[Number(r.index)];
        if (!item) continue;
        counter += 1;
        rssClassified.push({
          ...item,
          ...r,
          id: `DEF-${String(counter).padStart(4, "0")}`,
          origin: "rss",
          extracted_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      log.push({ ts: new Date().toISOString(), kind: "claude_err", error: String(e.message || e) });
    }
  }

  // ACLED — structured, no Claude needed
  let acledItems = [];
  try {
    const r = await fetchAcledEvents(env, log);
    if (r.error) {
      log.push({ ts: new Date().toISOString(), kind: "acled_err", error: r.error });
    } else {
      acledItems = r.items;
      log.push({ ts: new Date().toISOString(), kind: "acled_ok", count: r.items.length, raw_count: r.raw_count });
    }
  } catch (e) {
    log.push({ ts: new Date().toISOString(), kind: "acled_err", error: String(e.message || e) });
  }

  // GDELT — no auth required
  let gdeltItems = [];
  try {
    const r = await fetchGdeltArticles();
    if (r.error) {
      log.push({ ts: new Date().toISOString(), kind: "gdelt_err", error: r.error });
    } else {
      gdeltItems = r.items;
      log.push({ ts: new Date().toISOString(), kind: "gdelt_ok", geocoded: r.geocoded_count, raw_count: r.raw_count });
    }
  } catch (e) {
    log.push({ ts: new Date().toISOString(), kind: "gdelt_err", error: String(e.message || e) });
  }

  const classified = [...rssClassified, ...acledItems, ...gdeltItems];
  const sources = {
    rss: rssClassified.length,
    acled: acledItems.length,
    gdelt: gdeltItems.length,
  };

  // U.S. Programs sweep — independent of defense feed, but runs in same cron.
  let usPrograms = [];
  try {
    const existing = (await env.STORE.get("us_programs", "json")) || [];
    const dedupeKeys = existing.map(p => `${(p.city || "").toLowerCase()}|${(p.state || "").toUpperCase()}|${(p.agency || "Other").toLowerCase()}`);
    const r = await fetchUSProgramsLive(env, log, dedupeKeys);
    if (r.error) {
      log.push({ ts: new Date().toISOString(), kind: "us_programs_err", error: r.error });
    } else {
      usPrograms = [...existing, ...r.items].slice(-500); // cap at 500 to keep KV value reasonable
      log.push({ ts: new Date().toISOString(), kind: "us_programs_ok", new_records: r.items.length, total_records: usPrograms.length });
    }
  } catch (e) {
    log.push({ ts: new Date().toISOString(), kind: "us_programs_err", error: String(e.message || e) });
  }
  sources.us_programs_total = usPrograms.length;

  if (classified.length === 0 && usPrograms.length === 0) {
    return { error: "No items from any source", fetchErrors, classified: [], sources, us_programs: [] };
  }

  return { classified, fetchErrors, raw_fetched: fetched.length, sources, us_programs: usPrograms };
}

/* ---------- Worker entrypoints ---------- */

async function persistResult(env, payload) {
  await env.STORE.put("latest", JSON.stringify(payload));
  if (Array.isArray(payload.us_programs)) {
    await env.STORE.put("us_programs", JSON.stringify(payload.us_programs));
  }
  // Also keep last 30 sweeps for an evolving record (Option B "evolving picture")
  const idx = await env.STORE.get("history_index", "json") || [];
  const stamp = payload.generated_at;
  await env.STORE.put(`history:${stamp}`, JSON.stringify(payload));
  idx.unshift(stamp);
  while (idx.length > 30) {
    const oldStamp = idx.pop();
    await env.STORE.delete(`history:${oldStamp}`);
  }
  await env.STORE.put("history_index", JSON.stringify(idx));
}

export default {
  async scheduled(event, env, ctx) {
    const log = [];
    const out = await runSweep(env, log);
    const payload = {
      generated_at: new Date().toISOString(),
      trigger: "cron",
      cron: event.cron,
      ...out,
      log,
    };
    ctx.waitUntil(persistResult(env, payload));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-admin-token",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // GET /api/items — returns the latest stored sweep
    if (url.pathname === "/api/items" && request.method === "GET") {
      const stored = await env.STORE.get("latest");
      if (!stored) return json({ error: "no sweep yet — wait for cron or trigger /api/run" }, 404, cors);
      return new Response(stored, { headers: { "content-type": "application/json", ...cors } });
    }

    // GET /api/us-programs — returns the deduped accumulated U.S. programs index
    if (url.pathname === "/api/us-programs" && request.method === "GET") {
      const stored = await env.STORE.get("us_programs");
      const programs = stored ? JSON.parse(stored) : [];
      return json({ generated_at: new Date().toISOString(), programs }, 200, cors);
    }

    // GET /api/history — list of sweep timestamps
    if (url.pathname === "/api/history" && request.method === "GET") {
      const idx = (await env.STORE.get("history_index", "json")) || [];
      return json({ sweeps: idx }, 200, cors);
    }

    // GET /api/history/:stamp — a specific historical sweep
    if (url.pathname.startsWith("/api/history/") && request.method === "GET") {
      const stamp = decodeURIComponent(url.pathname.slice("/api/history/".length));
      const stored = await env.STORE.get(`history:${stamp}`);
      if (!stored) return json({ error: "not found" }, 404, cors);
      return new Response(stored, { headers: { "content-type": "application/json", ...cors } });
    }

    // POST /api/run — admin-triggered sweep (requires x-admin-token header matching env.ADMIN_TOKEN)
    if (url.pathname === "/api/run" && request.method === "POST") {
      if (!env.ADMIN_TOKEN || request.headers.get("x-admin-token") !== env.ADMIN_TOKEN) {
        return json({ error: "unauthorized" }, 401, cors);
      }
      const log = [];
      const out = await runSweep(env, log);
      const payload = {
        generated_at: new Date().toISOString(),
        trigger: "manual",
        ...out,
        log,
      };
      ctx.waitUntil(persistResult(env, payload));
      return json(payload, 200, cors);
    }

    // GET / — tiny landing page
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(landingHtml(), {
        headers: { "content-type": "text/html; charset=utf-8", ...cors },
      });
    }

    return json({ error: "not found", routes: ["/api/items", "/api/us-programs", "/api/history", "/api/history/:stamp", "POST /api/run"] }, 404, cors);
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json", ...(headers || {}) },
  });
}

function landingHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<title>UAS Latency Index — Backend</title>
<style>
  body { font-family: 'Courier New', Courier, monospace; background:#0a0a0a; color:#eee; padding:2rem; max-width:760px; margin:auto; }
  a { color:#ef4444; }
  code { background:#1a1a1a; padding:2px 6px; border-radius:3px; }
</style>
<h1>UAS Response Latency Index — Autonomous Agent</h1>
<p>Cloudflare Worker that polls 9 defense / OSINT / trade-press RSS feeds on a cron schedule, classifies items via Claude, and stores them in KV.</p>
<h2>Endpoints</h2>
<ul>
  <li><a href="/api/items">/api/items</a> — latest defense/conflict feed sweep, JSON</li>
  <li><a href="/api/us-programs">/api/us-programs</a> — deduped accumulated U.S. municipal drone programs</li>
  <li><a href="/api/history">/api/history</a> — list of historical sweeps</li>
  <li><code>POST /api/run</code> — admin-triggered sweep (requires <code>x-admin-token</code>)</li>
</ul>
<p>Source: this worker is part of the UAS Response Latency Index project for Option B (Brief Paper + Agentic Implementation).</p>`;
}
