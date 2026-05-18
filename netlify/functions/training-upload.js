// Upload a training photo from the operator's phone directly to a Roboflow
// dataset. Operator takes photos in CountLock; this function forwards them
// to Roboflow's upload API so the user never has to manually transfer files.
//
// Required env vars:
//   ROBOFLOW_API_KEY        — private API key from Roboflow Settings
//   ROBOFLOW_WORKSPACE_ID   — workspace slug from project URL
//   ROBOFLOW_PROJECT_ID     — project slug from project URL
//
// Roboflow upload endpoint:
//   POST https://api.roboflow.com/dataset/{workspace}/{project}/upload
//        ?api_key=KEY&name=FILE_NAME&split=train

import { json, readJson } from "./_supabase.js";

const MAX_IMAGE_BYTES = 5_000_000;

export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = readJson(event);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { imageBase64, projectName } = body;
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return json({ error: "imageBase64 is required" }, 400);
  }
  if (imageBase64.length > MAX_IMAGE_BYTES) {
    return json({ error: `Image too large (max ${MAX_IMAGE_BYTES} bytes)` }, 413);
  }

  const apiKey = process.env.ROBOFLOW_API_KEY;
  const workspace = process.env.ROBOFLOW_WORKSPACE_ID;
  const project = process.env.ROBOFLOW_PROJECT_ID;

  if (!apiKey || !workspace || !project) {
    return json(
      {
        error:
          "Roboflow not configured. Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE_ID, and ROBOFLOW_PROJECT_ID in Netlify env vars.",
      },
      501
    );
  }

  // Roboflow accepts raw base64 in the request body with the right content type.
  const base64 = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");

  // Unique image name so Roboflow doesn't dedupe accidentally
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
  const safeProject = String(projectName || "training").replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safeProject}_${stamp}.jpg`;

  const url = new URL(`https://api.roboflow.com/dataset/${workspace}/${project}/upload`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("name", fileName);
  url.searchParams.set("split", "train");

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: base64,
    });

    let result;
    try {
      result = await response.json();
    } catch {
      const text = await response.text().catch(() => "");
      throw new Error(`Roboflow returned non-JSON ${response.status}: ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      throw new Error(result?.error?.message || result?.message || `Roboflow upload failed (${response.status})`);
    }

    return json({
      ok: true,
      imageId: result.id || result.image_id,
      fileName,
      duplicate: result.duplicate === true,
    });
  } catch (error) {
    console.error("Training upload failed:", error);
    return json({ error: `Upload failed: ${error.message}` }, 502);
  }
}
