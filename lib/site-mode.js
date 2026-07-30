function connectionString() {
  // Vercel renamed Edge Config to Global Config; the env var name changed
  // (GLOBAL_CONFIG) but old projects/stores may still expose EDGE_CONFIG.
  return process.env.GLOBAL_CONFIG || process.env.EDGE_CONFIG;
}

export async function getSiteMode() {
  const edgeConfig = connectionString();
  if (!edgeConfig) return "live";
  try {
    const url = new URL(edgeConfig);
    const id = url.pathname.replace("/", "");
    const token = url.searchParams.get("token");
    const res = await fetch(`https://edge-config.vercel.com/${id}/item/mode?token=${token}`, {
      headers: { "cache-control": "no-store" },
    });
    if (res.status === 404) return "live";
    if (!res.ok) return "live";
    const value = await res.json();
    return value === "maintenance" ? "maintenance" : "live";
  } catch {
    return "live";
  }
}

export async function setSiteMode(mode) {
  const edgeConfig = connectionString();
  const vercelToken = process.env.VERCEL_API_TOKEN;
  if (!edgeConfig || !vercelToken) {
    throw new Error("Missing GLOBAL_CONFIG/EDGE_CONFIG or VERCEL_API_TOKEN");
  }
  const id = new URL(edgeConfig).pathname.replace("/", "");
  // Team-owned projects need the team id on Vercel API calls, or the API
  // returns 404 for resources the token can't otherwise see.
  const teamId = process.env.VERCEL_TEAM_ID;
  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  const endpoint = `https://api.vercel.com/v1/edge-config/${id}/items${qs}`;
  const headers = {
    Authorization: `Bearer ${vercelToken}`,
    "Content-Type": "application/json",
  };

  const patch = (operation) =>
    fetch(endpoint, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ items: [{ operation, key: "mode", value: mode }] }),
    });

  // "upsert" has been unreliable on some accounts/plans: it 404s instead of
  // creating the item. Try create first, then fall back to update.
  let res = await patch("create");
  if (!res.ok) {
    const first = await res.text();
    res = await patch("update");
    if (!res.ok) {
      const second = await res.text();
      throw new Error(
        `Edge Config update failed. create: ${first} | update: ${second}`
      );
    }
  }
}
