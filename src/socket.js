import { Server } from "socket.io";

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io/",
    cors: { origin: true, credentials: true },
  });

  io.on("connection", async (socket) => {
    const userId = socket.handshake.auth?.userId;
    if (userId) {
      socket.join(`user:${userId}`);
      socket.data.userId = userId;
    }

    socket.on("join_pod", async (data, ack) => {
      const podId = data?.podId;
      if (podId) {
        socket.join(`pod:${podId}`);
        if (typeof ack === "function") ack({ ok: true, podId });
        return;
      }
      if (typeof ack === "function") ack({ ok: false });
    });

    socket.on("leave_pod", async (data, ack) => {
      const podId = data?.podId;
      if (podId) socket.leave(`pod:${podId}`);
      if (typeof ack === "function") ack({ ok: true });
    });
  });

  return io;
}
