/**
 * Proxy + recent-event lookup against Grokipedia.
 * grokipedia.com has no public JSON API and CSP connect-src 'self' blocks browser CORS,
 * so the static site calls this function instead. Failures return {events:[]} (baseline used).
 */
var https = require("https");

var UA = "FourTurningsNetlify/1.0 (+https://four-turnings.netlify.app)";

function get(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var req = https.get(
      url,
      { headers: { "User-Agent": UA, Accept: "text/html" }, timeout: timeoutMs || 2500 },
      function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location, timeoutMs).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error("HTTP " + res.statusCode));
          res.resume();
          return;
        }
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", function () {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseSearch(html) {
  var out = [];
  var re = /data-slug="([^"]+)"[^>]*data-search-result-link="true"[^>]*data-scroll-anchor-text="([^"]*)"/g;
  var m;
  while ((m = re.exec(html))) out.push({ slug: m[1], text: decode(m[2]) });
  if (!out.length) {
    re = /data-search-result-link="true"[^>]*data-slug="([^"]+)"[^>]*data-scroll-anchor-text="([^"]*)"/g;
    while ((m = re.exec(html))) out.push({ slug: m[1], text: decode(m[2]) });
  }
  if (!out.length) {
    re = /class="result-row[^"]*"\s+data-slug="([^"]+)"[^>]*data-scroll-anchor-text="([^"]*)"/g;
    while ((m = re.exec(html))) out.push({ slug: m[1], text: decode(m[2]) });
  }
  return out;
}

function yearFromText(text) {
  var m = String(text).match(/\b((?:1[4-9]|20)\d{2})\b/);
  if (!m) return null;
  var y = Number(m[1]);
  if (y < 1435 || y > 2115) return null;
  return y;
}

function labelFromSlug(slug) {
  return decode(slug)
    .replace(/_/g, " ")
    .replace(/%E2%80%93/gi, "–")
    .replace(/–/g, "–")
    .replace(/%27/g, "'")
    .slice(0, 40);
}

function isNoise(slug, text) {
  var s = String(slug || "").toLowerCase();
  var t = String(text || "").toLowerCase();
  if (/^\d{4}$/.test(s)) return true;
  if (/meistriliiga|damallsvenskan|scheldeprijs|iditarod|kakkonen|toppserien|athletissima|veikkausliiga|canneseries|flygsystem|lnfa|football|soccer|season|championship|league|cup|_mk$|yr4/.test(s)) return true;
  if (/in_(russia|belgium|israel|switzerland|asia|europe|africa|oceania)|pandemic_in_/.test(s)) return true;
  if (/corporate_responses|fortifications_of|lithuania_and|prelude_to|planning_for|reactions_to|sexual_violence|missing_tapes|in_popular_culture|commemorative/.test(s)) return true;
  if (/twitter_prediction|flags_of|horses_of|jewels_of|household_of/.test(s)) return true;
  if (/(league|championship|season of|football|soccer)/.test(t) && !/war|invasion|pandemic|attack|crisis/.test(t)) return true;
  return false;
}

function topicKey(slug, label) {
  var s = String(slug || label || "").toLowerCase();
  if (/capitol/.test(s) && /january|jan(uary)?_?6|6_january/.test(s)) return "jan6";
  if (/russian_invasion_of_ukraine|ukraine/.test(s) && /invasion|war/.test(s)) return "ukraine2022";
  if (/elizabeth_ii|elizabeth ii/.test(s) && /death|funeral|died/.test(s)) return "qeii2022";
  if (/israel.?hamas|hamas.?war/.test(s)) return "israelhamas2023";
  if (/covid|covid-19|coronavirus/.test(s) && !/in_/.test(s)) return "covid";
  return s.replace(/[^a-z0-9]+/g, "_").slice(0, 48);
}

// High-signal recent pages verified on Grokipedia (fast path / always included when in range).
var KNOWN = [
  {
    slug: "January_6_United_States_Capitol_attack",
    label: "Jan 6 Capitol",
    year: 2021,
    detail: "January 6, 2021 attack on the U.S. Capitol (Grokipedia)."
  },
  {
    slug: "Russian_invasion_of_Ukraine",
    label: "Ukraine invasion",
    year: 2022,
    detail: "Full-scale Russian invasion of Ukraine escalated 24 February 2022 (Grokipedia)."
  },
  {
    slug: "Death_and_state_funeral_of_Elizabeth_II",
    label: "Elizabeth II dies",
    year: 2022,
    detail: "Elizabeth II died 8 September 2022 at Balmoral Castle (Grokipedia)."
  },
  {
    slug: "Israel–Hamas_war",
    label: "Israel–Hamas war",
    year: 2023,
    detail: "Israel–Hamas war beginning October 2023 (Grokipedia)."
  }
];

