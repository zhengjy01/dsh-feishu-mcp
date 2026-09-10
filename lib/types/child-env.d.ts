/**
 * dsh-feishu — child-process environment.
 *
 * The MCP server is spawned as a child process. DSH itself can be
 * started by launchd (the shipped `com.dsh.web` service), whose PATH is only
 * `/usr/bin:/bin`, so a bare `npx` / `uvx` fails with
 * ENOENT even though it is installed. Every spawned server therefore receives
 * a PATH that also carries the well-known install directories.
 */
/**
 * The inherited PATH with every existing well-known bin directory appended.
 * @returns a PATH value safe to hand to a spawned child process.
 */
export declare function extendedPath(): string;
