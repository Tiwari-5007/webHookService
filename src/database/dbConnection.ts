import mysql, { Pool } from "mysql2/promise";
import { validateAndGetDatabaseConfig } from "../config/";

let pool: Pool | null = null;

export function getDatabasePool(): Pool {
    if (pool) {
        return pool;
    }

    const config = validateAndGetDatabaseConfig();

    pool = mysql.createPool({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database,

        waitForConnections: true,
        connectionLimit: 10,
        maxIdle: 10,
        idleTimeout: 60000,
        queueLimit: 0,

        enableKeepAlive: true,
        keepAliveInitialDelay: 0
    });

    return pool;
}

export async function checkDatabaseConnection(): Promise<void> {
    const pool = getDatabasePool();
    const connection = await pool.getConnection();

    try {
        await connection.ping();
        console.log("Database connected successfully.");
    } finally {
        connection.release();
    }
}
