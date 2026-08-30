import {
    ResultSetHeader,
    RowDataPacket
} from "mysql2/promise";

import { getDatabasePool } from "../database/dbConnection";

type QueryParams = (
    string |
    number |
    boolean |
    null |
    Date |
    Buffer
)[];


export async function select<T extends RowDataPacket[]>(
    sql: string,
    params: QueryParams = []
): Promise<T> {

    const pool = getDatabasePool();

    const [rows] = await pool.execute<T>(
        sql,
        params
    );

    return rows;
}


export async function insert(
    sql: string,
    params: QueryParams = []
): Promise<ResultSetHeader> {

    const pool = getDatabasePool();

    const [result] = await pool.execute<ResultSetHeader>(
        sql,
        params
    );

    return result;
}


export async function update(
    sql: string,
    params: QueryParams = []
): Promise<ResultSetHeader> {

    const pool = getDatabasePool();

    const [result] = await pool.execute<ResultSetHeader>(
        sql,
        params
    );

    return result;
}


export async function remove(
    sql: string,
    params: QueryParams = []
): Promise<ResultSetHeader> {

    const pool = getDatabasePool();

    const [result] = await pool.execute<ResultSetHeader>(
        sql,
        params
    );

    return result;
}

export interface RuleRow extends RowDataPacket {
    field_rule_id: number;
    campaign_id: number;
    rule_name: string;
    state: string;
    event_list: string;
    event_data: Record<string, string>;
    event_fields: Record<string, string>;
}

export async function getAllActiveRules(): Promise<RuleRow[]> {
    try {
        const pool = getDatabasePool();
    
        const [result] = await pool.execute<RuleRow[]>(`Select field_rule_id, campaign_id, rule_name, state, event_list, event_data, event_fields from field_integration_rule_new where state = ?`,["ACTIVE"]);

        return result;
    } catch (error) {
        throw new Error(`Database query failed`,{cause: error});
    }
}
