import net from "net";

interface LoginPacket {
	action: "login";
	username: string;
	password: string;
}

export interface AuthenticationSuccessResponse {
	response: "Success";
	message: string;
}

export interface AuthenticationFailureResponse {
	response: "Failure";
	error: string;
	message: string;
}

export type AuthenticationResponse =
	| AuthenticationSuccessResponse
	| AuthenticationFailureResponse;

interface PendingAuthentication {
	resolve: (response: AuthenticationResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

type ParsedPacket = Record<string, string>;

export default class TelnetService {
	private client: net.Socket | null = null;
	private authenticated: boolean = false;
	private buffer: string = "";
	private pendingAuthentication: PendingAuthentication | null = null;

	constructor(private readonly host: string, private readonly port: number) {
		this.validateConfiguration();
	}

	private validateConfiguration(): void {
		if (!this.host?.trim()) {
			throw new Error("TelnetService: Host is required");
		}

		if (
			!Number.isInteger(this.port) ||
			this.port < 1 ||
			this.port > 65535
		) {
			throw new Error("TelnetService: Port must be an integer between 1 and 65535");
		}
	}

	public async connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this.client) {
				console.log("TelnetService: Already connected");
				resolve();
				return;
			}

			const client = new net.Socket();
			let settled = false;

			const cleanup = () => {
				client.removeListener("connect", onConnect);
				client.removeListener("error", onError);
			}

			const onConnect = () => {
				if (settled) {
					return;
				}

				settled = true;
				cleanup();
				this.client = client;
				this.setupSocketListeners();
				resolve();
			}

			const onError = (err: Error) => {
				if (settled) {
					return;
				}

				settled = true;

				cleanup();

				client.destroy();

				reject(
					new Error(`Unable to connect to ${this.host}:${this.port}`, { cause: err })
				);
			}

			client.once("connect", onConnect);
			client.once("error", onError);

			client.connect(this.port, this.host);
		});
	}

	private setupSocketListeners(): void {
		if (!this.client) {
			throw new Error("TelnetService: Socket needs to be initialized first before setting up listeners");
		}

		this.client.setEncoding("utf8");
		// this.client.on("data", (data: string) => {
		//     this.handleIncomingData(data);
		// });
		this.client.on("error", (err: Error) => {
			this.handleSocketError(err);
		});
		this.client.on("close", () => {
			this.handleSocketClose();
		});
		this.client.on("timeout", () => {
			this.handleSocketTimeout();
		});
	}

	private handleIncomingData(data: string): void {
		// Ensure that client is connected before processing incoming data
		this.ensureConnected();

		// Ensure that client is authenticated before processing incoming data
		if (!this.authenticated) {
			throw new Error("TelnetService: Received data before authentication. Ignoring.");
		}

		this.buffer += data;

		// Packet framing happens here.
		// Example assumes each packet ends with \r\n.

		const packets = this.extractPackets();

		for (const packet of packets) {
			this.handlePacket(packet);
		}
	}

	private extractPackets(): string[] {
		const packets: string[] = [];

		let separatorIndex: number;

		while (
			(separatorIndex = this.buffer.indexOf("\r\n\r\n")) !== -1
		) {
			const packet =
				this.buffer.slice(0, separatorIndex);

			this.buffer =
				this.buffer.slice(separatorIndex + 4);

			if (packet.trim()) {
				packets.push(packet);
			}
		}

		return packets;
	}

	private handlePacket(packet: string): void {
		try {
			const parsed = this.parse(packet);

			console.log("Received packet:", parsed);

			// Route packet based on action/type here.
		} catch (error) {
			console.error(
				"Unable to parse Telnet packet:",
				error
			);
		}
	}

	private parse(rawPacket: string): ParsedPacket {
		console.log("Received Raw Packet:", rawPacket);
		const packet: ParsedPacket = {};

		const lines = rawPacket.split("\r\n");

		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}

			const separatorIndex = line.indexOf(":");

			if (separatorIndex === -1) {
				throw new Error(`Invalid packet line: "${line}"`);
			}

			const key = line
				.slice(0, separatorIndex)
				.trim()
				.toLowerCase();

			const value = line
				.slice(separatorIndex + 1)
				.trim();

			if (!key) {
				throw new Error(`Invalid packet line: "${line}"`);
			}

			packet[key] = value;
		}

		return packet;
	}

	private handleSocketError(error: Error): void {
		console.error("Telnet socket error:", error);
	}

	private handleSocketClose(): void {
		this.client = null;
		this.authenticated = false;

		console.log("Telnet connection closed.");
	}

	private handleSocketTimeout(): void {
		console.error(
			"Telnet connection timed out."
		);

		this.disconnect();
	}

	public disconnect(): void {
		if (!this.client) {
			return;
		}

		this.client.end();
		this.client.destroy();

		this.client = null;
		this.authenticated = false;
		this.buffer = "";
	}

	private ensureConnected(): void {
		if (!this.client || this.client.destroyed) {
			throw new Error(`TelnetService: Cannot authenticate, client is not connected.`);
		}
	}

	public async authenticate(username: string, password: string, timeoutMs: number = 5_000): Promise<void> {
		// Ensuring that we are connected before attempting authentication
		this.ensureConnected();

		// Validations for Username and Password
		if (!username?.trim()) {
			throw new Error("TelnetService: Username is required for authentication.");
		}

		if (!password?.trim()) {
			throw new Error("TelnetService: Password is required for authentication.");
		}

		if (
			!Number.isInteger(timeoutMs) ||
			timeoutMs <= 0
		) {
			throw new Error("TelnetService: Authentication timeout must be a positive integer.");
		}

		if (this.pendingAuthentication) {
			console.log("TelnetService: An authentication request is already in progress.");
			return;
		}

		const loginPacket: LoginPacket = {
			action: "login",
			username,
			password,
		};

		const response = await this.waitForAuthenticationResponse(loginPacket, timeoutMs);

		if (response.response === "Failure") {
			throw new Error(`TelnetService: Authentication failed. Reason: ${response.error || response.message || "Unknown"}`);
		}

		this.authenticated = true;
	}

	private sendPkt(packet: Record<string, any>): void {
		this.ensureConnected();

		const pktString = `
        Action: ${packet["action"]}\r\n
        Username: ${packet["username"]}\r\n
        Password: ${packet["password"]}\r\n
        \r\n`;

		this.client!.write(pktString);
	}

	private waitForAuthenticationResponse(loginPacket: LoginPacket, timeoutMs: number): Promise<AuthenticationResponse> {
		return new Promise((resolve, reject) => {

			const timeout = setTimeout(() => {
				this.pendingAuthentication = null;
				reject(new Error("TelnetService: Authentication response timed out."));
			}, timeoutMs); // Use the provided timeout value

			this.pendingAuthentication = {
				resolve,
				reject,
				timeout,
			};

			// Setting up a listener for the authentication response
			const onData = (data: Buffer) => {
				clearTimeout(timeout);
				// Once we receive data, we can remove the listener to avoid memory leaks
				this.client!.removeListener("data", onData);

				const responseStr = data.toString();
				// Parse the response string into an object
				const response = JSON.parse(responseStr);
				console.log("Authentication response received:", response);
				this.pendingAuthentication = null;
				resolve(response);
			};

			// Attach the listener to the client socket
			this.client!.on("data", onData);
			try {
				this.sendPkt(loginPacket);
			} catch (error) {
				clearTimeout(timeout);
				this.pendingAuthentication = null;

				reject(error);
			}
		});
	}

	public readData(): void {
		this.ensureConnected();

		if (!this.authenticated) {
			throw new Error("TelnetService: Not authenticated");
		}

		this.client!.on("data", (data: string) => {
			this.handleIncomingData(data);
		});
	}
}