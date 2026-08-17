import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type { ShadeGuardGateway } from "./gateway.js";

const MAX_COMMAND_BYTES = 16_384;

type ApprovalCommand =
  | { readonly action: "health" }
  | { readonly action: "list" }
  | { readonly action: "approve"; readonly approvalId: string };

interface ControlResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

async function socketIsActive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export class ApprovalControlServer {
  private server?: Server;

  public constructor(
    private readonly gateway: ShadeGuardGateway,
    public readonly socketPath: string,
  ) {}

  public async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(this.socketPath);
      if (!stat.isSocket()) throw new Error("Approval control path exists and is not a Unix socket");
      if (await socketIsActive(this.socketPath)) throw new Error("Another approval control server is active");
      await unlink(this.socketPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, resolve);
    });
    await chmod(this.socketPath, 0o600);
  }

  public async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    delete this.server;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    try {
      await unlink(this.socketPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  private handleConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_COMMAND_BYTES) {
        this.respond(socket, { ok: false, error: "Command exceeds size limit" });
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = "";
      this.dispatch(line)
        .then((response) => this.respond(socket, response))
        .catch(() => this.respond(socket, { ok: false, error: "Approval command failed" }));
    });
    socket.on("error", () => {
      socket.destroy();
    });
  }

  private async dispatch(line: string): Promise<ControlResponse> {
    let command: ApprovalCommand;
    try {
      command = JSON.parse(line) as ApprovalCommand;
    } catch {
      return { ok: false, error: "Command is not valid JSON" };
    }

    if (command.action === "health") return { ok: true, result: { status: "ready" } };
    if (command.action === "list") return { ok: true, result: this.gateway.listApprovals() };
    if (command.action === "approve" && typeof command.approvalId === "string" && command.approvalId.length > 0) {
      return { ok: true, result: this.gateway.approve(command.approvalId) };
    }
    return { ok: false, error: "Unsupported approval command" };
  }

  private respond(socket: Socket, response: ControlResponse): void {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(response)}\n`);
  }
}

export async function sendApprovalCommand(socketPath: string, command: ApprovalCommand): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let response = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_COMMAND_BYTES * 4) {
        socket.destroy();
        reject(new Error("Approval response exceeds size limit"));
      }
    });
    socket.once("end", () => {
      try {
        resolve(JSON.parse(response) as ControlResponse);
      } catch {
        reject(new Error("Approval server returned invalid JSON"));
      }
    });
    socket.once("error", reject);
  });
}