var SEARCH_QUERIES = [
  "January 6 United States Capitol attack",
  "Russian invasion of Ukraine",
  "Death and state funeral of Elizabeth II",
  "Israel Hamas war"
];

exports.handler = async function (event) {
  var headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=86400",
    "Netlify-CDN-Cache-Control": "public, max-age=86400, durable"
  };
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: Object.assign({ "Access-Control-Allow-Methods": "GET,OPTIONS" }, headers),
      body: ""
    };
  }
  try {
    var nowY = new Date().getFullYear();
    var qs = event.queryStringParameters || {};
    var fromY = null;
    var toY = null;
    if (qs.from != null && isFinite(Number(qs.from))) fromY = Math.floor(Number(qs.from));
    if (qs.to != null && isFinite(Number(qs.to))) toY = Math.floor(Number(qs.to));
    var since = Math.max(2015, nowY - 8);
    try {
      var qSince = qs.since;
      if (qSince && isFinite(Number(qSince))) {
        since = Math.min(nowY, Math.max(2015, Math.floor(Number(qSince)) - 6));
      }
    } catch (e) {}
    if (fromY != null) since = fromY;
    var until = (toY != null) ? toY : (nowY + 1);
    if (until < since) { var tmp = since; since = until; until = tmp; }

    var byTopic = {};
    function add(ev, force) {
      if (!ev || !ev.year || !ev.label) return;
      if (ev.year < since || ev.year > until) return;
      if (!force && isNoise(ev.slug || "", ev.detail || "")) return;
      var topic = topicKey(ev.slug || "", ev.label);
      var row = {
        label: String(ev.label).slice(0, 36),
        year: ev.year,
        detail: ev.detail || (ev.label + " (" + ev.year + ", Grokipedia)."),
        source: ev.source || ("https://grokipedia.com/page/" + encodeURIComponent(ev.slug || ev.label)),
        slug: ev.slug || null
      };
      var prev = byTopic[topic];
      if (!prev || force) {
        byTopic[topic] = row;
        return;
      }
      var prevLen = (prev.slug || "").length;
      var nextLen = (row.slug || "").length;
      if (nextLen && (!prevLen || nextLen < prevLen)) byTopic[topic] = row;
    }

    var queries = SEARCH_QUERIES.slice();
    // For a zoomed historical window, also probe the midpoint / endpoints
    if (fromY != null && toY != null && (toY - fromY) <= 80) {
      var mid = Math.round((fromY + toY) / 2);
      queries = [String(fromY), String(mid), String(toY), fromY + " history", mid + " war"].concat(queries);
    }

    await Promise.all(
      queries.slice(0, 8).map(function (q) {
        var url = "https://grokipedia.com/search?q=" + encodeURIComponent(q);
        return get(url, 2200)
          .then(function (html) {
            var rows = parseSearch(html);
            // Prefer the first non-noise result for this query
            for (var i = 0; i < rows.length && i < 6; i++) {
              var row = rows[i];
              if (isNoise(row.slug, row.text)) continue;
              var year = yearFromText(row.text) || yearFromText(row.slug);
              if (!year) continue;
              add({
                slug: row.slug,
                label: labelFromSlug(row.slug),
                year: year,
                detail: (row.text || "").slice(0, 180) + " (Grokipedia).",
                source: "https://grokipedia.com/page/" + encodeURIComponent(row.slug)
              });
            }
          })
          .catch(function () {});
      })
    );

    // Seed known canonical pages last so they win topic collisions
    KNOWN.forEach(function (ev) { add(ev, true); });

    var events = Object.keys(byTopic)
      .map(function (k) { return byTopic[k]; })
      .sort(function (a, b) { return a.year - b.year || a.label.localeCompare(b.label); })
      .slice(0, 12);

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        source: "grokipedia",
        generatedAt: new Date().toISOString(),
        from: since,
        to: until,
        events: events
      })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ source: "error", events: [], error: String(err && err.message || err) })
    };
  }
};
