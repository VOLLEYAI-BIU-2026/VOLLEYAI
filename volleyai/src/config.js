const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1"];

export const API_BASE = (typeof window !== "undefined" && LOCAL_HOSTNAMES.includes(window.location.hostname))
  ? `http://${window.location.hostname}:5000`
  : "";
