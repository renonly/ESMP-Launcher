const { GITHUB_REPO } = require("./config");
let cache = { at: 0, data: [] };

async function get() {
  if (Date.now() - cache.at < 10 * 60 * 1000 && cache.data.length) return cache.data;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "lsmp-launcher" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error();
    const list = await res.json();
    cache = {
      at: Date.now(),
      data: list.filter((r) => !r.draft).map((r) => ({
        tag: r.tag_name, name: r.name || r.tag_name, date: r.published_at,
        body: (r.body || "").slice(0, 4000), url: r.html_url,
      })),
    };
  } catch {}
  return cache.data;
}

module.exports = { get };
