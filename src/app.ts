import "dotenv/config";

import TelnetService from "./services/telnetService";

function getRequiredEnvironmentVariable(
	name: string,
): string {
	const value = process.env[name]?.trim();

	if (!value) {
		throw new Error(
			`Environment variable ${name} is required.`,
		);
	}

	return value;
}

function getPort(): number {
	const value =
		process.env.TELNET_PORT?.trim() || "23";

	const port = Number(value);

	if (
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535
	) {
		throw new Error(
			"TELNET_PORT must be an integer between 1 and 65535.",
		);
	}

	return port;
}

function getSecret(): number {
	const value =
		getRequiredEnvironmentVariable(
			"TELNET_SECRET",
		);

	const secret = Number(value);

	if (!Number.isFinite(secret)) {
		throw new Error(
			"TELNET_SECRET must be a valid number.",
		);
	}

	return secret;
}

let telnetService: TelnetService | null = null;

async function main(): Promise<void> {
	const host =
		getRequiredEnvironmentVariable(
			"TELNET_HOST",
		);

	const port = getPort();

	const username =
		getRequiredEnvironmentVariable(
			"TELNET_USERNAME",
		);

	const secret = getSecret();

	telnetService = new TelnetService(
		host,
		port,
	);

	await telnetService.connect();

	console.log(
		"Connected to the Telnet server.",
	);

	await telnetService.authenticate(
		username,
		secret,
	);

	console.log(
		"Authenticated successfully.",
	);

	telnetService.onPacket((packet) => {
		/*
		 * Handle packets received from the Telnet server here.
		 *
		 * Example:
		 *
		 * if (packet.Action === "status") {
		 *     // Handle status packet.
		 * }
		 */
		console.log(
			"Received packet:",
			packet,
		);
	});
}

function shutdown(signal: string): void {
	console.log(
		`Received ${signal}. Shutting down...`,
	);

	telnetService?.disconnect();
}

process.once("SIGINT", () => {
	shutdown("SIGINT");
});

process.once("SIGTERM", () => {
	shutdown("SIGTERM");
});

void main().catch((error: unknown) => {
	console.error(
		"Telnet service failed:",
		error,
	);

	telnetService?.disconnect();

	process.exitCode = 1;
});