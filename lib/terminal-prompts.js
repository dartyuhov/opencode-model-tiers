import { createInterface } from "node:readline/promises";

function promptContext(context = {}) {
  return {
    input: context.input ?? process.stdin,
    output: context.output ?? process.stdout,
  };
}

async function ask(message, context) {
  const { input, output } = promptContext(context);
  const readline = createInterface({ input, output });
  try {
    return await readline.question(message);
  } finally {
    readline.close();
  }
}

function choiceValue(answer, choices, defaultValue) {
  const trimmed = answer.trim();
  if (!trimmed && defaultValue !== undefined) return defaultValue;

  const index = Number.parseInt(trimmed, 10) - 1;
  if (Number.isInteger(index) && index >= 0 && index < choices.length) {
    return choices[index].value;
  }

  const choice = choices.find(({ value, name }) => value === trimmed || name === trimmed);
  if (choice) return choice.value;
  throw new Error(`Invalid selection: ${trimmed}`);
}

export async function input({ message, default: defaultValue = "" }, context) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await ask(`${message}${suffix}: `, context);
  return answer || defaultValue;
}

export async function select({ message, choices, default: defaultValue }, context) {
  const { output } = promptContext(context);
  output.write(`${message}\n`);
  choices.forEach(({ name }, index) => output.write(`  ${index + 1}. ${name}\n`));
  const answer = await ask("Select an option: ", context);
  return choiceValue(answer, choices, defaultValue);
}

export async function search({ message, source, default: defaultValue }, context) {
  const choices = await source("");
  return select({ message, choices, default: defaultValue }, context);
}
