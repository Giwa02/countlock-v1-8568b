// CSV parser: handles quoted fields with commas and escaped quotes.
// Shared between the Netlify projects function and the unit test.

function detectDelimiter(text) {
  // Sniff the first non-empty line to decide comma vs tab.
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? "\t" : ",";
}

export function parseCsv(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let current = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      current.push(value.trim());
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      current.push(value.trim());
      if (current.some((cell) => cell !== "")) rows.push(current);
      current = [];
      value = "";
    } else {
      value += char;
    }
  }

  current.push(value.trim());
  if (current.some((cell) => cell !== "")) rows.push(current);
  return rows;
}

export function buildProjectFromCsv(text, fallbackName) {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new Error("CSV must include a header row and an expected # row.");
  }

  const header = rows[0];
  const expectedRow = rows.find((r) => (r[0] || "").toLowerCase() === "expected #");
  if (!expectedRow) {
    throw new Error('CSV must include a row starting with "expected #".');
  }

  const partColumns = header
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => /^\d+$/.test(String(cell || "").trim()));

  if (partColumns.length === 0) {
    throw new Error("CSV must include numbered part columns like 1,2,3.");
  }

  // Validate every expected value is a non-negative integer. Bad data
  // should produce a clear 400, not an opaque DB constraint violation.
  const parts = partColumns.map(({ cell, index }, position) => {
    const raw = (expectedRow[index] || "").trim();
    if (raw === "") {
      throw new Error(`Missing expected count for part column "${cell}".`);
    }
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `Expected count for part column "${cell}" must be a non-negative integer (got "${raw}").`
      );
    }
    return {
      partId: String(cell),
      position: position + 1,
      expected: parseInt(raw, 10),
    };
  });

  // Collect kit names. Dedupe by exact match — a CSV with two rows both
  // labeled "Kit 1" would otherwise violate the (project_id, name) unique
  // constraint and leave us with a half-created project.
  const kitNames = [];
  const seen = new Set();
  for (const r of rows) {
    const label = (r[0] || "").trim();
    if (!label) continue;
    const lower = label.toLowerCase();
    if (lower === "part" || lower === "expected #") continue;
    if (seen.has(label)) continue;   // exact duplicate — silently dropped
    seen.add(label);
    kitNames.push(label);
  }

  if (kitNames.length === 0) {
    throw new Error("CSV must include at least one kit row.");
  }

  return {
    name: fallbackName || "Uploaded Project",
    parts,
    kitNames,
  };
}
