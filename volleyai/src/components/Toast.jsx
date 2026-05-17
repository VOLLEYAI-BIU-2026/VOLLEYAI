import "./Toast.css";

export default function Toast({ open, type = "info", message, onClose }) {
  if (!open) return null;

  return (
    <div className={`toast toast-${type}`} role="status" aria-live="polite">
      <span className="toast-msg">{message}</span>
      <button className="toast-close" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}