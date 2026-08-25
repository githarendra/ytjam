import { io } from "socket.io-client";

// In a single-service deploy (the server serves the built client itself —
// see server.js), the socket should connect to whatever origin served the
// page, no configuration needed. VITE_SERVER_URL overrides this for local
// dev (client and server run on different ports) or a split deploy (client
// and server hosted separately).
const SERVER_URL = import.meta.env.VITE_SERVER_URL || (import.meta.env.PROD ? "" : "http://localhost:4000");

export const socket = io(SERVER_URL || undefined, { autoConnect: true });
export const API_BASE = SERVER_URL; // "" here correctly resolves relative fetch("/api/...") calls to same origin
