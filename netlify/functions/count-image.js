import { supabase, orgId, json, readJson } from "./_supabase.js";

const MAX_IMAGE_BYTES = 5_000_000;

export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = readJson(event);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { kitId, partId, imageBase64, thumbnailBase64 } = body;
  if (!kitId || !partId || !imageBase64) {
    return json({ error: "kitId, partId, imageBase64 are all required" }, 400);
  }
  if (typeof imageBase64 !== "string") return json({ error: "imageBase64 must be a string" }, 400);
  if (imageBase64.length > MAX_IMAGE_BYTES) {
    return json({ error: `Image too large (max ${MAX_IMAGE_BYTES} bytes)` }, 413);
  }

  const db = supabase();

  const { data: kitArr, error: assertError } = await db.rpc("assert_kit_in_org", {
    p_kit_id: kitId, p_org_id: orgId(),
  });
  if (assertError) {
    if (assertError.code === "P0002") return json({ error: "Kit not found" }, 404);
    throw assertError;
  }
  const kit = Array.isArray(kitArr) ? kitArr[0] : kitArr;
  if (!kit) return json({ error: "Kit not found" }, 404);
  if (kit.status === "locked") return json({ error: "Kit is locked. Re-open it before capturing." }, 409);

  const { data: part, error: partError } = await db
    .from("project_parts")
    .select("part_id, expected")
    .eq("project_id", kit.project_id)
    .eq("part_id", partId)
    .single();
  if (partError || !part) return json({ error: `Part ${partId} is not in this project` }, 400);

  let result;
  try {
    result = await runDetection(imageBase64);
  } catch (error) {
    console.error("Detection failed:", error);
    return json({ error: `Detection failed: ${error.message}` }, 502);
  }

  // Store thumbnail alongside the count (used in email report).
  // Thumbnail is a small base64 JPEG captured at 320x240 / quality 0.3.
  const thumb = thumbnailBase64 || null;

  const { error: eventError } = await db.from("count_events").insert({
    kit_id: kitId, part_id: partId,
    count: result.count, confidence: result.confidence,
    mode: result.mode, predictions: result.predictions,
    thumbnail_data_url: thumb,
  });
  if (eventError) throw eventError;

  const { error: upsertError } = await db.from("kit_counts").upsert(
    {
      kit_id: kitId, part_id: partId,
      count: result.count, confidence: result.confidence,
      mode: result.mode, counted_at: new Date().toISOString(),
      thumbnail_data_url: thumb,
    },
    { onConflict: "kit_id,part_id" }
  );
  if (upsertError) throw upsertError;

  return json({
    count: result.count,
    confidence: result.confidence,
    mode: result.mode,
    expected: Number(part.expected),
    pass: Number(result.count) === Number(part.expected),
  });
}

async function runDetection(imageBase64) {
  const useRoboflow =
    process.env.MOCK_COUNT !== "true" &&
    process.env.ROBOFLOW_MODEL_URL &&
    process.env.ROBOFLOW_API_KEY;

  if (!useRoboflow) {
    const mockCount = 1 + Math.floor(Math.random() * 10);
    return { count: mockCount, confidence: 0.99, mode: "mock", predictions: [] };
  }

  const base64 = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
  let url;
  try {
    url = new URL(process.env.ROBOFLOW_MODEL_URL);
  } catch {
    throw new Error("ROBOFLOW_MODEL_URL is not a valid URL");
  }
  url.searchParams.set("api_key", process.env.ROBOFLOW_API_KEY);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: base64,
  });

  let result;
  try { result = await response.json(); }
  catch { throw new Error(`Roboflow returned non-JSON ${response.status}`); }
  if (!response.ok) throw new Error(result?.message || `Roboflow returned ${response.status}`);

  const threshold = Number(process.env.COUNT_CONFIDENCE_THRESHOLD || 0.65);
  const predictions = Array.isArray(result.predictions) ? result.predictions : [];
  const accepted = predictions.filter((p) => Number(p.confidence || 0) >= threshold);
  const avgConfidence =
    accepted.length === 0 ? 0
    : accepted.reduce((s, p) => s + Number(p.confidence || 0), 0) / accepted.length;

  return {
    count: accepted.length,
    confidence: Number(avgConfidence.toFixed(4)),
    mode: "roboflow",
    predictions: accepted,
  };
}
