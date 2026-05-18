// Tests for the shared CSV parser and project builder.
// Run: npm test

import { parseCsv, buildProjectFromCsv } from "../netlify/functions/_csv.js";

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}: ${error.message}`);
  }
}

console.log("parseCsv");

check("parses simple rows", () => {
  const rows = parseCsv("a,b,c\n1,2,3");
  if (rows.length !== 2) throw new Error("expected 2 rows");
  if (rows[1][2] !== "3") throw new Error("expected '3'");
});

check("handles quoted commas", () => {
  const rows = parseCsv('a,b\n"hello, world","x"');
  if (rows[1][0] !== "hello, world") throw new Error("quoted comma not preserved");
});

check("handles escaped quotes", () => {
  const rows = parseCsv('a\n"he said ""hi"""');
  if (rows[1][0] !== 'he said "hi"') throw new Error("escaped quote not preserved");
});

check("ignores blank rows", () => {
  const rows = parseCsv("a,b\n1,2\n\n3,4");
  if (rows.length !== 3) throw new Error("expected 3 rows, got " + rows.length);
});

console.log("buildProjectFromCsv");

check("builds project from valid CSV", () => {
  const csv = `part,1,2,3,Review
expected #,3,6,3,
Kit 1,,,,
Kit 2,,,,`;
  const project = buildProjectFromCsv(csv, "Test");
  if (project.name !== "Test") throw new Error("name mismatch");
  if (project.parts.length !== 3) throw new Error("expected 3 parts");
  if (project.parts[0].partId !== "1") throw new Error("partId mismatch");
  if (project.parts[1].expected !== 6) throw new Error("expected count mismatch");
  if (project.kitNames.length !== 2) throw new Error("expected 2 kits");
  if (project.kitNames[0] !== "Kit 1") throw new Error("kit name mismatch");
});

check("rejects CSV without expected # row", () => {
  let threw = false;
  try {
    buildProjectFromCsv("part,1,2\nKit 1,,", "x");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("should have thrown");
});

check("rejects CSV without numbered columns", () => {
  let threw = false;
  try {
    buildProjectFromCsv("part,a,b\nexpected #,3,6\nKit 1,,", "x");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("should have thrown");
});

check("ignores non-numeric trailing columns like 'Review'", () => {
  const csv = `part,1,2,Review
expected #,3,6,
Kit 1,,,"Review Kit 1 part 1"`;
  const project = buildProjectFromCsv(csv, "x");
  if (project.parts.length !== 2) throw new Error("Review column should be ignored");
});

check("rejects non-numeric expected count", () => {
  let threw = false;
  try {
    buildProjectFromCsv("part,1,2\nexpected #,3,foo\nKit 1,,", "x");
  } catch (e) {
    threw = e.message.includes("non-negative integer");
  }
  if (!threw) throw new Error("should have thrown for non-numeric expected");
});

check("rejects empty expected count", () => {
  let threw = false;
  try {
    buildProjectFromCsv("part,1,2\nexpected #,3,\nKit 1,,", "x");
  } catch (e) {
    threw = e.message.includes("Missing expected");
  }
  if (!threw) throw new Error("should have thrown for empty expected");
});

check("rejects CSV with no kits", () => {
  let threw = false;
  try {
    buildProjectFromCsv("part,1\nexpected #,3", "x");
  } catch (e) {
    threw = e.message.includes("at least one kit");
  }
  if (!threw) throw new Error("should have thrown for no kits");
});

check("dedupes duplicate kit names", () => {
  const csv = `part,1,Review
expected #,3,
Kit A,,
Kit A,,
Kit B,,`;
  const project = buildProjectFromCsv(csv, "x");
  if (project.kitNames.length !== 2) {
    throw new Error(`expected 2 unique kits, got ${project.kitNames.length}`);
  }
  if (project.kitNames[0] !== "Kit A" || project.kitNames[1] !== "Kit B") {
    throw new Error(`wrong kit order: ${project.kitNames.join(", ")}`);
  }
});

check("parses tab-separated file (Excel export)", () => {
  const tsv = "part\t1\t2\t3\nexpected #\t3\t6\t3\nKit 1\t\t\t\nKit 2\t\t\t";
  const project = buildProjectFromCsv(tsv, "Tab Test");
  if (project.parts.length !== 3) throw new Error(`expected 3 parts, got ${project.parts.length}`);
  if (project.kitNames.length !== 2) throw new Error(`expected 2 kits, got ${project.kitNames.length}`);
  if (project.parts[0].expected !== 3) throw new Error("expected count wrong");
});

check("parses real-world Excel tab file (10 parts, 3 kits)", () => {
  const tsv = "part\t1\t2\t3\t4\t5\t6\t7\t8\t9\t10\nexpected #\t3\t6\t3\t6\t7\t8\t3\t6\t7\t33\nKit 1\t\t\t\t\t\t\t\t\t\t\nKit 2\t\t\t\t\t\t\t\t\t\t\nKit 3\t\t\t\t\t\t\t\t\t\t";
  const project = buildProjectFromCsv(tsv, "Excel Test");
  if (project.parts.length !== 10) throw new Error(`expected 10 parts, got ${project.parts.length}`);
  if (project.parts[9].expected !== 33) throw new Error(`part 10 expected 33, got ${project.parts[9].expected}`);
  if (project.kitNames.length !== 3) throw new Error(`expected 3 kits, got ${project.kitNames.length}`);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll tests passed.");
