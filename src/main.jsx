import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Camera, ArrowLeft, CheckCircle2, Upload, Download,
  Lock, Unlock, FolderOpen, Plus, AlertCircle, X,
  SkipForward, Mail,
} from "lucide-react";
import "./styles.css";

// ─── API helpers ─────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

const ProjectsApi = {
  list: () => api("/api/projects"),
  get: (id) => api(`/api/projects?id=${encodeURIComponent(id)}`),
  createFromCsv: (csvText, filename, supervisorEmails) =>
    api("/api/projects", { method: "POST", body: JSON.stringify({ csvText, filename, supervisorEmails }) }),
  createFromForm: (name, parts, kitNames, supervisorEmails) =>
    api("/api/projects", { method: "POST", body: JSON.stringify({ name, parts, kitNames, supervisorEmails }) }),
};

const KitsApi = {
  finish: (kitId, operatorInitials) =>
    api("/api/kits", { method: "POST", body: JSON.stringify({ kitId, action: "finish", operatorInitials }) }),
  reopen: (kitId) =>
    api("/api/kits", { method: "POST", body: JSON.stringify({ kitId, action: "reopen" }) }),
  capture: ({ kitId, partId, imageBase64, thumbnailBase64 }) =>
    api("/api/count-image", { method: "POST", body: JSON.stringify({ kitId, partId, imageBase64, thumbnailBase64 }) }),
};

// ─── Capture a small thumbnail for email (320×240, quality 0.3) ──────────────

