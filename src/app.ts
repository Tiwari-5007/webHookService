import "dotenv/config";
import TelnetService from "./services/telnetService";

let telnetService: TelnetService | null = null;

async function main(): Promise<void> {

	// Crate an instance of the TelnetService with the validated configuration.
	const host = process.env.TELNET_HOST;
	const port = Number(process.env.TELNET_PORT);
	if (!host || !port) {
		throw new Error("TELNET_HOST and TELNET_PORT must be set in the environment variables.");
	}
	telnetService = new TelnetService(host,port);

	// Connect to the Telnet server.
	await telnetService.connect();

	// Authenticate with the Telnet server using the provided username and secret.
	const username = process.env.TELNET_USERNAME;
	let secret = Number(process.env.TELNET_SECRET);
	if (!username || !secret) {
		throw new Error("TELNET_USERNAME and TELNET_SECRET must be set in the environment variables.");
	}

	await telnetService.authenticate(username,secret);

	// Set up a packet handler to process incoming packets from the Telnet server.
	telnetService.onPacket((packet) => {
		console.log("Received packet:",packet);
	});
}

function shutdown(signal: string): void {
	console.log(`Received ${signal}. Shutting down...`,);
	telnetService?.disconnect();
}

process.once("SIGINT", () => {
	shutdown("SIGINT");
});

process.once("SIGTERM", () => {
	shutdown("SIGTERM");
});

void main().catch((error: unknown) => {
	console.error("Telnet service failed:", error);
	telnetService?.disconnect();
	process.exitCode = 1;
});