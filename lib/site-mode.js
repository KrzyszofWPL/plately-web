export async function getSiteMode() {
  const edgeConfig = process.env.EDGE_CONFIG;
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
  const edgeConfig = process.env.EDGE_CONFIG;
  const vercelToken = process.env.VERCEL_API_TOKEN;
  if (!edgeConfig || !vercelToken) {
    throw new Error("Missing EDGE_CONFIG or VERCEL_API_TOKEN");
  }
  const id = new URL(edgeConfig).pathname.replace("/", "");
  const res = await fetch(`https://api.vercel.com/v1/edge-config/${id}/items`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items: [{ operation: "upsert", key: "mode", value: mode }] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge Config update failed: ${res.status} ${text}`);
  }
}
