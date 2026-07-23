const USER_KEY = "kyw.user_id";
const SESSION_KEY = "kyw.session_id";

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "u_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getOrCreateUserId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(USER_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(USER_KEY, id);
  }
  return id;
}

export function getSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(SESSION_KEY);
}

export function setSessionId(id: string) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(SESSION_KEY, id);
}

export function clearSessionId() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(SESSION_KEY);
}
