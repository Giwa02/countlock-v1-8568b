import { Resend } from "resend";
import { supabase, orgId, json, readJson } from "./_supabase.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = readJson(event);
  if (!body) return json({ error: "Invalid JSON body" }, 400);
  const { kitId, action, operatorInitials } = body;
  if (!kitId) return json({ error: "kitId is required" }, 400);

  try {
    if (action === "finish") return await finishKit(kitId, operatorInitials || "");
    if (action === "reopen") return await reopenKit(kitId);
    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error("kits function failed:", error);
    return json({ error: error.message || "Kit action failed" }, 500);
  }
}

async function finishKit(kitId, operatorInitials) {
  const db = supabase();

  const { data: assertResult, error: assertError } = await db.rpc("assert_kit_in_org", {
    p_kit_id: kitId, p_org_id: orgId(),
  });
  if (assertError) {
    if (assertError.code === "P0002") return json({ error: "Kit not found" }, 404);
    throw assertError;
  }
  const kit = Array.isArray(assertResult) ? assertResult[0] : assertResult;
  if (!kit) return json({ error: "Kit not found" }, 404);
  if (kit.status === "locked") return json({ error: "Kit already locked" }, 409);

  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id, name, supervisor_emails")
    .eq("id", kit.project_id)
    .single();
  if (projectError) throw projectError;

  const [partsRes, countsRes] = await Promise.all([
    db.from("project_parts").select("part_id, expected, position")
      .eq("project_id", kit.project_id).order("position"),
    db.from("kit_counts")
      .select("part_id, count, confidence, mode, counted_at, thumbnail_data_url")
      .eq("kit_id", kitId),
  ]);
  if (partsRes.error) throw partsRes.error;
  if (countsRes.error) throw countsRes.error;

  const countMap = new Map((countsRes.data || []).map((c) => [c.part_id, c]));

  const partResults = (partsRes.data || []).map((p) => {
    const c = countMap.get(p.part_id);
    return {
      partId: p.part_id,
      expected: Number(p.expected),
      detected: c ? Number(c.count) : null,
      pass: c ? Number(c.count) === Number(p.expected) : false,
      missing: !c,
      confidence: c?.confidence ?? null,
      thumbnail: c?.thumbnail_data_url ?? null,
    };
  });

  const mismatches = partResults.filter((r) => !r.pass && !r.missing);
  const incompleteParts = partResults.filter((r) => r.missing).map((r) => r.partId);
  const allPass = mismatches.length === 0 && incompleteParts.length === 0;

  const reviewNote = allPass
    ? "Pass"
    : buildReviewNote(kit.name, mismatches, incompleteParts);

  const lockedAt = new Date().toISOString();

  const { error: lockError } = await db.from("kits")
    .update({
      status: "locked",
      locked_at: lockedAt,
      review_note: reviewNote,
      operator_initials: operatorInitials || null,
    })
    .eq("id", kitId);
  if (lockError) throw lockError;

  // Always send email — pass or fail — so supervisor has a complete record.
  const emailResult = await sendReport({
    project,
    kit: { ...kit, operator_initials: operatorInitials },
    lockedAt,
    partResults,
    allPass,
  });

  return json({
    kitId,
    locked: true,
    lockedAt,
    allPass,
    mismatches,
    incompleteParts,
    reviewNote,
    email: emailResult,
  });
}

async function reopenKit(kitId) {
  const db = supabase();
  const { data: result, error } = await db.rpc("reopen_kit", {
    p_kit_id: kitId, p_org_id: orgId(),
  });
  if (error) {
    if (error.code === "P0002") {
      return json({ error: error.message?.includes("not locked") ? "Only locked kits can be re-opened" : "Kit not found" }, 409);
    }
    throw error;
  }
  const kit = Array.isArray(result) ? result[0] : result;
  return json({ kitId, status: "open", reopenedAt: kit?.reopened_at, reopenCount: kit?.reopen_count });
}

function buildReviewNote(kitName, mismatches, incompleteParts) {
  const parts = [];
  if (mismatches.length) parts.push(`Review ${kitName} part ${mismatches.map((m) => m.partId).join(",")}`);
  if (incompleteParts.length) parts.push(`Missing parts: ${incompleteParts.join(",")}`);
  return parts.join(". ");
}

