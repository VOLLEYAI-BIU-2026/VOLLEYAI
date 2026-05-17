import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import "./ForgotPassword.css";

export default function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [newPassword, setNewPassword] = useState("");

  async function handleReset(e) {
    e.preventDefault();

    if (!token) {
      alert("Missing reset token (open this page from the email link)");
      return;
    }

    if (!newPassword) {
      alert("Please enter a new password");
      return;
    }

    try {
      const res = await fetch("http://localhost:5000/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Reset failed");
        return;
      }

      alert("Password reset successful");
      navigate("/");
    } catch (error) {
      alert("Server error");
    }
  }

  return (
    <div className="fp-page">
      <div className="fp-card">
        <div className="fp-logoWrap">
          <div className="fp-logo">V</div>
        </div>

        <h1 className="fp-title">Reset Password</h1>

        <p className="fp-subtitle">Enter your new password below.</p>

        <form className="fp-form" onSubmit={handleReset}>
          <div className="fp-field">
            <label className="fp-label" htmlFor="newPassword">
              New password*
            </label>
            <input
              id="newPassword"
              type="password"
              className="fp-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
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