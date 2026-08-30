import net from "node:net";

interface LoginPacket {
  action: "login";
  username: string;
  secret: number;
}

export interface AuthenticationSuccessResponse {
  Response: "Success";
  Message: string;
}

export interface AuthenticationFailureResponse {
  Response: "Failure";
  Errno: string;
  Message: string;
}

export type AuthenticationResponse =
  | AuthenticationSuccessResponse
  | AuthenticationFailureResponse;

export type ParsedPacket = Record<string, string>;

type PacketHandler = (packet: ParsedPacket) => void;

interface PendingAuthentication {
  resolve: (response: AuthenticationResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export default class TelnetService {
  private client: net.Socket | null = null;
  private connected = false;
  private authenticated = false;
  private buffer = "";
  private connectPromise: Promise<void> | null = null;
  private pendingAuthentication: PendingAuthentication | null = null;
  private readonly packetHandlers = new Set<PacketHandler>();

  constructor(private readonly host: string,private readonly port: number) {
    this.validateConfiguration();
  }

  public async connect(timeoutMs = 10_000): Promise<void> {
    if (this.isConnected()) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.validateTimeout(timeoutMs, "Connection");

    this.connectPromise = this.createConnection(timeoutMs);

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  public async authenticate(username: string,secret: number,timeoutMs = 5_000): Promise<void> {
    this.ensureConnected();

    if (!username.trim()) {
      throw new Error("TelnetService: Username is required.");
    }

    if (!Number.isFinite(secret)) {
      throw new Error("TelnetService: Secret must be a valid number.");
    }

    this.validateTimeout(timeoutMs, "Authentication");

    if (this.authenticated) {
      return;
    }

    if (this.pendingAuthentication) {
      throw new Error("TelnetService: Authentication is already in progress.");
    }

    const loginPacket: LoginPacket = {
      action: "login",
      username,
      secret,
    };

    const response = await this.sendAuthenticationRequest(
      loginPacket,
      timeoutMs,
    );

    if (response.Response === "Failure") {
      throw new Error(
        `TelnetService: Authentication failed. ${
          response.Errno || response.Message || "Unknown reason."
        }`,
      );
    }

    this.authenticated = true;

    console.log("TelnetService: Authentication succeeded.");
  }

  public onPacket(handler: PacketHandler): () => void {
    this.packetHandlers.add(handler);

    return () => {
      this.packetHandlers.delete(handler);
    };
  }

  public disconnect(): void {
    const client = this.client;

    this.client = null;
    this.connected = false;
    this.authenticated = false;
    this.buffer = "";

    this.rejectPendingAuthentication(
      new Error("TelnetService: Connection closed."),
    );

    if (!client) {
      return;
    }

    client.destroy();
  }

  public isConnected(): boolean {
    return this.connected && this.client !== null && !this.client.destroyed;
  }

  public isAuthenticated(): boolean {
    return this.authenticated;
  }

  private createConnection(timeoutMs: number): Promise<void> {
    const client = new net.Socket();

    this.client = client;
    this.connected = false;
    this.authenticated = false;
    this.buffer = "";

    client.setEncoding("utf8");

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        client.removeListener("connect", onConnect);

        if (this.client === client) {
          this.client = null;
          this.connected = false;
          this.authenticated = false;
          this.buffer = "";
        }

        client.destroy();

        reject(
          new Error(
            `TelnetService: Connection to ${this.host}:${this.port} timed out.`,
          ),
        );
      }, timeoutMs);

      const cleanupConnectListener = () => {
        clearTimeout(timeout);
        client.removeListener("connect", onConnect);
      };

      const onConnect = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanupConnectListener();

        if (this.client !== client) {
          client.destroy();
          reject(new Error("TelnetService: Connection was cancelled."));
          return;
        }

        this.connected = true;
        this.authenticated = false;
        console.log(`TelnetService: Connected to ${this.host}:${this.port}.`);
        resolve();
      };

      const onError = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanupConnectListener();

          if (this.client === client) {
            this.client = null;
            this.connected = false;
            this.authenticated = false;
            this.buffer = "";
          }

          reject(
            new Error(
              `TelnetService: Unable to connect to ${this.host}:${this.port}.`,
              { cause: error },
            ),
          );
        }

