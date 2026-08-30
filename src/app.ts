import "dotenv/config";
import TelnetService from "./services/telnetService";
import { validateAndGetTelnetConfig } from "./config/";
import { checkDatabaseConnection } from "./database/dbConnection";
import RuleService from "./services/ruleService";

let telnetService: TelnetService | null = null;
let ruleService  : RuleService   | null = null;

async function main(): Promise<void> {
	
	// Check the Database connection before starting the Telnet service.
	await checkDatabaseConnection();

	const { host, port, username, secret } = validateAndGetTelnetConfig();

	// Crate an instance of the TelnetService with the validated configuration.
	telnetService = new TelnetService(host,port);

	// Connect to the Telnet server.
	await telnetService.connect();

	// Authenticate with the Telnet server using the provided username and secret.
	await telnetService.authenticate(username,secret);

	ruleService = new RuleService();
	await ruleService?.loadHashes();
	const hashes = ruleService.getHashes("campaignMap");
	console.dir(hashes, { depth: null });

	// Set up a packet handler to process incoming packets from the Telnet server.
	telnetService.onPacket((packet) => {
		console.log("Received packet:",packet);
		ruleService?.processEvents(packet);
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