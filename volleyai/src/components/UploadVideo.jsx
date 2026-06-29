import React, { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./UploadVideo.css";

export default function UploadVideo({
  totalSteps = 4,
  currentStep = 1,
  maxSizeGB = 2,
  allowedExtensions = ["mp4", "mov", "avi"],
}) {
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const [sourceType, setSourceType] = useState("file");
  const [isDragOver, setIsDragOver] = useState(false);

  const [selectedFile, setSelectedFile] = useState(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const acceptAttr = useMemo(() => {
    return allowedExtensions.map((ext) => `.${ext}`).join(",");
  }, [allowedExtensions]);

  const maxBytes = maxSizeGB * 1024 * 1024 * 1024;

  function validateFile(file) {
    if (!file) return { ok: false, message: "No file selected." };

    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      return {
        ok: false,
        message: `Unsupported format. Allowed: ${allowedExtensions
          .join(", ")
          .toUpperCase()}`,
      };
    }

    if (file.size > maxBytes) {
      return { ok: false, message: `File is too large. Max ${maxSizeGB}GB.` };
    }

    return { ok: true, message: "" };
  }

  function isValidYouTubeUrl(url) {
    const trimmed = (url || "").trim();
    if (!trimmed) return false;

    const re =
      /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;
    return re.test(trimmed);
  }

  function resetErrors() {
    setError("");
  }

  function switchSource(type) {
    resetErrors();
    setSourceType(type);

    if (type === "file") {
      setYoutubeUrl("");
    } else {
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function handlePickClick() {
    if (sourceType !== "file") return;
    resetErrors();
    inputRef.current?.click();
  }

  function handleFileChosen(file) {
    const res = validateFile(file);
    if (!res.ok) {
      setSelectedFile(null);
      setError(res.message);
      return;
    }
    setSelectedFile(file);
    setError("");
  }

  function onInputChange(e) {
    const file = e.target.files?.[0];
    handleFileChosen(file);
  }

  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (sourceType !== "file") return;

    const file = e.dataTransfer.files?.[0];
    handleFileChosen(file);
  }

  function onDragOver(e) {
    e.preventDefault();
    e.stopPropagation();

    if (sourceType !== "file") return;
    setIsDragOver(true);
  }

  function onDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }

  async function handleContinue() {
    resetErrors();

    if (isSubmitting) return;

    try {
      setIsSubmitting(true);

      if (sourceType === "file") {
        if (!selectedFile) {
          setError("Please select a video file to continue.");
          return;
        }

        const fd = new FormData();
        fd.append("video", selectedFile);

        const res = await fetch("http://localhost:5000/videos/upload-file", {
          method: "POST",
          credentials: "include",
          body: fd,
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.message || "Upload failed. Please try again.");
          return;
        }

        navigate(`/court-setup/${data.video._id}`);
        return;
      }

      if (!isValidYouTubeUrl(youtubeUrl)) {
        setError("This doesn’t look like a valid YouTube link. Please paste a full URL.");
        return;
      }

      const res = await fetch("http://localhost:5000/videos/youtube", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Couldn’t save the YouTube link. Please try again.");
        return;
      }

      navigate(`/court-setup/${data.video._id}`);
    } catch (e) {
      setError("Server error. Please try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const canContinue =
    !isSubmitting &&
    ((sourceType === "file" && !!selectedFile) ||
      (sourceType === "youtube" && isValidYouTubeUrl(youtubeUrl)));

  const STEPS = [
    { label: "Upload Video",   sub: "Select footage" },
    { label: "Court Setup",    sub: "Calibrate court" },
    { label: "Start Analysis", sub: "Ready to go" },
  ];

  return (
    <div className="uva-page">
      <header className="uva-topbar">
        <button
          className="uva-backIcon"
          type="button"
          onClick={() => navigate("/home")}
          aria-label="Back to home"
        >
          ←
        </button>
        <div className="uva-titleWrap">
          <div className="uva-title">New Match Analysis</div>
        </div>
      </header>

      <div className="uva-stepper-h">
        {STEPS.map((s, i) => {
          const stepNum = i + 1;
          const done = stepNum < currentStep;
          const active = stepNum === currentStep;
          return (
            <div key={s.label} className="uva-step-h-wrap">
              <div className={`uva-step-h ${active ? "active" : ""} ${done ? "done" : ""}`}>
                <div className="uva-step-h-circle">
                  {done ? "✓" : stepNum}
                </div>
                <div className="uva-step-h-text">
                  <div className="uva-step-h-label">{s.label}</div>
                  <div className="uva-step-h-sub">{s.sub}</div>
                </div>
              </div>
              {i < STEPS.length - 1 && <div className={`uva-step-h-line ${done ? "done" : ""}`} />}
            </div>
          );
        })}
      </div>

      <div className="uva-body">
        <main className="uva-main">
          <section className="uva-card">
            <div className="uva-cardHeader">
              <div className="uva-iconBadge" aria-hidden="true">
                🎥
              </div>

              <h1 className="uva-h1">Video Source</h1>
              <p className="uva-subtitle">
                Choose how you want to provide the match footage.
              </p>

              <div className="uva-sourceToggle" role="tablist" aria-label="Video source">
                <button
                  type="button"
                  className={`uva-toggleBtn ${sourceType === "file" ? "active" : ""}`}
                  onClick={() => switchSource("file")}
                  role="tab"
                  aria-selected={sourceType === "file"}
                  disabled={isSubmitting}
                >
                  ⬆️ Upload File
                </button>

                <button
                  type="button"
                  className={`uva-toggleBtn ${sourceType === "youtube" ? "active" : ""}`}
                  onClick={() => switchSource("youtube")}
                  role="tab"
                  aria-selected={sourceType === "youtube"}
                  disabled={isSubmitting}
                >
                  ▶️ YouTube Link
                </button>
              </div>
            </div>

            {sourceType === "file" ? (
              <div
                className={`uva-dropzone ${isDragOver ? "isDragOver" : ""} ${
                  error ? "hasError" : ""
                }`}
                role="button"
                tabIndex={0}
                onClick={handlePickClick}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    handlePickClick();
                  }
                }}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
              >
                <input
                  ref={inputRef}
                  className="uva-hiddenInput"
                  type="file"
                  accept={acceptAttr}
                  onChange={onInputChange}
                  disabled={isSubmitting}
                />

                <div className="uva-dropContent">
                  <div className="uva-cloud" aria-hidden="true">
                    ☁️⬆️
                  </div>

                  {!selectedFile ? (
                    <>
                      <div className="uva-dropTitle">Click to upload</div>
                      <div className="uva-dropHint">or drag and drop</div>
                      <div className="uva-dropMeta">
                        {allowedExtensions.map((x) => x.toUpperCase()).join(", ")} up to{" "}
                        {maxSizeGB}GB
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="uva-dropTitle">Selected file</div>
                      <div className="uva-filePill">
                        <span className="uva-fileName">{selectedFile.name}</span>
                        <span className="uva-fileSize">{formatBytes(selectedFile.size)}</span>
                        <button
                          type="button"
                          className="uva-removeBtn"
                          disabled={isSubmitting}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedFile(null);
                            setError("");
                            if (inputRef.current) inputRef.current.value = "";
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className={`uva-youtubeBox ${error ? "hasError" : ""}`}>
                <label className="uva-label" htmlFor="youtubeUrl">
                  Paste YouTube link
                </label>

                <input
                  id="youtubeUrl"
                  className="uva-input"
                  type="text"
                  placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/..."
                  value={youtubeUrl}
                  disabled={isSubmitting}
                  onChange={(e) => {
                    setYoutubeUrl(e.target.value);
                    setError("");
                  }}
                />

                <div className="uva-inputHint">
                  Supported: youtube.com/watch, youtu.be, youtube.com/shorts
                </div>

                {youtubeUrl.trim() ? (
                  <div className={`uva-urlStatus ${isValidYouTubeUrl(youtubeUrl) ? "ok" : "bad"}`}>
                    {isValidYouTubeUrl(youtubeUrl)
                      ? "✓ Link looks valid"
                      : "✕ Invalid link format"}
                  </div>
                ) : null}
              </div>
            )}

            {error ? <div className="uva-error">{error}</div> : null}

            <div className="uva-tip">
              <span className="uva-tipIcon" aria-hidden="true">
                ⚠️
              </span>
              <span>
                <strong>Tip:</strong> Ensure you have a clear view of the entire court. Fixed camera
                angles work best for automatic tracking.
              </span>
            </div>

            <div className="uva-footer">
              <button className="uva-secondary" type="button" onClick={() => navigate("/home")} disabled={isSubmitting}>
                Back
              </button>

              <button
                className="uva-primary"
                type="button"
                onClick={handleContinue}
                disabled={!canContinue}
              >
                {isSubmitting ? "Uploading..." : "Continue"} <span aria-hidden="true">›</span>
              </button>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(val >= 10 ? 0 : 1)} ${sizes[i]}`;
}