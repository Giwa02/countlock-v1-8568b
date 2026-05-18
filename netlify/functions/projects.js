import { supabase, orgId, json, readJson } from "./_supabase.js";
import { buildProjectFromCsv } from "./_csv.js";

const MAX_CSV_BYTES = 1_000_000;

export async function handler(event) {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  try {
    if (method === "GET" && params.id) return await getProject(params.id);
    if (method === "GET") return await listProjects();
    if (method === "POST") return await createProject(event);
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("projects function failed:", error);
    return json({ error: error.message || "Projects request failed" }, 500);
  }
}

async function listProjects() {
  const db = supabase();
  const { data, error } = await db.from("projects")
    .select("id, name, csv_filename, created_at, supervisor_emails")
    .eq("org_id", orgId())
    .order("created_at", { ascending: false });
  if (error) throw error;

  const ids = data.map((p) => p.id);
  if (ids.length === 0) return json({ projects: [] });

  const { data: kits, error: kitsError } = await db.from("kits")
    .select("project_id, status").in("project_id", ids);
  if (kitsError) throw kitsError;

  const summaries = new Map(ids.map((id) => [id, { total: 0, locked: 0 }]));
  for (const kit of kits) {
    const s = summaries.get(kit.project_id);
    if (!s) continue;
    s.total += 1;
    if (kit.status === "locked") s.locked += 1;
  }

  return json({ projects: data.map((p) => ({ ...p, kitSummary: summaries.get(p.id) })) });
}

async function getProject(id) {
  const db = supabase();
  const { data: project, error: projectError } = await db.from("projects")
    .select("id, name, csv_filename, created_at, org_id, supervisor_emails")
    .eq("id", id).eq("org_id", orgId()).single();
  if (projectError) {
    if (projectError.code === "PGRST116") return json({ error: "Project not found" }, 404);
    throw projectError;
  }

  const [partsRes, kitsRes] = await Promise.all([
    db.from("project_parts").select("part_id, position, expected")
      .eq("project_id", id).order("position"),
    db.from("kits")
      .select("id, name, status, locked_at, reopened_at, reopen_count, review_note, created_at, operator_initials")
      .eq("project_id", id).order("created_at"),
  ]);
  if (partsRes.error) throw partsRes.error;
  if (kitsRes.error) throw kitsRes.error;

  const parts = partsRes.data || [];
  const kits = kitsRes.data || [];
  const kitIds = kits.map((k) => k.id);

  let counts = [];
  if (kitIds.length > 0) {
    const { data, error } = await db.from("kit_counts")
      .select("kit_id, part_id, count, confidence, mode, counted_at, thumbnail_data_url")
      .in("kit_id", kitIds);
    if (error) throw error;
    counts = data || [];
  }

  const countsByKit = new Map();
  for (const c of counts) {
    if (!countsByKit.has(c.kit_id)) countsByKit.set(c.kit_id, {});
    countsByKit.get(c.kit_id)[c.part_id] = {
      count: c.count, confidence: c.confidence,
      mode: c.mode, countedAt: c.counted_at,
      thumbnail: c.thumbnail_data_url,
    };
  }

  return json({
    project: {
      ...project,
      parts,
      kits: kits.map((k) => ({ ...k, counts: countsByKit.get(k.id) || {} })),
    },
  });
}

async function createProject(event) {
  const body = readJson(event);
  if (!body) return json({ error: "Invalid JSON body" }, 400);
  const { csvText, filename, supervisorEmails } = body;

  // Normalize supervisor emails
  const emails = (supervisorEmails || [])
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => e && e.includes("@"))
    .slice(0, 2);

  let parsed;

  if (body.parts && body.kitNames && body.name) {
    // Form-based creation: client sends parts + kitNames directly (no CSV)
    parsed = buildProjectFromForm(body);
  } else if (csvText) {
    // CSV upload path
    if (typeof csvText !== "string") return json({ error: "csvText must be a string" }, 400);
    if (csvText.length > MAX_CSV_BYTES) return json({ error: "CSV too large" }, 413);
    const fallbackName = (filename || "Uploaded Project").replace(/\.csv$/i, "");
    try {
      parsed = buildProjectFromCsv(csvText, fallbackName);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  } else {
    return json({ error: "Provide either csvText or name+parts+kitNames" }, 400);
  }

  const db = supabase();
  const { data: projectId, error: rpcError } = await db.rpc("create_project_atomic", {
    p_org_id: orgId(),
    p_name: parsed.name,
    p_csv_filename: filename || null,
    p_parts: parsed.parts.map((p) => ({ partId: p.partId, position: p.position, expected: p.expected })),
    p_kit_names: parsed.kitNames,
    p_supervisor_emails: emails,
  });

  if (rpcError) {
    if (rpcError.code === "23505") return json({ error: "A project with that name already exists" }, 409);
    throw rpcError;
  }

  return getProject(projectId);
}

function buildProjectFromForm(body) {
  const { name, parts, kitNames } = body;
  if (!name?.trim()) throw new Error("Project name is required");
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("At least one part is required");
  if (!Array.isArray(kitNames) || kitNames.length === 0) throw new Error("At least one kit name is required");

  const validatedParts = parts.map((p, i) => {
    const partId = String(p.partId || p.part_id || "").trim();
    const expected = parseInt(p.expected, 10);
    if (!partId) throw new Error(`Part at position ${i + 1} is missing a part number`);
    if (isNaN(expected) || expected < 0) throw new Error(`Expected count for part "${partId}" must be a non-negative integer`);
    return { partId, position: i + 1, expected };
  });

  const seenParts = new Set();
  for (const p of validatedParts) {
    if (seenParts.has(p.partId)) throw new Error(`Duplicate part number: "${p.partId}"`);
    seenParts.add(p.partId);
  }

  const uniqueKitNames = [...new Set(kitNames.map((k) => String(k).trim()).filter(Boolean))];
  if (uniqueKitNames.length === 0) throw new Error("At least one kit name is required");

  return { name: name.trim(), parts: validatedParts, kitNames: uniqueKitNames };
}
