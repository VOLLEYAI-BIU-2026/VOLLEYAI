import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./Home_screen.css";

export default function HomeScreen() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("http://localhost:5000/auth/me", {
          method: "GET",
          credentials: "include",
        });

        if (!res.ok) {
          navigate("/");
          return;
        }

        const data = await res.json();
        setEmail(data.user.email || "");
      } catch {
        navigate("/");
      }
    })();
  }, [navigate]);

  useEffect(() => {
    function onDocClick(e) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const initial = useMemo(() => (email.trim().charAt(0) || "U").toUpperCase(), [email]);

  async function handleLogout() {
    try {
      await fetch("http://localhost:5000/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      navigate("/");
    }
  }

  return (
    <div className="hs-page">
      <div className="hs-container">
        <div className="hs-shell">
          <header className="hs-topbar">
            <div className="hs-brand">
              <div className="hs-logo">V</div>
              <div className="hs-brandName">VolleyAI</div>
            </div>

            <div className="hs-searchWrap">
              <input className="hs-search" placeholder="Search matches..." />
            </div>

            <div className="hs-avatarWrap" ref={menuRef}>
              <button
                type="button"
                className="hs-avatar hs-avatarBtn"
                title={email || "Profile"}
                onClick={() => setMenuOpen((v) => !v)}
              >
                {initial}
              </button>

              {menuOpen && (
                <div className="hs-menu">
                  <div className="hs-menuEmail">{email}</div>
                  <button type="button" className="hs-menuItem" onClick={handleLogout}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </header>

          <main className="hs-grid">
            <button className="hs-newCard" type="button" onClick={() => navigate("/upload-video")}>
              <div className="hs-plus">+</div>
              <div className="hs-newText">Start New Analysis</div>
            </button>
          </main>
        </div>
      </div>
    </div>
  );
}