function captureThumbnail(videoEl) {
  try {
    const c = document.createElement("canvas");
    c.width = 320; c.height = 240;
    c.getContext("2d").drawImage(videoEl, 0, 0, 320, 240);
    return c.toDataURL("image/jpeg", 0.3);
  } catch {
    return null;
  }
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportProjectCsv(project) {
  const headers = ["part", ...project.parts.map((p) => p.part_id), "Operator", "Review"];
  const expected = ["expected #", ...project.parts.map((p) => p.expected), "", ""];
  const rows = project.kits.map((kit) => {
    const mismatches = project.parts
      .filter((p) => Number(kit.counts?.[p.part_id]?.count ?? "") !== Number(p.expected))
      .map((p) => p.part_id);
    const review = kit.status === "locked"
      ? mismatches.length ? `Review ${kit.name} part ${mismatches.join(",")}` : "Pass"
      : "Open";
    return [
      kit.name,
      ...project.parts.map((p) => kit.counts?.[p.part_id]?.count ?? ""),
      kit.operator_initials || "",
      review,
    ];
  });

  const csv = [headers, expected, ...rows]
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${project.name.replace(/\s+/g, "-").toLowerCase()}-countlock.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ─── App shell / routing ──────────────────────────────────────────────────────

function App() {
  const [view, setView] = useState({ name: "projects" });
  const [error, setError] = useState("");

  function showError(message) {
    setError(message);
    if (message) setTimeout(() => setError(""), 7000);
  }

  return (
    <main className="app">
      <Header
        view={view}
        onHome={() => setView({ name: "projects" })}
        onBack={() => {
          if (view.name === "kits") setView({ name: "projects" });
          else if (view.name === "operator") setView({ name: "kits", projectId: view.projectId });
          else if (view.name === "new-project") setView({ name: "projects" });
        }}
      />
      {error && <div className="alert"><AlertCircle size={18} /> {error}</div>}

      {view.name === "projects" && (
        <ProjectListView
          onOpenProject={(id) => setView({ name: "kits", projectId: id })}
          onNewProject={() => setView({ name: "new-project" })}
          onError={showError}
        />
      )}
      {view.name === "new-project" && (
        <NewProjectView
          onCreated={(id) => setView({ name: "kits", projectId: id })}
          onError={showError}
        />
      )}
      {view.name === "kits" && (
        <KitListView
          projectId={view.projectId}
          onOpenKit={(kitId) => setView({ name: "operator", projectId: view.projectId, kitId })}
          onError={showError}
        />
      )}
      {view.name === "operator" && (
        <OperatorView
          projectId={view.projectId}
          kitId={view.kitId}
          onBack={() => setView({ name: "kits", projectId: view.projectId })}
          onNextKit={(nextKitId) => setView({ name: "operator", projectId: view.projectId, kitId: nextKitId })}
          onError={showError}
        />
      )}
    </main>
  );
}

function Header({ view, onHome, onBack }) {
  const showBack = view.name !== "projects";
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">📸</span>
        <div>
          <p className="eyebrow">CountLock</p>
          <h1>Tap → Count → Lock</h1>
        </div>
      </div>
      <div className="header-actions">
        {showBack && (
          <button className="ghost" onClick={onBack}><ArrowLeft size={18} /> Back</button>
        )}
        {view.name !== "projects" && (
          <button className="ghost" onClick={onHome}><FolderOpen size={18} /> Projects</button>
        )}
      </div>
    </header>
  );
}

// ─── View: Project list ───────────────────────────────────────────────────────

function ProjectListView({ onOpenProject, onNewProject, onError }) {
  const [projects, setProjects] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    ProjectsApi.list()
      .then(({ projects }) => { if (!cancelled) setProjects(projects); })
      .catch((e) => { onError(e.message); if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const csvText = await file.text();
      const { project } = await ProjectsApi.createFromCsv(csvText, file.name, []);
      onOpenProject(project.id);
    } catch (e) {
      onError(e.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div><p className="eyebrow">Projects</p><h2>Pick a kit project</h2></div>
        <div className="header-actions">
          <button className="ghost" onClick={onNewProject}><Plus size={18} /> New Project</button>
          <label className="primary" aria-busy={uploading}>
            <Upload size={18} /> {uploading ? "Uploading…" : "Upload CSV"}
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleUpload} disabled={uploading} />
          </label>
        </div>
      </div>

      {projects === null && <div className="empty">Loading projects…</div>}
      {projects?.length === 0 && (
        <div className="empty">
          <Plus size={28} />
          <p>No projects yet. Create one or upload a CSV.</p>
        </div>
      )}
      {projects?.length > 0 && (
        <ul className="project-grid">
          {projects.map((project) => (
            <li key={project.id}>
              <button className="project-card" onClick={() => onOpenProject(project.id)}>
                <div className="project-card-name">{project.name}</div>
                <div className="project-card-meta">
                  <span>{project.kitSummary?.total ?? 0} kit{project.kitSummary?.total === 1 ? "" : "s"}</span>
                  <span className="dot" aria-hidden="true">·</span>
                  <span>{project.kitSummary?.locked ?? 0} locked</span>
                  {project.supervisor_emails?.length > 0 && (
                    <><span className="dot">·</span><span><Mail size={11} style={{display:"inline",verticalAlign:"middle"}} /> {project.supervisor_emails.length}</span></>
                  )}
                </div>
                <div className="project-card-date">{new Date(project.created_at).toLocaleString()}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── View: New project form ───────────────────────────────────────────────────

function NewProjectView({ onCreated, onError }) {
  const [name, setName] = useState("");
  const [parts, setParts] = useState([{ partId: "", expected: "" }]);
  const [kitNames, setKitNames] = useState([{ name: "" }]);
  const [emails, setEmails] = useState([{ email: "" }, { email: "" }]);
  const [saving, setSaving] = useState(false);

  function updatePart(i, field, value) {
    setParts((prev) => prev.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
  }
  function addPart() { setParts((prev) => [...prev, { partId: "", expected: "" }]); }
  function removePart(i) { setParts((prev) => prev.filter((_, idx) => idx !== i)); }

  function updateKit(i, value) {
    setKitNames((prev) => prev.map((k, idx) => idx === i ? { name: value } : k));
  }
  function addKit() { setKitNames((prev) => [...prev, { name: "" }]); }
  function removeKit(i) { setKitNames((prev) => prev.filter((_, idx) => idx !== i)); }

  function updateEmail(i, value) {
    setEmails((prev) => prev.map((e, idx) => idx === i ? { email: value } : e));
  }

  async function handleSubmit() {
    if (!name.trim()) return onError("Project name is required");
    const validParts = parts.filter((p) => p.partId.trim() && p.expected !== "");
    if (validParts.length === 0) return onError("Add at least one part with an expected count");
    const validKits = kitNames.filter((k) => k.name.trim());
    if (validKits.length === 0) return onError("Add at least one kit name");
    const validEmails = emails.map((e) => e.email.trim()).filter((e) => e && e.includes("@"));

    setSaving(true);
    try {
      const { project } = await ProjectsApi.createFromForm(
        name.trim(),
        validParts.map((p, i) => ({ partId: p.partId.trim(), position: i + 1, expected: parseInt(p.expected, 10) })),
        validKits.map((k) => k.name.trim()),
        validEmails
      );
      onCreated(project.id);
    } catch (e) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div><p className="eyebrow">New Project</p><h2>Set up a kit project</h2></div>
      </div>

      <div className="form-section">
        <label className="form-label">Project name</label>
        <input className="form-input" placeholder="e.g. Assembly Kit Q2" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="form-section">
        <div className="form-row-head">
          <label className="form-label">Parts & expected counts</label>
          <button className="ghost small" onClick={addPart}><Plus size={14} /> Add part</button>
        </div>
        {parts.map((p, i) => (
          <div key={i} className="form-row">
            <input className="form-input" placeholder="Part #" value={p.partId}
              onChange={(e) => updatePart(i, "partId", e.target.value)} style={{ width: "120px" }} />
            <input className="form-input" placeholder="Expected count" type="number" min="0" value={p.expected}
              onChange={(e) => updatePart(i, "expected", e.target.value)} style={{ width: "140px" }} />
            {parts.length > 1 && (
              <button className="ghost small icon-only" onClick={() => removePart(i)}><X size={14} /></button>
            )}
          </div>
        ))}
      </div>

      <div className="form-section">
        <div className="form-row-head">
          <label className="form-label">Kit names</label>
          <button className="ghost small" onClick={addKit}><Plus size={14} /> Add kit</button>
        </div>
        {kitNames.map((k, i) => (
          <div key={i} className="form-row">
            <input className="form-input" placeholder={`Kit ${i + 1}`} value={k.name}
              onChange={(e) => updateKit(i, e.target.value)} />
            {kitNames.length > 1 && (
              <button className="ghost small icon-only" onClick={() => removeKit(i)}><X size={14} /></button>
            )}
          </div>
        ))}
      </div>

      <div className="form-section">
        <label className="form-label">Supervisor emails <span className="form-hint">(up to 2 — receive the report on every kit finish)</span></label>
        {emails.map((e, i) => (
          <div key={i} className="form-row">
            <input className="form-input" type="email" placeholder={`Supervisor ${i + 1} email`}
              value={e.email} onChange={(ev) => updateEmail(i, ev.target.value)} />
          </div>
        ))}
      </div>

      <div className="form-actions">
        <button className="primary" onClick={handleSubmit} disabled={saving}>
          <CheckCircle2 size={18} /> {saving ? "Creating…" : "Create Project"}
        </button>
      </div>
    </section>
  );
}

// ─── View: Kit list ───────────────────────────────────────────────────────────

function KitListView({ projectId, onOpenKit, onError }) {
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { project } = await ProjectsApi.get(projectId);
        if (!cancelled) setProject(project);
      } catch (error) {
        if (cancelled) return;
        onError(error.message);
        setLoadError(error.message || "Failed to load project");
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  if (loadError) return (
    <div className="empty"><AlertCircle size={28} /><p>{loadError}</p></div>
  );
  if (!project) return <div className="empty">Loading project…</div>;

  return (
    <section className="panel">
      <div className="panel-head">
        <div><p className="eyebrow">Project</p><h2>{project.name}</h2></div>
        <button className="ghost" onClick={() => exportProjectCsv(project)}>
          <Download size={18} /> Export
        </button>
      </div>

      {project.supervisor_emails?.length > 0 && (
        <div className="supervisor-strip">
          <Mail size={14} />
          <span>Reports go to: {project.supervisor_emails.join(", ")}</span>
        </div>
      )}

      <div className="expected-strip">
        <span className="eyebrow">Expected per part</span>
        <div className="expected-strip-row">
          {project.parts.map((p) => (
            <div className="expected-chip" key={p.part_id}>
              <span>{p.part_id}</span>
              <strong>{p.expected}</strong>
            </div>
          ))}
        </div>
      </div>

      <ul className="kit-list">
        {project.kits.map((kit) => {
          const completed = project.parts.filter((p) => kit.counts?.[p.part_id]).length;
          return (
            <li key={kit.id}>
              <button className="kit-row" onClick={() => onOpenKit(kit.id)}>
                <div className="kit-row-head">
                  <strong>{kit.name}</strong>
                  {kit.operator_initials && <span className="initials-badge">{kit.operator_initials}</span>}
                  <KitStatusBadge kit={kit} />
                </div>
                <div className="kit-row-meta">
                  {completed}/{project.parts.length} counted
                  {kit.reopen_count > 0 && <span className="muted"> · re-opened {kit.reopen_count}×</span>}
                  {kit.review_note && kit.status === "locked" && (
                    <span className="review-note"> · {kit.review_note}</span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function KitStatusBadge({ kit }) {
  if (kit.status === "locked") {
    return <span className="badge badge-locked"><Lock size={12} /> Locked</span>;
  }
  return <span className="badge badge-open">Open</span>;
}

// ─── Initials modal ───────────────────────────────────────────────────────────

function InitialsModal({ onConfirm }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Enter your initials</h3>
        <p className="modal-hint">Your initials will appear on the kit report emailed to the supervisor.</p>
        <input
          ref={inputRef}
          className="form-input initials-input"
          placeholder="e.g. EG"
          maxLength={4}
          value={value}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onConfirm(value.trim()); }}
        />
        <div className="modal-actions">
          <button className="primary" onClick={() => value.trim() && onConfirm(value.trim())} disabled={!value.trim()}>
            <CheckCircle2 size={18} /> Start Kit
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── View: Operator screen ────────────────────────────────────────────────────

function OperatorView({ projectId, kitId, onBack, onNextKit, onError }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [operatorInitials, setOperatorInitials] = useState(null); // null = not entered yet
  const [partIndex, setPartIndex] = useState(0);
  const [status, setStatus] = useState("Loading kit…");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [isCounting, setIsCounting] = useState(false);
  const [isRetake, setIsRetake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishResult, setFinishResult] = useState(null); // set after kit is locked

  const kit = useMemo(() => project?.kits.find((k) => k.id === kitId) || null, [project, kitId]);
  const currentPart = project?.parts[partIndex] || null;
  const currentCount = kit && currentPart ? kit.counts?.[currentPart.part_id] : null;
  const isLocked = kit?.status === "locked";

  // Load project + kit
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { project } = await ProjectsApi.get(projectId);
        if (cancelled) return;
        setProject(project);
        const found = project.kits.find((k) => k.id === kitId);
        if (!found) {
          setLoadError("Kit not found in this project.");
        } else if (found.status === "locked") {
          setStatus("Kit locked. Tap Re-open to re-take any part.");
          setFinishResult(null);
        } else {
          setStatus("Enter your initials to begin.");
        }
      } catch (error) {
        if (cancelled) return;
        onError(error.message);
        setLoadError(error.message || "Failed to load kit");
      }
    }
    load();
    return () => { cancelled = true; };
  }, [projectId, kitId]);

  // Camera
  useEffect(() => {
    let stream = null; let cancelled = false;
    async function startCamera() {
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (cancelled) { acquired.getTracks().forEach((t) => t.stop()); return; }
        stream = acquired;
        if (videoRef.current) { videoRef.current.srcObject = stream; setCameraReady(true); }
      } catch (error) {
        if (!cancelled) setCameraError(`Camera unavailable: ${error.message}`);
      }
    }
    startCamera();
    return () => { cancelled = true; if (stream) stream.getTracks().forEach((t) => t.stop()); };
  }, []);

  async function refreshProject() {
    const { project } = await ProjectsApi.get(projectId);
    setProject(project);
  }

  function handleInitials(initials) {
    setOperatorInitials(initials);
    setStatus("Place the first part group on the mat.");
  }

  async function captureAndCount() {
    if (!videoRef.current || !canvasRef.current || !kit || !currentPart) return;
    if (isLocked) { setStatus("Kit is locked. Re-open before capturing."); return; }

    setIsCounting(true);
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width; canvas.height = height;
    canvas.getContext("2d").drawImage(video, 0, 0, width, height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.82);
    const thumbnailBase64 = captureThumbnail(video);

    try {
      const result = await KitsApi.capture({ kitId, partId: currentPart.part_id, imageBase64, thumbnailBase64 });
      await refreshProject();
      if (result.pass) {
        setIsRetake(false);
        setStatus(`Part ${currentPart.part_id} · Detected ${result.count} · PASS ✓`);
        if (partIndex < project.parts.length - 1) setPartIndex((v) => v + 1);
      } else {
        setIsRetake(true);
        setStatus(`Part ${currentPart.part_id} · Detected ${result.count} of ${result.expected} — reposition and retake`);
      }
    } catch (error) {
      onError(error.message); setStatus(error.message);
    } finally {
      setIsCounting(false);
    }
  }

  async function finishKit() {
    if (!kit) return;
    setBusy(true);
    try {
      const result = await KitsApi.finish(kitId, operatorInitials || "");
      await refreshProject();
      setFinishResult(result);
      const emailNote = result.email?.sent ? ` Report emailed to ${result.email.recipients?.join(", ")}.` : "";
      if (result.allPass) {
        setStatus(`All parts pass.${emailNote}`);
      } else {
        const note = [];
        if (result.mismatches?.length) note.push(`${result.mismatches.length} mismatch(es)`);
        if (result.incompleteParts?.length) note.push(`${result.incompleteParts.length} missing part(s)`);
        setStatus(`Locked with review needed: ${note.join(", ")}.${emailNote}`);
      }
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function reopenKit() {
    if (!kit) return;
    setBusy(true);
    try {
      await KitsApi.reopen(kitId);
      await refreshProject();
      setFinishResult(null);
      setStatus("Re-opened. Retake any part by tapping Picture.");
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }

  function goToNextKit() {
    if (!project) return;
    const openKits = project.kits.filter((k) => k.status === "open" && k.id !== kitId);
    if (openKits.length === 0) { onBack(); return; }
    setFinishResult(null);
    setOperatorInitials(null);
    setPartIndex(0);
    setIsRetake(false);
    setStatus("Enter your initials to begin.");
    onNextKit(openKits[0].id);
  }

  function jumpToPart(index) { setIsRetake(false); setPartIndex(index); }

  if (loadError) return (
    <div className="empty">
      <AlertCircle size={28} />
      <p>{loadError}</p>
      <button className="ghost" onClick={onBack}><ArrowLeft size={18} /> Back to kit list</button>
    </div>
  );
  if (!project || !kit) return <div className="empty">Loading…</div>;

  // Show initials modal before first interaction on an open kit
  if (!isLocked && operatorInitials === null) {
    return <InitialsModal onConfirm={handleInitials} />;
  }

  const openKitsRemaining = project.kits.filter((k) => k.status === "open" && k.id !== kitId).length;
  const completed = project.parts.filter((p) => kit.counts?.[p.part_id]).length;

  return (
    <section className="panel operator">
      <div className="kit-header">
        <div>
          <p className="eyebrow">{project.name}</p>
          <h2 style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {kit.name}
            {operatorInitials && <span className="initials-badge">{operatorInitials}</span>}
            <KitStatusBadge kit={kit} />
          </h2>
        </div>
        <div className="kit-progress">
          {completed} / {project.parts.length} counted
          {kit.reopen_count > 0 && <span className="muted"> · re-opened {kit.reopen_count}×</span>}
        </div>
      </div>

      <div className="part-strip">
        {project.parts.map((p, i) => {
          const c = kit.counts?.[p.part_id];
          const isMismatch = c && Number(c.count) !== Number(p.expected);
          const isCurrent = i === partIndex;
          return (
            <button key={p.part_id}
              className={"part-pill" + (isCurrent ? " is-current" : "") + (c ? (isMismatch ? " is-mismatch" : " is-pass") : "")}
              onClick={() => jumpToPart(i)}
              title={`Part ${p.part_id} · expected ${p.expected}`}>
              <span className="part-pill-id">{p.part_id}</span>
              <span className="part-pill-count">{c?.count ?? "—"}</span>
            </button>
          );
        })}
      </div>

      <div className="part-status">
        <div>
          <p className="eyebrow">Current part group</p>
          <h3>{currentPart ? `Part ${currentPart.part_id}` : "—"}</h3>
        </div>
        <div className="count-box">
          <span>Expected</span>
          <strong>{currentPart?.expected ?? "—"}</strong>
        </div>
        <div className="count-box">
          <span>Detected</span>
          <strong>{currentCount?.count ?? "—"}</strong>
        </div>
      </div>

      <div className="camera-wrap">
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} hidden />
        {!cameraReady && <div className="camera-placeholder">{cameraError || "Waiting for camera…"}</div>}
        {isLocked && <div className="camera-overlay-locked"><Lock size={32} /><span>Kit locked</span></div>}
      </div>

      <div className="status">{status}</div>

      {/* After finish: show Kit locked summary + action buttons */}
      {isLocked && finishResult && (
        <div className={`finish-summary ${finishResult.allPass ? "pass" : "review"}`}>
          <div className="finish-summary-title">
            {finishResult.allPass ? "✓ All parts pass" : "⚠ Review needed"}
          </div>
          {finishResult.email?.sent && (
            <div className="finish-summary-email">
              <Mail size={13} /> Report sent to {finishResult.email.recipients?.join(", ")}
            </div>
          )}
          <div className="finish-summary-actions">
            {openKitsRemaining > 0 && (
              <button className="primary" onClick={goToNextKit}>
                <SkipForward size={20} /> Next Kit ({openKitsRemaining} remaining)
              </button>
            )}
            <button className="ghost" onClick={onBack}><FolderOpen size={18} /> Back to Project</button>
          </div>
        </div>
      )}

      <div className="buttons">
        <button onClick={() => { setIsRetake(false); setPartIndex((v) => Math.max(0, v - 1)); }} disabled={partIndex === 0 || isLocked}>
          <ArrowLeft size={22} /> Back
        </button>

        {isLocked ? (
          <button className="primary reopen" onClick={reopenKit} disabled={busy}>
            <Unlock size={26} /> {busy ? "Re-opening…" : "Re-open"}
          </button>
        ) : (
          <button
            className={`primary${isRetake ? " retake" : ""}`}
            onClick={captureAndCount}
            disabled={isCounting || !cameraReady}>
            <Camera size={26} />
            {isCounting ? "Counting…" : isRetake ? "Retake" : "Picture"}
          </button>
        )}

        <button className="finish" onClick={finishKit} disabled={busy || isLocked}>
          <CheckCircle2 size={22} /> Finished
        </button>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
