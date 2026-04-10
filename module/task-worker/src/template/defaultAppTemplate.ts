export function createDefaultAppTemplate(task: string): string {
  const escapedTask = JSON.stringify(task);

  return `export default async function run(host) {
  const task = ${escapedTask};
  const memory = await host.readMemory();

  await host.appendProgress({
    phase: "app",
    message: "Running generated fallback task app",
    updatedFiles: [],
  });

  const resultBody = [
    "# Task Result",
    "",
    "## Task",
    "",
    task.trim(),
    "",
    "## Memory",
    "",
    memory ? memory.trim() : "_empty_",
    "",
    "## Outcome",
    "",
    "No specialized AI-generated app was returned. The fallback app captured the task and memory context."
  ].join("\\n");

  await host.writeFile("result.md", resultBody);
  await host.completeTask({
    summary: "Fallback task app completed",
    resultFile: "result.md",
  });
}
`;
}
