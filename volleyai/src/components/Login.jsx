import { API_BASE } from "../config.js";
import "./Login.css";
import { FcGoogle } from "react-icons/fc";
import { FiEye, FiEyeOff } from "react-icons/fi";
import { GiVolleyballBall } from "react-icons/gi";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useGoogleLogin } from "@react-oauth/google";

export default function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [formError, setFormError] = useState("");

  function clearErrors() {
    setEmailError("");
    setPasswordError("");
    setFormError("");
  }

  async function handleLogin(e) {
    e.preventDefault();
    clearErrors();

    let hasError = false;

    if (!email.trim()) {
      setEmailError("Email is required.");
      hasError = true;
    }

    if (!password) {
      setPasswordError("Password is required.");
      hasError = true;
    }

    if (hasError) return;

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.message?.toLowerCase().includes("google")) {
          setFormError("This account uses Google sign-in. Please continue with Google.");
          return;
        }
        if (res.status === 401) {
          setFormError("Wrong email or password.");
          return;
        }
        setFormError(data.message || "Login failed. Please try again.");
        return;
      }

      navigate("/home");
    } catch {
      setFormError("Server error. Please try again in a moment.");
    }
  }

  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      clearErrors();
      try {
        const res = await fetch(`${API_BASE}/auth/google`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: tokenResponse.access_token }),
        });

        const data = await res.json();

        if (!res.ok) {
          setFormError(data.message || "Google sign-in didn’t work. Please try again.");
          return;
        }

        navigate("/home");
      } catch {
        setFormError("Server error. Please try again in a moment.");
      }
    },
    onError: () => setFormError("Google sign-in was cancelled or failed."),
  });

  return (
    <div className="ls-page">
      <div className="ls-card">
        <div className="ls-logoWrap">
          <div className="ls-logo"><GiVolleyballBall size={34} /></div>
        </div>

        <h1 className="ls-title">Welcome</h1>
        <p className="ls-subtitle">Log in to VolleyAI</p>

        <form className="ls-form" onSubmit={handleLogin}>
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
                if (formError) setFormError("");
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
                type={showPassword ? "text" : "password"}
                className={`ls-input password ${passwordError ? "ls-input-error" : ""}`}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError) setPasswordError("");
                  if (formError) setFormError("");
                }}
              />
              <button
                type="button"
                className="ls-eyeBtn"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <FiEyeOff size={18} /> : <FiEye size={18} />}
              </button>
            </div>

            {passwordError && <div className="ls-errorText">{passwordError}</div>}
          </div>

          {formError && (
            <div className="ls-formErrorRow">
              <span className="ls-formErrorIcon">!</span>
              <span className="ls-formErrorText">{formError}</span>
            </div>
          )}

          <button
            type="button"
            className="ls-forgotBtn"
            onClick={() => navigate("/forgot-password")}
          >
            Forgot password?
          </button>

          <button type="submit" className="ls-primaryBtn">
            Continue
          </button>
        </form>

        <div className="ls-signupRow">
          <span>Don't have an account?</span>
          <button type="button" className="ls-linkBtn" onClick={() => navigate("/signup")}>
            Sign up
          </button>
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