async function sendReport({ project, kit, lockedAt, partResults, allPass }) {
  const recipients = (project.supervisor_emails || []).filter(Boolean);
  if (recipients.length === 0) {
    // Fall back to SUPERVISOR_EMAIL env var if no per-project emails set
    const fallback = process.env.SUPERVISOR_EMAIL;
    if (fallback) recipients.push(fallback);
  }
  if (recipients.length === 0) return { sent: false, reason: "No supervisor emails configured" };
  if (!process.env.RESEND_API_KEY) return { sent: false, reason: "RESEND_API_KEY not set" };

  const initials = kit.operator_initials ? ` by ${kit.operator_initials}` : "";
  const status = allPass ? "✓ PASS" : "⚠ REVIEW NEEDED";
  const subject = `${status} — ${project.name} / ${kit.name}${initials}`;

  // Build HTML email with part table + inline thumbnail photos
  const partRows = partResults.map((r) => {
    const icon = r.missing ? "⬜" : r.pass ? "✅" : "❌";
    const detected = r.missing ? "—" : String(r.detected);
    const conf = r.confidence ? ` <span style="color:#888;font-size:11px">(${(r.confidence * 100).toFixed(0)}%)</span>` : "";
    return `
      <tr style="border-bottom:1px solid #e5e7eb">
        <td style="padding:8px 12px;font-weight:600">Part ${r.partId}</td>
        <td style="padding:8px 12px;text-align:center">${r.expected}</td>
        <td style="padding:8px 12px;text-align:center">${detected}${conf}</td>
        <td style="padding:8px 12px;text-align:center">${icon}</td>
      </tr>`;
  }).join("");

  // Thumbnail row — each part's capture photo side by side
  const thumbs = partResults.filter((r) => r.thumbnail);
  const thumbRow = thumbs.length === 0 ? "" : `
    <h3 style="margin:24px 0 12px;color:#374151;font-size:14px;text-transform:uppercase;letter-spacing:.05em">Capture Photos</h3>
    <table cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${thumbs.map((r) => `
          <td style="padding:4px 8px 4px 0;vertical-align:top;text-align:center">
            <div style="font-size:11px;font-weight:600;color:#6b7280;margin-bottom:4px">Part ${r.partId}</div>
            <img src="${r.thumbnail}" width="120" height="90"
              style="border-radius:6px;border:2px solid ${r.pass ? "#4ea372" : "#c2553a"};display:block"
              alt="Part ${r.partId}" />
            <div style="font-size:10px;margin-top:3px;color:${r.pass ? "#4ea372" : "#c2553a"}">${r.pass ? "PASS" : "MISMATCH"}</div>
          </td>`).join("")}
      </tr>
    </table>`;

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f9fafb;font-family:ui-sans-serif,system-ui,sans-serif">
<div style="max-width:680px;margin:32px auto;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden">

  <div style="background:${allPass ? "#1a2050" : "#7f1d1d"};padding:24px 32px">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.6);margin-bottom:6px">CountLock Report</div>
    <h1 style="margin:0;color:#fff;font-size:22px">${project.name}</h1>
    <div style="color:rgba(255,255,255,.8);margin-top:6px;font-size:15px">
      ${kit.name}${initials} &nbsp;·&nbsp; ${allPass ? "✓ All Pass" : "⚠ Review Needed"}
    </div>
  </div>

  <div style="padding:24px 32px">
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:8px">
      <tr>
        <td style="color:#6b7280;font-size:13px;padding:4px 0">Locked at</td>
        <td style="font-size:13px;padding:4px 0">${new Date(lockedAt).toLocaleString()}</td>
      </tr>
      ${kit.operator_initials ? `<tr><td style="color:#6b7280;font-size:13px;padding:4px 0">Operator</td><td style="font-size:13px;font-weight:600;padding:4px 0">${kit.operator_initials}</td></tr>` : ""}
    </table>

    <h3 style="margin:20px 0 10px;color:#374151;font-size:14px;text-transform:uppercase;letter-spacing:.05em">Parts Summary</h3>
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;border-collapse:collapse">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;font-weight:600">PART</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280;font-weight:600">EXPECTED</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280;font-weight:600">DETECTED</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280;font-weight:600">STATUS</th>
        </tr>
      </thead>
      <tbody>${partRows}</tbody>
    </table>

    ${thumbRow}
  </div>
</div>
</body>
</html>`;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.FROM_EMAIL || "CountLock <onboarding@resend.dev>";
    await resend.emails.send({ from, to: recipients, subject, html });
    return { sent: true, recipients };
  } catch (error) {
    console.error("Email send failed:", error);
    return { sent: false, reason: error.message };
  }
}
