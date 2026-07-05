import { API_BASE } from "../config.js";
import { useState } from "react";
import "./SignUp.css";
import { FcGoogle } from "react-icons/fc";
import { useNavigate, Link } from "react-router-dom";
import { useGoogleLogin } from "@react-oauth/google";

export default function SignUp() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [formMsg, setFormMsg] = useState({ type: "", text: "" });

  function clearAllErrors() {
    setEmailError("");
    setPasswordError("");
    setFormMsg({ type: "", text: "" });
  }

  async function handleSignUp(e) {
    e.preventDefault();
    clearAllErrors();

    let hasError = false;

    if (!email.trim()) {
      setEmailError("Email is required.");
      hasError = true;
    }

    if (!password) {
      setPasswordError("Password is required.");
      hasError = true;
    } else if (password.length < 6) {
      setPasswordError("Password must be at least 6 characters.");
      hasError = true;
    }

    if (hasError) return;

    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409) {
          setFormMsg({
            type: "info",
            text: "An account with this email already exists. Please log in instead.",
          });
        } else {
          setFormMsg({
            type: "error",
            text: data.message || "Signup failed. Please try again.",
          });
        }
        return;
      }

      navigate("/home");
    } catch {
      setFormMsg({ type: "error", text: "Server error. Please try again in a moment." });
    }
  }

  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      clearAllErrors();
      try {
        const res = await fetch(`${API_BASE}/auth/google`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: tokenResponse.access_token }),
        });

        const data = await res.json();

        if (!res.ok) {
          setFormMsg({
            type: "error",
            text: data.message || "Google sign-in didnâ€™t work. Please try again.",
          });
          return;
        }

        navigate("/home");
      } catch {
        setFormMsg({ type: "error", text: "Server error. Please try again in a moment." });
      }
    },
    onError: () => setFormMsg({ type: "error", text: "Google sign-in was cancelled or failed." }),
  });

  return (
    <div className="ls-page">
      <div className="ls-card">
        <div className="ls-logoWrap">
          <div className="ls-logo">V</div>
        </div>

        <h1 className="ls-title">Welcome</h1>
        <p className="ls-subtitle">Sign Up to VolleyAI</p>

        <form className="ls-form" onSubmit={handleSignUp}>
          <div className="ls-field">
            <label className="ls-label" htmlFor="email">
              Email address*
            </label>

            <input
              id="email"
              type="email"
              className={`ls-input ${emailError ? "ls-input-error" : ""}`}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError("");
                if (formMsg.text) setFormMsg({ type: "", text: "" });
              }}
            />

            {emailError && <div className="ls-errorText">{emailError}</div>}
          </div>

          <div className="ls-field">
            {!password && (
              <label className="ls-label static" htmlFor="password">
                Password*
              </label>
            )}

            <div className="ls-passwordWrap">
              <input
                id="password"
                type="password"
                className={`ls-input password ${passwordError ? "ls-input-error" : ""}`}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError) setPasswordError("");
                  if (formMsg.text) setFormMsg({ type: "", text: "" });
                }}
              />
              <button type="button" className="ls-eyeBtn" aria-label="Show password">
                ðŸ‘
              </button>
            </div>

            {passwordError && <div className="ls-errorText">{passwordError}</div>}
          </div>

          {formMsg.text && (
            <div className={`ls-formMsgRow ${formMsg.type === "info" ? "ls-msg-info" : ""}`}>
              <span className="ls-formErrorIcon">!</span>
              <span className="ls-formErrorText">{formMsg.text}</span>
            </div>
          )}

          <button type="submit" className="ls-primaryBtn">
            Continue
          </button>
        </form>

        <div className="ls-signupRow">
          <span>Already have an account?</span>
          <Link to="/" className="ls-linkBtn">
            Login
          </Link>
        </div>

        <div className="ls-divider">
          <span>OR</span>
        </div>

        <button type="button" className="ls-googleBtn" onClick={() => googleLogin()}>
          <FcGoogle className="ls-googleIcon" />
          <span>Continue with Google</span>
        </button>
      </div>
    </div>
  );
}