import { Routes, Route } from "react-router-dom";

import Login from "./components/Login";
import SignUp from "./components/SignUp";
import HomeScreen from "./components/Home_screen";
import ForgotPassword from "./components/ForgotPassword.jsx";
import ResetPassword from "./components/ResetPassword.jsx";
import UploadVideo from "./components/UploadVideo.jsx";
import TeamsRoster from "./components/TeamsRoster.jsx";
import VideoAnalysis from "./components/VideoAnalysis.jsx";
import MatchStatistics from "./components/MatchStatistics.jsx";
import PlayerRegistry from "./components/PlayerRegistry.jsx";
import MatchAnalysis from "./components/MatchAnalysis.jsx";
import JerseySetup from "./components/JerseySetup.jsx";
import CourtSetup from "./components/CourtSetup.jsx";
import MyTeamRoster from "./components/MyTeamRoster.jsx";
import PlayerMerge from "./components/PlayerMerge.jsx";


export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/home" element={<HomeScreen />} />
      <Route path="/upload-video" element={<UploadVideo />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/teams-roster/:videoId" element={<TeamsRoster />} />
      <Route path="/video-analysis/:videoId" element={<VideoAnalysis />} />
      <Route path="/match-statistics/:videoId" element={<MatchStatistics />} />
      <Route path="/match-statistics" element={<MatchStatistics />} />
      <Route path="/player-registry" element={<PlayerRegistry />} />
      <Route path="/jersey-setup/:videoId" element={<JerseySetup />} />
      <Route path="/match-analysis/:videoId" element={<MatchAnalysis />} />
      <Route path="/court-setup/:videoId" element={<CourtSetup />} />
      <Route path="/my-team" element={<MyTeamRoster />} />
      <Route path="/player-merge/:videoId" element={<PlayerMerge />} />
    </Routes>
  );
}