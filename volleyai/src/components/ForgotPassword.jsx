import { API_BASE } from "../config.js";
import "./ForgotPassword.css";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();

    if (!email.trim()) {
      alert("Please enter your email");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Request failed");
        return;
      }

      // ×”×•×“×¢×” ××—×™×“×”, ×•××– ×—×•×–×¨×™× ×œ×œ×•×’×™×Ÿ
      alert(data.message || "If an account exists, a reset link will be sent");
      navigate("/");
    } catch (error) {
      console.error("forgot password error:", error);
      alert("Server error");
    }
  }

  return (
    <div className="fp-page">
      <div className="fp-card">
        <div className="fp-logoWrap">
          <div className="fp-logo">V</div>
        </div>

        <h1 className="fp-title">Forgot Your Password?</h1>

        <p className="fp-subtitle">
          Enter your email address and we will send you instructions to reset your password.
          <br />
          If you signed up with Google, please use Google sign-in.
        </p>

        <form className="fp-form" onSubmit={handleSubmit}>
          <div className="fp-field">
            <label className="fp-label" htmlFor="email">
              Email address*
            </label>
            <input
              id="email"
              type="email"
              className="fp-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <button type="submit" className="fp-primaryBtn">
            Continue
          </button>
        </form>

        <button type="button" className="fp-backBtn" onClick={() => navigate("/")}>
          Back to VolleyAI
        </button>
      </div>
    </div>
  );
}