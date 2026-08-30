interface DatabaseConfig {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
}

export function validateAndGetDatabaseConfig(): DatabaseConfig {
    const configToValidate = ["DB_HOST", "DB_PORT", "DB_USERNAME", "DB_PASSWORD", "DB_NAME"];

    for (const key of configToValidate) {
        if (!process.env[key]) {
            throw new Error(`Missing required environment variable: ${key}`);
        }
    }

    const port = parseInt(process.env.DB_PORT!, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error("DB_PORT must be a valid integer between 1 and 65535.");
    }

    return {
        host: process.env.DB_HOST!,
        port: port,
        username: process.env.DB_USERNAME!,
        password: process.env.DB_PASSWORD!,
        database: process.env.DB_NAME!
    };
}