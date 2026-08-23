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

	/**
	 * TCP is a stream and does not preserve packet boundaries.
	 *
	 * A packet can be split across multiple "data" events, or multiple
	 * packets can arrive in a single "data" event.
	 *
	 * This buffer holds incomplete data until \r\n\r\n is received.
	 */
	private buffer = "";

	/**
	 * Used to prevent concurrent connect() calls from creating
	 * multiple sockets.
	 */
	private connectPromise: Promise<void> | null = null;

	/**
	 * Only one authentication request can be active at a time.
	 */
	private pendingAuthentication: PendingAuthentication | null = null;

	/**
	 * Application-level packet subscribers.
	 */
	private readonly packetHandlers = new Set<PacketHandler>();

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {
		this.validateConfiguration();
	}

	/**
	 * Connect to the Telnet server.
	 *
	 * Calling connect() when already connected is safe.
	 *
	 * Calling connect() multiple times concurrently will cause all
	 * callers to wait for the same connection attempt.
	 */
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
			/*
			 * Only clear our reference to the connection attempt after
			 * the promise has settled.
			 */
			this.connectPromise = null;
		}
	}

	/**
	 * Authenticate with the Telnet server.
	 *
	 * The Telnet protocol expects the secret as a number.
	 */
	public async authenticate(
		username: string,
		secret: number,
		timeoutMs = 5_000,
	): Promise<void> {
		this.ensureConnected();

		if (!username.trim()) {
			throw new Error(
				"TelnetService: Username is required.",
			);
		}

		if (!Number.isFinite(secret)) {
			throw new Error(
				"TelnetService: Secret must be a valid number.",
			);
		}

		this.validateTimeout(timeoutMs, "Authentication");

		if (this.authenticated) {
			return;
		}

		if (this.pendingAuthentication) {
			throw new Error(
				"TelnetService: Authentication is already in progress.",
			);
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
					response.Errno ||
					response.Message ||
					"Unknown reason."
				}`,
			);
		}

		this.authenticated = true;

		console.log(
			"TelnetService: Authentication succeeded.",
		);
	}

	/**
	 * Subscribe to packets received after authentication.
	 *
	 * Returns an unsubscribe function.
	 */
	public onPacket(handler: PacketHandler): () => void {
		this.packetHandlers.add(handler);

		return () => {
			this.packetHandlers.delete(handler);
		};
	}

	/**
	 * Disconnect from the Telnet server.
	 *
	 * This is safe to call multiple times.
	 */
	public disconnect(): void {
		const client = this.client;

		/*
		 * Clear service state first.
		 *
		 * This is important because socket.destroy() can synchronously
		 * cause socket lifecycle events to be emitted.
		 */
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
		return (
			this.connected &&
			this.client !== null &&
			!this.client.destroyed
		);
	}

	public isAuthenticated(): boolean {
		return this.authenticated;
	}

	/**
	 * Creates and establishes the socket connection.
	 *
	 * The socket's permanent error/close/data listeners are installed
	 * here. There is intentionally only ONE "data" listener for the
	 * lifetime of the socket.
	 */
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

				/*
				 * Remove this socket from the service before destroying it.
				 * This prevents its later "close" event from affecting a
				 * future connection.
				 */
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

				/*
				 * The socket may have been replaced/disconnected while
				 * the connection event was being processed.
				 */
				if (this.client !== client) {
					client.destroy();

					reject(
						new Error(
							"TelnetService: Connection was cancelled.",
						),
					);

					return;
				}

				this.connected = true;
				this.authenticated = false;

				resolve();
			};

			const onError = (error: Error) => {
				/*
				 * If this happens before "connect", this error belongs
				 * to the connection attempt.
				 */
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

				/*
				 * If the socket is already connected, the same listener
				 * handles normal socket errors.
				 */
				this.handleSocketError(client, error);
			};

			const onClose = () => {
				/*
				 * A socket can close without first emitting "error".
				 * Therefore "close" must also reject a connection attempt.
				 */
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

			/*
			 * Install permanent listeners before connect().
			 *
			 * This avoids races where the server responds immediately
			 * after the connection is established.
			 */
			client.on("data", (data: string) => {
				this.handleIncomingData(data);
			});

			client.on("error", onError);
			client.on("close", onClose);

			client.once("connect", onConnect);

			client.connect(this.port, this.host);
		});
	}

	/**
	 * Process raw TCP data.
	 */
	private handleIncomingData(data: string): void {
		if (!data) {
			return;
		}

		/*
		 * If this socket has already been disconnected, don't process
		 * stale data.
		 */
		if (!this.client || !this.connected) {
			return;
		}

		this.buffer += data;

		const packets = this.extractPackets();

		for (const packet of packets) {
			this.handlePacket(packet);
		}
	}

	/**
	 * Extract complete packets from the buffer.
	 *
	 * Packet delimiter:
	 *
	 *     \r\n\r\n
	 *
	 * Examples handled correctly:
	 *
	 *     packet
	 *
	 *     packet + partial-next-packet
	 *
	 *     packet1 + packet2 + packet3
	 */
	private extractPackets(): string[] {
		const packets: string[] = [];
		const delimiter = "\r\n\r\n";

		let separatorIndex: number;

		while (
			(separatorIndex = this.buffer.indexOf(delimiter)) !== -1
		) {
			const packet = this.buffer.slice(
				0,
				separatorIndex,
			);

			this.buffer = this.buffer.slice(
				separatorIndex + delimiter.length,
			);

			if (packet.trim()) {
				packets.push(packet);
			}
		}

		return packets;
	}

	/**
	 * Process one complete packet.
	 */
	private handlePacket(packet: string): void {
		const parsedPacket = this.parsePacket(packet);

		if (Object.keys(parsedPacket).length === 0) {
			return;
		}

		/*
		 * Authentication response handling has priority while an
		 * authentication request is pending.
		 *
		 * We only treat a packet as an authentication response if
		 * it contains a Response field.
		 *
		 * This prevents an unrelated packet from accidentally resolving
		 * the authentication promise.
		 */
		if (
			this.pendingAuthentication &&
			parsedPacket.Response !== undefined
		) {
			const response =
				this.parseAuthenticationResponse(
					parsedPacket,
				);

			this.resolvePendingAuthentication(response);

			return;
		}

		/*
		 * Ignore packets received before authentication.
		 *
		 * Do NOT throw from this asynchronous socket callback.
		 */
		if (!this.authenticated) {
			console.warn(
				"TelnetService: Received packet before authentication.",
			);

			return;
		}

		console.log(
			"TelnetService: Received packet:",
			parsedPacket,
		);

		for (const handler of this.packetHandlers) {
			try {
				handler(parsedPacket);
			} catch (error) {
				/*
				 * An application packet handler should never be able
				 * to crash the socket's data event.
				 */
				console.error(
					"TelnetService: Packet handler failed:",
					error,
				);
			}
		}
	}

	/**
	 * Parse:
	 *
	 *     Key: Value
	 *
	 * into:
	 *
	 *     {
	 *         Key: "Value"
	 *     }
	 */
	private parsePacket(message: string): ParsedPacket {
		const result: ParsedPacket = {};

		for (const line of message.split(/\r?\n/)) {
			const separatorIndex = line.indexOf(":");

			if (separatorIndex === -1) {
				continue;
			}

			const key = line
				.slice(0, separatorIndex)
				.trim();

			const value = line
				.slice(separatorIndex + 1)
				.trim();

			if (key) {
				result[key] = value;
			}
		}

		return result;
	}

	/**
	 * Parse an authentication response.
	 */
	private parseAuthenticationResponse(
		packet: ParsedPacket,
	): AuthenticationResponse {
		const response =
			packet.Response?.trim().toLowerCase() ?? "";

		const message =
			packet.Message?.trim() ?? "";

		const errno =
			packet.Errno?.trim() ?? "";

		if (response === "success") {
			return {
				Response: "Success",
				Message:
					message ||
					"Authentication succeeded.",
			};
		}

		if (
			response === "failure" ||
			response === "error"
		) {
			return {
				Response: "Failure",
				Errno: errno || "Unknown",
				Message:
					message ||
					errno ||
					"Authentication failed.",
			};
		}

		return {
			Response: "Failure",
			Errno: errno || "Unknown",
			Message:
				message ||
				errno ||
				"Unknown authentication response.",
		};
	}

	/**
	 * Creates the authentication promise and registers its pending
	 * state BEFORE writing to the socket.
	 *
	 * This ordering is critical.
	 *
	 * The server may respond immediately after write(), so the
	 * authentication state must already exist before write() occurs.
	 */
	private sendAuthenticationRequest(
		packet: LoginPacket,
		timeoutMs: number,
	): Promise<AuthenticationResponse> {
		const promise = new Promise<AuthenticationResponse>(
			(resolve, reject) => {
				const timeout = setTimeout(() => {
					/*
					 * Only clear the pending request if this is still
					 * the active authentication request.
					 */
					const pending =
						this.pendingAuthentication;

					if (!pending) {
						return;
					}

					this.pendingAuthentication = null;

					reject(
						new Error(
							"TelnetService: Authentication response timed out.",
						),
					);
				}, timeoutMs);

				this.pendingAuthentication = {
					resolve,
					reject,
					timeout,
				};
			},
		);

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

	/**
	 * Send the login packet.
	 *
	 * Resulting wire format:
	 *
	 *     Action: login\r\n
	 *     Username: username\r\n
	 *     Secret: 123456\r\n
	 *     \r\n
	 */
	private sendLoginPacket(packet: LoginPacket): void {
		this.ensureConnected();

		const client = this.client;

		if (!client) {
			throw new Error(
				"TelnetService: Client is not connected.",
			);
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

	/**
	 * Resolve the currently pending authentication request.
	 */
	private resolvePendingAuthentication(
		response: AuthenticationResponse,
	): void {
		const pending =
			this.pendingAuthentication;

		if (!pending) {
			return;
		}

		this.pendingAuthentication = null;

		clearTimeout(pending.timeout);

		pending.resolve(response);
	}

	/**
	 * Reject the currently pending authentication request.
	 */
	private rejectPendingAuthentication(
		error: Error,
	): void {
		const pending =
			this.pendingAuthentication;

		if (!pending) {
			return;
		}

		this.pendingAuthentication = null;

		clearTimeout(pending.timeout);

		pending.reject(error);
	}

	/**
	 * Handle a socket error.
	 *
	 * Socket errors are asynchronous events, so we do NOT throw here.
	 *
	 * A socket error is treated as a broken connection and the socket
	 * is destroyed.
	 */
	private handleSocketError(
		client: net.Socket,
		error: Error,
	): void {
		console.error(
			"TelnetService: Socket error:",
			error,
		);

		this.rejectPendingAuthentication(
			new Error(
				"TelnetService: Socket error.",
				{ cause: error },
			),
		);

		/*
		 * Only change service state if this is still our active socket.
		 *
		 * This prevents an old socket's delayed events from modifying
		 * the state of a newer connection.
		 */
		if (this.client === client) {
			this.client = null;
			this.connected = false;
			this.authenticated = false;
			this.buffer = "";
		}

		client.destroy();
	}

	/**
	 * Handle socket closure.
	 */
	private handleSocketClose(
		client: net.Socket,
	): void {
		/*
		 * An old socket can emit "close" after a new socket has already
		 * been created.
		 *
		 * Never let the old socket modify the new connection's state.
		 */
		if (this.client !== client) {
			return;
		}

		this.client = null;
		this.connected = false;
		this.authenticated = false;
		this.buffer = "";

		this.rejectPendingAuthentication(
			new Error(
				"TelnetService: Telnet connection closed.",
			),
		);

		console.log(
			"TelnetService: Connection closed.",
		);
	}

	private ensureConnected(): void {
		if (!this.isConnected()) {
			throw new Error(
				"TelnetService: Client is not connected.",
			);
		}
	}

	private validateConfiguration(): void {
		if (!this.host.trim()) {
			throw new Error(
				"TelnetService: Host is required.",
			);
		}

		if (
			!Number.isInteger(this.port) ||
			this.port < 1 ||
			this.port > 65_535
		) {
			throw new Error(
				"TelnetService: Port must be an integer between 1 and 65535.",
			);
		}
	}

	private validateTimeout(
		timeoutMs: number,
		type: "Connection" | "Authentication",
	): void {
		if (
			!Number.isInteger(timeoutMs) ||
			timeoutMs <= 0
		) {
			throw new Error(
				`TelnetService: ${type} timeout must be a positive integer.`,
			);
		}
	}

	private toError(
		error: unknown,
		fallbackMessage: string,
	): Error {
		if (error instanceof Error) {
			return error;
		}

		return new Error(fallbackMessage, {
			cause: error,
		});
	}
}
