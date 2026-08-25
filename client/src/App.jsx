import { useState } from "react";
import JoinScreen from "./components/JoinScreen.jsx";
import Room from "./components/Room.jsx";

export default function App() {
  const [session, setSession] = useState(null); // { room, name }

  if (!session) {
    return <JoinScreen onJoined={setSession} />;
  }

  return <Room initialRoom={session.room} name={session.name} onLeave={() => setSession(null)} />;
}
