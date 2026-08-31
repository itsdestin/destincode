// partykit/src/chess-room.ts
//
// Chess's own room. Deliberately IDENTICAL in design to connect-four-room.ts:
// it seats two players, handles a reconnection replacing a stale socket, and
// RELAYS every message to the other player. It knows no chess rules.
//
// WHY A RELAY AND NOT A REFEREE: the rules live in chess.js, which is a
// renderer dependency — this room has its own package.json and does not carry
// it. So legality is enforced on BOTH clients instead (`useChessGame.ts`
// re-validates every incoming move with chess.js and drops an illegal one).
// The practical difference is that a cheating client can waste its own peer's
// time but cannot make that peer's board accept an illegal move.
import type * as Party from "partykit/server";

const MAX_PLAYERS = 2;

export default class ChessRoom implements Party.Server {
  private players = new Map<string, string>(); // connectionId → username

  constructor(readonly room: Party.Room) {}

  onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const username = url.searchParams.get("username");
    if (!username) {
      connection.close(4000, "Missing username");
      return;
    }

    // Reconnection: the same username already in the room replaces its own
    // stale connection instead of being counted as a second player.
    let isReconnect = false;
    for (const [connId, name] of this.players) {
      if (name === username && connId !== connection.id) {
        this.players.delete(connId);
        for (const conn of this.room.getConnections()) {
          if (conn.id === connId) {
            conn.close(4001, "Superseded by reconnection");
            break;
          }
        }
        isReconnect = true;
        break;
      }
    }

    if (!isReconnect && this.players.size >= MAX_PLAYERS) {
      connection.send(JSON.stringify({ type: "room-full" }));
      connection.close(4002, "Room is full");
      return;
    }

    this.players.set(connection.id, username);

    // Tell the arriving player who is already here.
    for (const [connId, name] of this.players) {
      if (connId !== connection.id) {
        connection.send(JSON.stringify({ type: "player-joined", username: name }));
      }
    }

    // Tell everyone else, marking reconnections so a client can tell a socket
    // blip from a brand-new opponent (and therefore not reset the position).
    this.room.broadcast(
      JSON.stringify({
        type: "player-joined",
        username,
        reconnect: isReconnect,
      }),
      [connection.id],
    );
  }

  onMessage(message: string | ArrayBuffer, sender: Party.Connection) {
    if (typeof message !== "string") return;
    this.room.broadcast(message, [sender.id]);
  }

  onClose(connection: Party.Connection) {
    const username = this.players.get(connection.id);
    if (username) {
      this.players.delete(connection.id);
      this.room.broadcast(JSON.stringify({
        type: "player-left",
        username,
      }));
    }
  }

  onError(connection: Party.Connection) {
    this.onClose(connection);
  }
}
