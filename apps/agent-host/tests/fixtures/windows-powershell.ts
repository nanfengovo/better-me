/** A legacy PowerShell child must not inherit a PowerShell 7 module search path. */
export function windowsPowerShellEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
}
