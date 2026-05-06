// Shared Supabase service-role client for Netlify functions.
// Service role bypasses RLS — required because the operator UI is unauthenticated for v1.
// Never expose the SERVICE_ROLE key to the browser.

import { createClient } from "@supabase/supabase-js";

let cached = null;

export function supabase() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Copy .env.example to .env."
    );
  }

  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: "countlock" },
  });

  return cached;
}

export function orgId() {
  const id = process.env.COUNTLOCK_ORG_ID;
  if (!id) throw new Error("COUNTLOCK_ORG_ID must be set to a public.orgs.id UUID");
  return id;
}

export function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

export function readJson(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return null;
  }
}