        this.handleSocketError(client, error);
      };

      const onClose = () => {
        if (!settled) {
          settled = true;
          cleanupConnectListener();
          reject(
            new Error(
              `TelnetService: Connection to ${this.host}:${this.port} was closed before it was established.`,
            ),
          );
        }

        this.handleSocketClose(client);
      };

      client.on("data", (data: string) => {
        this.handleIncomingData(data);
      });

      client.on("error", onError);
      client.on("close", onClose);

      client.once("connect", onConnect);

      client.connect(this.port, this.host);
    });
  }

  private handleIncomingData(data: string): void {
    if (!data) {
      return;
    }

    if (!this.client || !this.connected) {
      return;
    }

    this.buffer += data;

    const packets = this.extractPackets();

    for (const packet of packets) {
      this.handlePacket(packet);
    }
  }

  private extractPackets(): string[] {
    const packets: string[] = [];
    const delimiter = "\r\n\r\n";

    let separatorIndex: number;

    while ((separatorIndex = this.buffer.indexOf(delimiter)) !== -1) {
      const packet = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + delimiter.length);
      if (packet.trim()) {
        packets.push(packet);
      }
    }

    return packets;
  }

  private handlePacket(packet: string): void {
    const parsedPacket = this.parsePacket(packet);

    if (Object.keys(parsedPacket).length === 0) {
      return;
    }

    if (this.pendingAuthentication && parsedPacket.Response !== undefined) {
      const response = this.parseAuthenticationResponse(parsedPacket);
      this.resolvePendingAuthentication(response);
      return;
    }

    if (!this.authenticated) {
      console.warn("TelnetService: Received packet before authentication.");
      return;
    }

    for (const handler of this.packetHandlers) {
      try {
        handler(parsedPacket);
      } catch (error) {
        console.error("TelnetService: Packet handler failed:", error);
      }
    }
  }

  private parsePacket(message: string): ParsedPacket {
    const result: ParsedPacket = {};

    for (const line of message.split(/\r?\n/)) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key) {
        result[key] = value;
      }
    }
    return result;
  }

  private parseAuthenticationResponse(packet: ParsedPacket): AuthenticationResponse {
    const response = packet.Response?.trim().toLowerCase() ?? "";
    const message = packet.Message?.trim() ?? "";
    const errno = packet.Errno?.trim() ?? "";

    if (response === "success") {
      return {
        Response: "Success",
        Message: message || "Authentication succeeded.",
      };
    }

    if (response === "failure" || response === "error") {
      return {
        Response: "Failure",
        Errno: errno || "Unknown",
        Message: message || errno || "Authentication failed.",
      };
    }

    return {
      Response: "Failure",
      Errno: errno || "Unknown",
      Message: message || errno || "Unknown authentication response.",
    };
  }

  private sendAuthenticationRequest(packet: LoginPacket,timeoutMs: number): Promise<AuthenticationResponse> {
    const promise = new Promise<AuthenticationResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingAuthentication;
        if (!pending) {
          return;
        }
        this.pendingAuthentication = null;
        reject(new Error("TelnetService: Authentication response timed out."));
      }, timeoutMs);

      this.pendingAuthentication = {
        resolve,
        reject,
        timeout,
      };
    });

    try {
      this.sendLoginPacket(packet);
    } catch (error) {
      this.rejectPendingAuthentication(
        this.toError(
          error,
          "TelnetService: Unable to send authentication request.",
        ),
      );
    }
    return promise;
  }

  private sendLoginPacket(packet: LoginPacket): void {
    this.ensureConnected();
    const client = this.client;
    if (!client) {
      throw new Error("TelnetService: Client is not connected.");
    }

    const message = [
      "Action: login",
      `Username: ${packet.username}`,
      `Secret: ${packet.secret}`,
      "",
      "",
    ].join("\r\n");

    client.write(message);
  }

  private resolvePendingAuthentication(response: AuthenticationResponse): void {
    const pending = this.pendingAuthentication;

    if (!pending) {
      return;
    }

    this.pendingAuthentication = null;
    clearTimeout(pending.timeout);
    pending.resolve(response);
  }

  private rejectPendingAuthentication(error: Error): void {
    const pending = this.pendingAuthentication;

    if (!pending) {
      return;
    }

    this.pendingAuthentication = null;
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private handleSocketError(client: net.Socket, error: Error): void {
    this.rejectPendingAuthentication(
      new Error("TelnetService: Socket error.", { cause: error }),
    );

    if (this.client === client) {
      this.client = null;
      this.connected = false;
      this.authenticated = false;
      this.buffer = "";
    }

    client.destroy();
  }

  private handleSocketClose(client: net.Socket): void {
    if (this.client !== client) {
      return;
    }

    this.client = null;
    this.connected = false;
    this.authenticated = false;
    this.buffer = "";

    this.rejectPendingAuthentication(
      new Error("TelnetService: Telnet connection closed."),
    );

    console.log("TelnetService: Connection closed.");
  }

  private ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error("TelnetService: Client is not connected.");
    }
  }

  private validateConfiguration(): void {
    if (!this.host.trim()) {
      throw new Error("TelnetService: Host is required.");
    }

    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65_535) {
      throw new Error(
        "TelnetService: Port must be an integer between 1 and 65535.",
      );
    }
  }

  private validateTimeout(timeoutMs: number,type: "Connection" | "Authentication"): void {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `TelnetService: ${type} timeout must be a positive integer.`,
      );
    }
  }

  private toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(fallbackMessage, {
      cause: error,
    });
  }
}
