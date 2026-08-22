import TelnetService from "./services/telnetService";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();
const host = process.env.TELNET_HOST || "localhost";
const port = parseInt(process.env.TELNET_PORT || "23", 10);

const username = process.env.TELNET_USERNAME || "username";
const password = process.env.TELNET_PASSWORD || "password";

async function main() {
    let telnetService: TelnetService | null = null;
    try {
        // Create an instance of TelnetService with the appropriate host and port
        telnetService = new TelnetService(host, port);

        // Connect to the Telnet server
        await telnetService.connect();
        console.log("Connected to the Telnet server.");

        // Authenticate with the Telnet server
        await telnetService.authenticate(username, password);
        console.log("Authenticated successfully.");

        // Read data from the Telnet server
        telnetService.readData();

    } catch (error) {
        console.error(error);
        if (telnetService) {
            telnetService.disconnect();
        }
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});