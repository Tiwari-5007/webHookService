interface TelnetConfig {
    host: string;
    port: number;
    username: string;
    secret: number;
}

export function validateAndGetTelnetConfig(): TelnetConfig {
    const configToValidate = ["TELNET_HOST", "TELNET_PORT", "TELNET_USERNAME", "TELNET_SECRET"];
    
    // All the Above environment variables are required, so we validate them here.
    configToValidate.forEach((key) => {
        if (!process.env[key]) {
            throw new Error(`Environment variable ${key} is required.`);
        }
    });

    // Validation for PORT it should be a number between 1 and 65535
    const port = Number(process.env.TELNET_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("TELNET_PORT must be an integer between 1 and 65535.");
    }

    const secret = Number(process.env.TELNET_SECRET);
    if (!Number.isFinite(secret)) {
        throw new Error("TELNET_SECRET must be a valid number.");
    }

    return {
        host: process.env.TELNET_HOST as string,
        port,
        username: process.env.TELNET_USERNAME as string,
        secret
    }
}