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
  var re = /data-slug="([^"]+)"\s+data-search-result-link="true"\s+data-scroll-anchor-text="([^"]*)"/g;
  var m;
  while ((m = re.exec(html))) {
    out.push({ slug: m[1], text: decode(m[2]) });
  }
  // fallback: looser attribute order
  if (!out.length) {
    re = /class="result-row[^"]*"\s+data-slug="([^"]+)"[^>]*data-scroll-anchor-text="([^"]*)"/g;
    while ((m = re.exec(html))) {
      out.push({ slug: m[1], text: decode(m[2]) });
    }
  }
  return out;
}

function yearFromText(text) {
  var m = String(text).match(/\b(20[1-2]\d)\b/);
  return m ? Number(m[1]) : null;
}

function labelFromSlug(slug) {
  return decode(slug)
    .replace(/_/g, " ")
    .replace(/%E2%80%93/g, "–")
    .replace(/%27/g, "'")
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); })
    .slice(0, 40);
}

// Seed queries for recent Anglo-American / world key events; plus year pages.
function buildQueries(nowY) {
  var qs = [
    "Russian invasion of Ukraine",
    "Death and state funeral of Elizabeth II",
    "COVID-19 pandemic",
    "Israel Hamas war",
    "January 6 United States Capitol attack"
  ];
  for (var y = Math.max(2015, nowY - 6); y <= nowY; y++) qs.push(String(y));
  return qs;
}

// Known high-signal recent pages (verified on Grokipedia) as a fast path.
var KNOWN = [
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
  }
];

exports.handler = async function (event) {
  var headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=86400",
    "Netlify-CDN-Cache-Control": "public, max-age=86400, durable"
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: Object.assign({ "Access-Control-Allow-Methods": "GET,OPTIONS" }, headers), body: "" };
  }
  try {
    var nowY = new Date().getFullYear();
    var since = nowY - 8;
    try {
      var qSince = event.queryStringParameters && event.queryStringParameters.since;
      if (qSince) {
        var n = Number(qSince);
        if (isFinite(n)) since = Math.min(nowY, Math.max(2000, Math.floor(n) - 6));
      }
    } catch (e) {}

    var byKey = {};
    function add(ev) {
      if (!ev || !ev.year || !ev.label) return;
      if (ev.year < since || ev.year > nowY + 1) return;
      var key = String(ev.label).toLowerCase() + "|" + ev.year;
      if (byKey[key]) return;
      byKey[key] = {
        label: ev.label,
        year: ev.year,
        detail: ev.detail || (ev.label + " (" + ev.year + ", Grokipedia)."),
        source: ev.source || ("https://grokipedia.com/page/" + encodeURIComponent(ev.slug || ev.label)),
        slug: ev.slug || null
      };
    }

    KNOWN.forEach(add);

    // Live search scrape (best-effort, short timeouts)
    var queries = buildQueries(nowY).slice(0, 6);
    await Promise.all(
      queries.map(function (q) {
        var url = "https://grokipedia.com/search?q=" + encodeURIComponent(q);
        return get(url, 2200)
          .then(function (html) {
            parseSearch(html).slice(0, 8).forEach(function (row) {
              var year = yearFromText(row.text) || yearFromText(row.slug);
              if (!year) return;
              // skip sports/season noise
              var slugL = row.slug.toLowerCase();
              if (/damallsvenskan|scheldeprijs|iditarod|kakkonen|toppserien|athletissima|veikkausliiga|canneseries|_mk$|yr4|football|soccer|season/.test(slugL)) return;
              if (/^\d{4}$/.test(row.slug)) return; // bare year pages
              add({
                slug: row.slug,
                label: labelFromSlug(row.slug).slice(0, 36),
                year: year,
                detail: (row.text || "").slice(0, 180) + " (Grokipedia).",
                source: "https://grokipedia.com/page/" + encodeURIComponent(row.slug)
              });
            });
          })
          .catch(function () {});
      })
    );

    var events = Object.keys(byKey)
      .map(function (k) { return byKey[k]; })
      .sort(function (a, b) { return a.year - b.year; })
      .slice(0, 24);

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        source: "grokipedia",
        generatedAt: new Date().toISOString(),
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
