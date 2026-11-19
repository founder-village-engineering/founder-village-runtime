import { loadModule, parseSync } from "libpg-query";
import { denied } from "../../packages/auth/index.ts";

await loadModule();

// PostgreSQL's parser handles comments, quoted identifiers, dollar strings,
// CTEs and statement separators. A keyword/semicolon filter is insufficient.
export function readOnlySql(sql: string): void {
  let parsed: { stmts?: { stmt?: Record<string, unknown> }[] };
  try {
    parsed = parseSync(sql);
  } catch {
    denied(400);
  }
  if (!parsed.stmts?.length || parsed.stmts.length > 20) denied(403);
  let nodes = 0;
  const visit = (value: unknown, depth = 0): void => {
    if (++nodes > 20000 || depth > 80) denied(403);
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        (key.endsWith("Stmt") &&
          !["SelectStmt", "ExplainStmt"].includes(key)) ||
        key === "intoClause" ||
        key === "lockingClause"
      )
        denied(403);
      if (key === "FuncCall") {
        const call = child as { funcname?: { String?: { sval?: string } }[] };
        const name = call.funcname?.at(-1)?.String?.sval?.toLowerCase() ?? "";
        if (
          name === "set_config" ||
          name === "pg_notify" ||
          /^(pg_(sleep|advisory|try_advisory|cancel_backend|terminate_backend|read_file|read_binary_file)|dblink|lo_)/.test(
            name,
          )
        )
          denied(403);
      }
      visit(child, depth + 1);
    }
  };
  for (const statement of parsed.stmts) {
    const keys = Object.keys(statement.stmt ?? {});
    if (keys.length !== 1 || !["SelectStmt", "ExplainStmt"].includes(keys[0]!))
      denied(403);
    visit(statement.stmt);
  }
}
