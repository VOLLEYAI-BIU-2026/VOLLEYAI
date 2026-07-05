export const API_BASE = (typeof window !== "undefined" && window.location.hostname !== "localhost")
  ? ""
  : "http://localhost:5000";
