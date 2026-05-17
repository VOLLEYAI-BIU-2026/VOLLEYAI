import { Routes, Route } from "react-router-dom";

import Login from "./components/login";
import SignUp from "./components/SignUp";
import HomeScreen from "./components/home_screen";
import ForgotPassword from "./components/ForgotPassword.jsx";
import ResetPassword from "./components/ResetPassword.jsx";
import UploadVideo from "./components/UploadVideo.jsx";
import CourtSetup from "./components/CourtSetup.jsx";
import TeamsRoster from "./components/TeamsRoster.jsx";
import VideoAnalysis from "./components/VideoAnalysis.jsx";


export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/home" element={<HomeScreen />} />
      <Route path="/upload-video" element={<UploadVideo />} />
      <Route path="/court-setup/:videoId" element={<CourtSetup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/teams-roster/:videoId" element={<TeamsRoster />} />
      <Route path="/video-analysis/:videoId" element={<VideoAnalysis />} />
    </Routes>
  );
}