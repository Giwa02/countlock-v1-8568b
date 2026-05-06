import { Resend } from "resend";
import { supabase, orgId, json, readJson } from "./_supabase.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = readJson(event);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { kitId, action } = body;
  if (!kitId) return json({ error: "kitId is required" }, 400);

  try {
    if (action === "finish") return await finishKit(kitId);
    if (action === "reopen") return await reopenKit(kitId);
    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error("kits function failed:", error);
    return json({ error: error.message || "Kit action failed" }, 500);
  }
}

async function finishKit(kitId) {
  const db = supabase();

  // Tenancy + load kit in one round trip
  const { data: assertResult, error: assertError } = await db.rpc(
    "assert_kit_in_org",
    { p_kit_id: kitId, p_org_id: orgId() }
  );
  if (assertError) {
    if (assertError.code === "P0002") return json({ error: "Kit not found" }, 404);
    throw assertError;
  }
  const kit = Array.isArray(assertResult) ? assertResult[0] : assertResult;
  if (!kit) return json({ error: "Kit not found" }, 404);
  if (kit.status === "locked") return json({ error: "Kit already locked" }, 409);

  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id, name")
    .eq("id", kit.project_id)
    .single();
  if (projectError) throw projectError;

  const [partsRes, countsRes] = await Promise.all([
    db
      .from("project_parts")
      .select("part_id, expected, position")
      .eq("project_id", kit.project_id)
      .order("position"),
    db
      .from("kit_counts")
      .select("part_id, count, confidence, mode, counted_at")
      .eq("kit_id", kitId),
  ]);
  if (partsRes.error) throw partsRes.error;
  if (countsRes.error) throw countsRes.error;

  const countMap = new Map((countsRes.data || []).map((c) => [c.part_id, c]));

  const mismatches = [];
  const incompleteParts = [];
  for (const p of partsRes.data || []) {
    const c = countMap.get(p.part_id);
    if (!c) {
      incompleteParts.push(p.part_id);
      continue;
    }
    if (Number(c.count) !== Number(p.expected)) {
      mismatches.push({
        partId: p.part_id,
        expected: Number(p.expected),
        detected: Number(c.count),
        confidence: c.confidence,
      });
    }
  }

  const reviewNote =
    mismatches.length || incompleteParts.length
      ? buildReviewNote(kit.name, mismatches, incompleteParts)
      : "Pass";

  const lockedAt = new Date().toISOString();

  const { error: lockError } = await db
    .from("kits")
    .update({ status: "locked", locked_at: lockedAt, review_note: reviewNote })
    .eq("id", kitId);
  if (lockError) throw lockError;

  const emailResult = await maybeSendEmail({
    project,
    kit,
    lockedAt,
    mismatches,
    incompleteParts,
  });

  return json({
    kitId,
    locked: true,
    lockedAt,
    mismatches,
    incompleteParts,
    reviewNote,
    email: emailResult,
  });
}

async function reopenKit(kitId) {
  const db = supabase();

  // Atomic reopen RPC: tenancy check + status guard + atomic increment.
  // Prevents both cross-tenant access and the read-then-write race that
  // could lose a reopen_count tick under concurrent requests.
  const { data: result, error } = await db.rpc("reopen_kit", {
    p_kit_id: kitId,
    p_org_id: orgId(),
  });

  if (error) {
    if (error.code === "P0002") {
      // Could be "kit not found in org" or "kit not locked"
      const message = error.message?.includes("not locked")
        ? "Only locked kits can be re-opened"
        : "Kit not found";
      return json({ error: message }, 409);
    }
    throw error;
  }

  const kit = Array.isArray(result) ? result[0] : result;
  return json({
    kitId,
    status: "open",
    reopenedAt: kit?.reopened_at,
    reopenCount: kit?.reopen_count,
  });
}

function buildReviewNote(kitName, mismatches, incompleteParts) {
  const parts = [];
  if (mismatches.length) {
    parts.push(`Review ${kitName} part ${mismatches.map((m) => m.partId).join(",")}`);
  }
  if (incompleteParts.length) {
    parts.push(`Missing parts: ${incompleteParts.join(",")}`);
  }
  return parts.join(". ");
}

async function maybeSendEmail({ project, kit, lockedAt, mismatches, incompleteParts }) {
  const needsReview = mismatches.length > 0 || incompleteParts.length > 0;
  if (!needsReview) return { sent: false, reason: "No review needed" };
  if (!process.env.RESEND_API_KEY || !process.env.SUPERVISOR_EMAIL) {
    return { sent: false, reason: "Email not configured" };
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.FROM_EMAIL || "CountLock <onboarding@resend.dev>";

    const mismatchLines = mismatches
      .map(
        (m) =>
          `Part ${m.partId}: expected ${m.expected}, detected ${m.detected}` +
          (m.confidence ? ` (${(Number(m.confidence) * 100).toFixed(1)}% confidence)` : "")
      )
      .join("\n");

    const subject = `Kit count review needed: ${project.name} / ${kit.name}`;
    const text = [
      `Project: ${project.name}`,
      `Kit: ${kit.name}`,
      `Locked at: ${lockedAt}`,
      "",
      incompleteParts.length
        ? `Incomplete: missing parts ${incompleteParts.join(", ")}`
        : null,
      "",
      "Mismatches:",
      mismatchLines || "(none)",
      "",
      "Action: review before shipping.",
    ]
      .filter((line) => line !== null)
      .join("\n");

    await resend.emails.send({
      from,
      to: process.env.SUPERVISOR_EMAIL,
      subject,
      text,
    });

    return { sent: true };
  } catch (error) {
    console.error("Email send failed:", error);
    return { sent: false, reason: error.message };
  }
}
